// Memory upkeep: the background half of a bot's memory, for a bot with the
// switch on (BotRecord.memoryUpkeep). The main agent keeps reading and
// writing its notes as before; this adds what happens without it choosing:
//   - capture: finished 1:1 turns are read after the chat goes quiet and new
//     facts are appended to MEMORY.md (server/memory-capture.ts);
//   - suggestions: a durable fact about the person is offered for the shared
//     About me, which only the person can accept (profile-suggestions.ts);
//   - tidy-up: nightly, and on demand, expired entries are archived, exact
//     duplicates merged and contradictions struck (server/memory-tidy.ts).
// Every write is a journal row with actor "upkeep", so the Memory panel
// shows it and Undo works. The model steps need a one-shot text call
// (`generateText`: Claude and the chat-completion engines); on any other
// engine they are skipped and only the deterministic tidy steps run.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { CaptureBuffer, capturePrompt, newCandidates, parseCandidates, type CaptureBatch, type CaptureTurn } from "./memory-capture.ts";
import { recordMemoryChange } from "./memory-journal.ts";
import { applyTidy, contradictionCandidates, contradictionPrompt, parseContradictions, planChanges, planTidy, type Contradiction } from "./memory-tidy.ts";
import { suggestProfileFacts } from "./profile-suggestions.ts";
import { ensureWorkspace, memoryDate, updateMemory, workspaceDir, writeMemoryFile, writeMemoryTopic } from "./workspace.ts";

export const CAPTURE_MAX_TURNS = 6;
export const MODEL_TIMEOUT_MS = 60_000;
export const TIDY_CHECK_MS = 10 * 60_000;
/** Below this many live entries there is nothing a contradiction pass may change. */
export const MIN_ENTRIES_FOR_CONTRADICTIONS = 5;
export const ARCHIVE_TOPIC = "archive.md";

export interface UpkeepEngine {
  generateText?: (prompt: string, options?: { signal?: AbortSignal }) => Promise<string>;
}

export interface UpkeepBot {
  id: string;
  name: string;
  memoryUpkeep?: boolean;
}

export interface UpkeepDeps {
  bots: () => readonly UpkeepBot[];
  bot: (id: string) => UpkeepBot | undefined;
  /** The bot's engine when it may receive memory text (policy allows), else null. */
  engine: (botId: string) => UpkeepEngine | null;
  /** A turn is running for the bot: the scheduled tidy waits. */
  busy: (botId: string) => boolean;
  aboutMe: () => string;
  /** `chat "Title"`, for the source of a captured entry. */
  sourceLabel: (botId: string, threadId: string) => string;
  quietMs: () => number;
  tidyHour: () => number;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface TidyReport {
  at: number;
  expired: number;
  duplicates: number;
  superseded: number;
  deferred: number;
  /** Whether the contradiction step ran (needs a text engine and five entries). */
  contradictionsChecked: boolean;
  /** Why it did not run, in the person's words. */
  note?: string;
}

export interface CaptureReport {
  at: number;
  added: number;
  suggested: number;
  note?: string;
}

interface UpkeepState {
  bots: Record<string, { lastTidy?: TidyReport; lastCapture?: CaptureReport }>;
}

function statePath(): string {
  return join(DATA_DIR, "memory-upkeep.json");
}

function loadState(): UpkeepState {
  try {
    const parsed = JSON.parse(readFileSync(statePath(), "utf8")) as UpkeepState;
    return parsed && typeof parsed.bots === "object" && parsed.bots ? parsed : { bots: {} };
  } catch {
    return { bots: {} };
  }
}

function saveState(state: UpkeepState): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    writeFileAtomic(statePath(), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // status is a convenience; losing it only means the tidy may run again
  }
}

function readRaw(botId: string, relative: string): string | null {
  try {
    return readFileSync(join(workspaceDir(botId), relative), "utf8");
  } catch {
    return null;
  }
}

async function askModel(engine: UpkeepEngine, prompt: string): Promise<string | null> {
  if (!engine.generateText) return null;
  const expiry = AbortSignal.timeout(MODEL_TIMEOUT_MS);
  try {
    const answer = await Promise.race([
      engine.generateText(prompt, { signal: expiry }),
      new Promise<never>((_, reject) => expiry.addEventListener("abort", () => reject(new Error("timed out")), { once: true })),
    ]);
    return typeof answer === "string" ? answer : null;
  } catch {
    return null;
  }
}

export const NO_TEXT_ENGINE = "This bot's engine cannot make the quick background model call upkeep uses, so only expired notes and exact duplicates are tidied.";

export interface MemoryUpkeep {
  /** A finished 1:1 turn of an upkeep bot, for capture. */
  noteTurn(botId: string, threadId: string, turn: CaptureTurn): void;
  /** Capture a thread's waiting turns now (before a compaction). */
  flushThread(threadId: string): void;
  /** Forget a bot's waiting turns (switch turned off, bot deleted). */
  dropBot(botId: string): void;
  /** Run one capture batch; resolves when written. Exposed for tests. */
  capture(batch: CaptureBatch): Promise<CaptureReport>;
  tidy(botId: string): Promise<TidyReport>;
  status(botId: string): { lastTidy?: TidyReport; lastCapture?: CaptureReport; modelSteps: boolean };
  /** One scheduler pass: tidy every due bot. Exposed for tests. */
  tick(): Promise<void>;
  start(): void;
  /** Shutdown: stop the scheduler; waiting turns are not captured. */
  stop(): void;
  /** Backup maintenance: nothing writes until resume, and batches that
   * came due meanwhile run then. */
  pause(): void;
  resume(): void;
  /** Wait for captures in flight (tests, shutdown). */
  idle(): Promise<void>;
}

export function createMemoryUpkeep(deps: UpkeepDeps): MemoryUpkeep {
  const now = () => deps.now?.() ?? new Date();
  const log = (line: string) => deps.log?.(line);
  const inflight = new Set<Promise<unknown>>();
  const tidying = new Map<string, Promise<TidyReport>>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let paused = false;
  const deferred: CaptureBatch[] = [];

  const record = (botId: string, patch: { lastTidy?: TidyReport; lastCapture?: CaptureReport }) => {
    const state = loadState();
    state.bots[botId] = { ...state.bots[botId], ...patch };
    saveState(state);
  };

  const track = <T>(promise: Promise<T>): Promise<T> => {
    inflight.add(promise);
    void promise.finally(() => inflight.delete(promise)).catch(() => undefined);
    return promise;
  };

  async function capture(batch: CaptureBatch): Promise<CaptureReport> {
    const bot = deps.bot(batch.botId);
    const at = now().getTime();
    if (!bot?.memoryUpkeep) return { at, added: 0, suggested: 0, note: "upkeep is off" };
    const engine = deps.engine(bot.id);
    if (!engine?.generateText) {
      const report = { at, added: 0, suggested: 0, note: NO_TEXT_ENGINE };
      record(bot.id, { lastCapture: report });
      return report;
    }
    ensureWorkspace(bot.id);
    const today = memoryDate(now());
    const answer = await askModel(engine, capturePrompt({ botName: bot.name, turns: batch.turns, notebook: readRaw(bot.id, "MEMORY.md") ?? "", today }));
    if (answer === null) {
      const report = { at, added: 0, suggested: 0, note: "The capture call did not answer in time." };
      record(bot.id, { lastCapture: report });
      return report;
    }
    if (paused) {
      // a backup began while the model answered: run it again after
      deferred.push(batch);
      return { at, added: 0, suggested: 0, note: "deferred until the backup finishes" };
    }
    // Re-read after the await: the bot or the person may have written since.
    // From here to the journal row there is no await, so no write interleaves.
    if (!deps.bot(bot.id)?.memoryUpkeep) return { at, added: 0, suggested: 0, note: "upkeep is off" };
    const before = readRaw(bot.id, "MEMORY.md");
    const parsed = parseCandidates(answer, today);
    const fresh = newCandidates(parsed, before ?? "");
    const source = `${deps.sourceLabel(bot.id, batch.threadId)} (noticed)`;
    let added = 0;
    let full = false;
    for (const candidate of fresh) {
      const result = updateMemory(bot.id, { action: "append", text: candidate.text, ...(candidate.until ? { until: candidate.until } : {}) }, { source, now: now() });
      if (result.ok) added += 1;
      else if (result.code === "over-budget") {
        full = true;
        break;
      }
    }
    if (added) recordMemoryChange(bot.id, { path: "MEMORY.md", actor: "upkeep", via: "capture", threadId: batch.threadId, before, after: readRaw(bot.id, "MEMORY.md") });
    // Only the owner's own words may suggest About me lines: on a shared
    // workspace another person's facts are not the owner's profile.
    const owner = batch.turns.every((turn) => turn.owner !== false);
    const suggested = owner
      // from every parsed fact, not only new ones: the bot may already have
      // noted a fact about the person in its own memory, and About me is
      // where every other bot would learn it
      ? suggestProfileFacts({ botId: bot.id, botName: bot.name }, parsed.filter((c) => c.aboutUser).map((c) => c.text), deps.aboutMe(), at).length
      : 0;
    const report: CaptureReport = { at, added, suggested, ...(full ? { note: "MEMORY.md is full; the tidy-up or a person needs to make room." } : {}) };
    record(bot.id, { lastCapture: report });
    if (added || suggested) log(`memory upkeep: captured ${added} fact(s) and ${suggested} About me suggestion(s) for ${bot.name} (${bot.id}) from ${batch.threadId}`);
    return report;
  }

  const buffer = new CaptureBuffer({
    quietMs: deps.quietMs,
    maxTurns: CAPTURE_MAX_TURNS,
    onFlush: (batch) => {
      if (paused) {
        deferred.push(batch);
        return;
      }
      void track(capture(batch)).catch((error: unknown) => log(`memory upkeep: capture failed for ${batch.botId}: ${(error as Error).message}`));
    },
  });

  async function runTidy(botId: string): Promise<TidyReport> {
    const bot = deps.bot(botId);
    const at = now().getTime();
    const today = memoryDate(now());
    ensureWorkspace(botId);
    const first = readRaw(botId, "MEMORY.md") ?? "";
    const engine = deps.engine(botId);
    const candidates = contradictionCandidates(first, today);
    let contradictions: Contradiction[] = [];
    let contradictionsChecked = false;
    let note: string | undefined;
    if (!engine?.generateText) note = NO_TEXT_ENGINE;
    else if (candidates.length < MIN_ENTRIES_FOR_CONTRADICTIONS) note = `Contradictions are checked from ${MIN_ENTRIES_FOR_CONTRADICTIONS} notes on.`;
    else {
      const answer = await askModel(engine, contradictionPrompt(candidates));
      if (answer === null) note = "The contradiction check did not answer in time.";
      else {
        contradictions = parseContradictions(answer, candidates.length);
        contradictionsChecked = true;
      }
    }
    if (paused) return { at, expired: 0, duplicates: 0, superseded: 0, deferred: 0, contradictionsChecked: false, note: "A backup was running; the tidy-up waits for the next check." };
    // Re-read after the await. If the notes changed meanwhile, the model's
    // line numbers no longer point at the same facts: keep only the
    // deterministic steps this time.
    const before = readRaw(botId, "MEMORY.md") ?? "";
    if (before !== first && contradictions.length) {
      contradictions = [];
      note = "The notes changed during the check; contradictions wait for the next tidy-up.";
    }
    const plan = planTidy(before, today, contradictions);
    if (planChanges(plan)) {
      const { text, archived } = applyTidy(before, plan, today);
      writeMemoryFile(botId, text);
      recordMemoryChange(botId, { path: "MEMORY.md", actor: "upkeep", via: "tidy", before, after: readRaw(botId, "MEMORY.md") });
      if (archived.length) {
        const archivePath = `memory/${ARCHIVE_TOPIC}`;
        const archiveBefore = readRaw(botId, archivePath);
        const head = archiveBefore ?? "---\ntitle: Archive\ndescription: expired notes moved out of MEMORY.md by the tidy-up\n---\n";
        writeMemoryTopic(botId, ARCHIVE_TOPIC, `${head}${head.endsWith("\n") ? "" : "\n"}${archived.join("\n")}\n`);
        recordMemoryChange(botId, { path: archivePath, actor: "upkeep", via: "tidy", before: archiveBefore, after: readRaw(botId, archivePath) });
      }
    }
    const report: TidyReport = {
      at,
      expired: plan.expired.length,
      duplicates: plan.duplicates.length,
      superseded: plan.superseded.length,
      deferred: plan.deferred,
      contradictionsChecked,
      ...(note ? { note } : {}),
    };
    record(botId, { lastTidy: report });
    if (planChanges(plan)) log(`memory upkeep: tidied ${bot?.name ?? botId} — ${report.expired} expired, ${report.duplicates} duplicate(s), ${report.superseded} contradicted`);
    return report;
  }

  function tidy(botId: string): Promise<TidyReport> {
    const running = tidying.get(botId);
    if (running) return running;
    const promise = track(runTidy(botId)).finally(() => tidying.delete(botId));
    tidying.set(botId, promise);
    return promise;
  }

  function due(botId: string): boolean {
    const current = now();
    if (current.getHours() < deps.tidyHour()) return false;
    const last = loadState().bots[botId]?.lastTidy?.at;
    return !last || memoryDate(new Date(last)) < memoryDate(current);
  }

  async function tick(): Promise<void> {
    if (paused) return;
    for (const bot of deps.bots()) {
      if (paused) return;
      if (!bot.memoryUpkeep || deps.busy(bot.id) || !due(bot.id)) continue;
      try {
        await tidy(bot.id);
      } catch (error) {
        log(`memory upkeep: tidy failed for ${bot.id}: ${(error as Error).message}`);
      }
    }
  }

  return {
    noteTurn(botId, threadId, turn) {
      if (!deps.bot(botId)?.memoryUpkeep) return;
      if (!turn.person.trim() && !turn.bot.trim()) return;
      buffer.add(botId, threadId, turn);
    },
    flushThread: (threadId) => buffer.flush(threadId),
    dropBot: (botId) => buffer.dropBot(botId),
    capture: (batch) => track(capture(batch)),
    tidy,
    status(botId) {
      const saved = loadState().bots[botId] ?? {};
      return { ...saved, modelSteps: Boolean(deps.engine(botId)?.generateText) };
    },
    tick,
    start() {
      if (timer) return;
      timer = setInterval(() => void tick(), TIDY_CHECK_MS);
      timer.unref?.();
      // a first pass shortly after start catches a night the computer slept through
      const first = setTimeout(() => void tick(), 60_000);
      first.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
      for (const batch of deferred.splice(0)) {
        void track(capture(batch)).catch((error: unknown) => log(`memory upkeep: capture failed for ${batch.botId}: ${(error as Error).message}`));
      }
    },
    async idle() {
      while (inflight.size) await Promise.allSettled(inflight);
    },
  };
}
