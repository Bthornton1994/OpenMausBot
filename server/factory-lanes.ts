// Factory lanes — durable work-item records for a manager loop.
//
// A lane is one unit of factory work: an owner bot writing on one branch in
// one worktree, moving through ready → running → ci_wait/qa_wait → done. The
// store answers the manager-loop question "while lane A waits on CI or QA,
// which other lane can safely start?" without ever putting a second writer on
// A's frozen branch, worktree, or files.
//
// This is a pure module: no HTTP route or MCP tool calls it yet (see
// docs/factory-lanes.md). It persists to DATA_DIR/factory-lanes.json with the
// same atomic-write / corrupt-file-means-empty rules as delegations.ts, except
// that a corrupt file is copied aside before the next save replaces it.
//
// Ownership is fail-closed: paths and branch names compare case-insensitively
// and nested worktree paths overlap, so a doubtful pair counts as a conflict.
// Writer claims also pass the protect gate (factory-protect-gate.ts): QA work
// is never claimed as implementation, and when a CoS protect directory is
// configured, protected sessions and frozen tips are refused, fail-closed.

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { posix, join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { newId } from "./contracts.ts";
import {
  evaluateProtectGate,
  loadProtectSoT,
  resolveProtectDir,
  type ProtectDecision,
  type ProtectGateVia,
  type ProtectLoadResult,
} from "./factory-protect-gate.ts";

export const FACTORY_LANE_PHASES = [
  "ready",
  "running",
  "ci_wait",
  "qa_wait",
  "owner_gate",
  "done",
  "failed",
  "cancelled",
] as const;
export type FactoryLanePhase = (typeof FACTORY_LANE_PHASES)[number];

export const TERMINAL_PHASES: readonly FactoryLanePhase[] = ["done", "failed", "cancelled"];
/** Phases whose tip is frozen or being written: their ownership blocks every
 * other writer, claimed or not. owner_gate is included on purpose — a tip
 * waiting on its owner's decision must not move underneath them. */
export const FROZEN_PHASES: readonly FactoryLanePhase[] = ["running", "ci_wait", "qa_wait", "owner_gate"];

export const QA_DISPOSITIONS = ["PASS", "FAIL", "BLOCKED", "NOT RUN", "UNKNOWN"] as const;
export type QaDisposition = (typeof QA_DISPOSITIONS)[number];

export interface FactoryLaneEvidence {
  at: number;
  /** e.g. "commit", "ci", "qa", "claim", "pr", "note" — free-form, short */
  kind: string;
  /** SHA, URL, run id, file path — whatever the evidence points at */
  ref: string;
  note?: string;
}

export interface FactoryLane {
  id: string;
  title: string;
  /** The single writer for this lane. */
  ownerBotId: string;
  /** Independent QA. Never equal to ownerBotId. */
  reviewerBotId?: string;
  /** "qa" marks review work: the implementer claim APIs refuse it. Absent
   * means implementer. Set at creation only. */
  role?: FactoryLaneRole;
  repo: string;
  branch: string;
  worktreePath: string;
  /** Extra repo-relative paths this lane writes, beyond its own branch. */
  pathClaims?: string[];
  /** Full 40-hex commit SHA of the current tip. */
  fullSha?: string;
  /** Agent/Claude session id or URL doing the writing. */
  agentSession?: string;
  phase: FactoryLanePhase;
  evidence: FactoryLaneEvidence[];
  blocker?: string;
  nextAction?: string;
  prUrl?: string;
  changedFiles?: string[];
  qaDisposition?: QaDisposition;
  outcome?: string;
  /** Derived from repo + branch + normalized worktreePath. */
  ownershipKey: string;
  /** Set while this lane holds an explicit worktree claim (epoch ms). */
  claimedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export const FACTORY_LANE_ROLES = ["implementer", "qa"] as const;
export type FactoryLaneRole = (typeof FACTORY_LANE_ROLES)[number];

/** `ineligible` = the protect gate said DENY (QA work, frozen tip, protected
 * session, or an unavailable protect SoT). `conflict` stays for overlap with
 * another lane's ownership in this store. */
export type FactoryLaneErrorCode = "not_found" | "invalid" | "terminal" | "conflict" | "qa_independence" | "ineligible";

export class FactoryLaneError extends Error {
  readonly code: FactoryLaneErrorCode;
  constructor(code: FactoryLaneErrorCode, message: string) {
    super(message);
    this.name = "FactoryLaneError";
    this.code = code;
  }
}

const FILE_VERSION = 1;
const MAX_EVIDENCE = 200;
const MAX_TEXT = 4_000;
const FULL_SHA = /^[0-9a-f]{40}$/i;

const lanesFile = (): string => join(DATA_DIR, "factory-lanes.json");

let lanes: FactoryLane[] | null = null;

// ── normalization / ownership ─────────────────────────────────────────

/** Case-folded, forward-slash, no trailing slash. Case-folding is deliberate
 * even on case-sensitive filesystems: two lanes whose paths differ only by
 * case are treated as the same worktree (fail-closed). */
export function normalizeLanePath(path: string): string {
  const slashed = path.trim().replace(/\\/g, "/");
  const normalized = posix.normalize(slashed).replace(/\/+$/, "");
  return (normalized || "/").toLowerCase();
}

const norm = (value: string): string => value.trim().toLowerCase();

export function laneOwnershipKey(lane: { repo: string; branch: string; worktreePath: string }): string {
  return `${norm(lane.repo)}#${norm(lane.branch)}#${normalizeLanePath(lane.worktreePath)}`;
}

/** Equal, or one contains the other. */
function pathsNest(a: string, b: string): boolean {
  if (a === b) return true;
  const [shorter, longer] = a.length < b.length ? [a, b] : [b, a];
  return longer.startsWith(shorter.endsWith("/") ? shorter : `${shorter}/`);
}

export interface LaneOwnership {
  repo: string;
  branch: string;
  worktreePath: string;
  pathClaims?: readonly string[];
}

/** Why two ownerships collide, or null when they are disjoint. Same repo and
 * branch, nested worktree paths, or overlapping path claims in one repo. */
export function ownershipOverlap(a: LaneOwnership, b: LaneOwnership): string | null {
  const sameRepo = norm(a.repo) === norm(b.repo);
  if (sameRepo && norm(a.branch) === norm(b.branch)) return `same branch ${b.branch}`;
  if (pathsNest(normalizeLanePath(a.worktreePath), normalizeLanePath(b.worktreePath))) {
    return `same worktree ${b.worktreePath}`;
  }
  if (sameRepo) {
    for (const left of a.pathClaims ?? []) {
      for (const right of b.pathClaims ?? []) {
        if (pathsNest(normalizeLanePath(left), normalizeLanePath(right))) return `overlapping path ${right}`;
      }
    }
  }
  return null;
}

/** Lanes whose ownership currently blocks other writers: every non-terminal
 * lane that holds a claim or sits in a frozen phase. */
function holdsOwnership(lane: FactoryLane): boolean {
  if (TERMINAL_PHASES.includes(lane.phase)) return false;
  return lane.claimedAt !== undefined || FROZEN_PHASES.includes(lane.phase);
}

function findConflict(all: readonly FactoryLane[], laneId: string, wanted: LaneOwnership): { lane: FactoryLane; why: string } | null {
  for (const other of all) {
    if (other.id === laneId || !holdsOwnership(other)) continue;
    const why = ownershipOverlap(wanted, other);
    if (why) return { lane: other, why };
  }
  return null;
}

// ── persistence ───────────────────────────────────────────────────────

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.slice(0, MAX_TEXT) : undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
  return list.length ? list : undefined;
}

function isPhase(value: unknown): value is FactoryLanePhase {
  return typeof value === "string" && (FACTORY_LANE_PHASES as readonly string[]).includes(value);
}

function isQaDisposition(value: unknown): value is QaDisposition {
  return typeof value === "string" && (QA_DISPOSITIONS as readonly string[]).includes(value);
}

/** Rebuild one lane from untrusted JSON, or null if it is not a lane. */
function parseLane(value: unknown): FactoryLane | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  // SAFETY: the Partial view only names candidate fields; each is narrowed
  // below before it reaches the returned lane.
  const raw = value as Partial<Record<keyof FactoryLane, unknown>>;
  const id = text(raw.id);
  const title = text(raw.title);
  const ownerBotId = text(raw.ownerBotId);
  const repo = text(raw.repo);
  const branch = text(raw.branch);
  const worktreePath = text(raw.worktreePath);
  if (!id || !title || !ownerBotId || !repo || !branch || !worktreePath || !isPhase(raw.phase)) return null;
  if (!Number.isFinite(raw.createdAt) || !Number.isFinite(raw.updatedAt)) return null;
  const evidence = Array.isArray(raw.evidence)
    ? raw.evidence.flatMap((item): FactoryLaneEvidence[] => {
        if (!item || typeof item !== "object") return [];
        const entry = item as Partial<Record<keyof FactoryLaneEvidence, unknown>>;
        const kind = text(entry.kind);
        const ref = text(entry.ref);
        if (!kind || !ref || !Number.isFinite(entry.at)) return [];
        const note = text(entry.note);
        return [{ at: entry.at as number, kind, ref, ...(note ? { note } : {}) }];
      })
    : [];
  const lane: FactoryLane = {
    id,
    title,
    ownerBotId,
    repo,
    branch,
    worktreePath,
    phase: raw.phase,
    evidence,
    ownershipKey: laneOwnershipKey({ repo, branch, worktreePath }),
    createdAt: raw.createdAt as number,
    updatedAt: raw.updatedAt as number,
  };
  const reviewerBotId = text(raw.reviewerBotId);
  // A stored lane whose reviewer is its own owner is not independent QA; keep
  // the lane, drop the reviewer, so a person has to assign a real one.
  if (reviewerBotId && reviewerBotId !== ownerBotId) lane.reviewerBotId = reviewerBotId;
  if (raw.role === "qa") lane.role = "qa";
  const pathClaims = stringList(raw.pathClaims);
  if (pathClaims) lane.pathClaims = pathClaims;
  const fullSha = text(raw.fullSha);
  if (fullSha && FULL_SHA.test(fullSha)) lane.fullSha = fullSha.toLowerCase();
  for (const key of ["agentSession", "blocker", "nextAction", "prUrl", "outcome"] as const) {
    const value = text(raw[key]);
    if (value) lane[key] = value;
  }
  const changedFiles = stringList(raw.changedFiles);
  if (changedFiles) lane.changedFiles = changedFiles;
  if (isQaDisposition(raw.qaDisposition)) lane.qaDisposition = raw.qaDisposition;
  if (Number.isFinite(raw.claimedAt) && !TERMINAL_PHASES.includes(lane.phase)) lane.claimedAt = raw.claimedAt as number;
  return lane;
}

/** Load (or reload) from disk. Missing or corrupt → empty; a corrupt file is
 * copied to factory-lanes.json.corrupt-<ms> first so the next save cannot
 * destroy the only copy of someone's evidence. */
export function _loadFactoryLanes(): void {
  const file = lanesFile();
  lanes = [];
  if (!existsSync(file)) return;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { lanes?: unknown };
    if (!Array.isArray(raw?.lanes)) throw new Error("no lanes array");
    const seen = new Set<string>();
    for (const value of raw.lanes) {
      const lane = parseLane(value);
      if (!lane || seen.has(lane.id)) continue;
      seen.add(lane.id);
      lanes.push(lane);
    }
  } catch (error) {
    console.error("factory-lanes: ignoring unreadable", file, error);
    try {
      copyFileSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {
      /* best-effort backup */
    }
  }
}

function all(): FactoryLane[] {
  if (!lanes) _loadFactoryLanes();
  return lanes!;
}

/** Apply a change to a copy, persist it, and only then make it current. A
 * failed write leaves both the file and memory at the previous state, so a
 * claim is never "held" in memory but missing on disk. */
function commit<T>(change: (draft: FactoryLane[]) => T): T {
  const draft = structuredClone(all());
  const result = change(draft);
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileAtomic(lanesFile(), JSON.stringify({ version: FILE_VERSION, lanes: draft }, null, 2), { mode: 0o600 });
  lanes = draft;
  return result;
}

function mustFind(draft: FactoryLane[], id: string): FactoryLane {
  const lane = draft.find((candidate) => candidate.id === id);
  if (!lane) throw new FactoryLaneError("not_found", `no factory lane ${id}`);
  return lane;
}

function assertNotTerminal(lane: FactoryLane): void {
  if (TERMINAL_PHASES.includes(lane.phase)) {
    throw new FactoryLaneError("terminal", `lane ${lane.id} is ${lane.phase}; terminal lanes do not change`);
  }
}

function assertIndependentReviewer(ownerBotId: string, reviewerBotId: string | undefined): void {
  if (reviewerBotId !== undefined && reviewerBotId === ownerBotId) {
    throw new FactoryLaneError("qa_independence", "reviewerBotId must differ from ownerBotId (independent QA)");
  }
}

function pushEvidence(lane: FactoryLane, evidence: Omit<FactoryLaneEvidence, "at"> & { at?: number }, now: number): void {
  const kind = text(evidence.kind);
  const ref = text(evidence.ref);
  if (!kind || !ref) throw new FactoryLaneError("invalid", "evidence needs a kind and a ref");
  const note = text(evidence.note);
  lane.evidence.push({ at: evidence.at ?? now, kind, ref, ...(note ? { note } : {}) });
  if (lane.evidence.length > MAX_EVIDENCE) lane.evidence.splice(0, lane.evidence.length - MAX_EVIDENCE);
}

// ── protect gate ──────────────────────────────────────────────────────

export interface ProtectGateOptions {
  /** CoS protect directory holding PROTECTED_SESSIONS.json + FROZEN_TIPS.json.
   * Falls back to env COS_FACTORY_PROTECT_DIR, then COS_FACTORY_ROOT/protect;
   * none set → QA-role rules only (ownership-only dispatch). */
  protectDir?: string;
}

/** Gate one lane's writer claim on the ownership it would hold. */
function gateLane(lane: FactoryLane, wanted: LaneOwnership, via: ProtectGateVia, protectDir?: string, sot?: ProtectLoadResult): ProtectDecision | null {
  return evaluateProtectGate(
    {
      laneId: lane.id,
      ...(lane.role ? { role: lane.role } : {}),
      phase: lane.phase,
      repo: wanted.repo,
      branch: wanted.branch,
      worktreePath: wanted.worktreePath,
      ...(lane.agentSession ? { writerTarget: lane.agentSession } : {}),
      ...(lane.fullSha ? { fullSha: lane.fullSha } : {}),
    },
    { via, ...(protectDir !== undefined ? { protectDir } : {}), ...(sot ? { sot } : {}) },
  );
}

const gateNote = (decision: ProtectDecision): string => `${decision.decision} ${decision.rule}: ${decision.reason}`;

/** Protect evidence, skipped when it repeats the lane's last entry so a
 * manager loop re-asking every tick does not flood the audit trail. */
function pushGateEvidence(lane: FactoryLane, decision: ProtectDecision, now: number): void {
  const ref = decision.dir ?? "qa-rules";
  const note = gateNote(decision);
  const last = lane.evidence.at(-1);
  if (last?.kind === "protect" && last.ref === ref && last.note === note) return;
  pushEvidence(lane, { kind: "protect", ref, note }, now);
}

/** Persist the denial on the lane, then refuse. The denial is its own commit
 * because the refused change itself is never written. */
function refuse(laneId: string, decision: ProtectDecision): never {
  commit((draft) => {
    const lane = draft.find((candidate) => candidate.id === laneId);
    if (!lane) return;
    const now = Date.now();
    pushGateEvidence(lane, decision, now);
    lane.updatedAt = now;
  });
  throw new FactoryLaneError("ineligible", `lane ${laneId} refused by protect gate — ${decision.reason}`);
}

// ── public API ────────────────────────────────────────────────────────

/** Fields a caller may set through upsert or a transition patch. Phase,
 * evidence, claims and timestamps each have their own entry point. */
export interface FactoryLanePatch {
  title?: string;
  reviewerBotId?: string;
  fullSha?: string;
  agentSession?: string;
  blocker?: string | null;
  nextAction?: string | null;
  prUrl?: string;
  changedFiles?: string[];
  outcome?: string;
}

export interface FactoryLaneInput extends FactoryLanePatch {
  id?: string;
  title: string;
  ownerBotId: string;
  repo: string;
  branch: string;
  worktreePath: string;
  pathClaims?: string[];
  /** "qa" for review work the implementer claim APIs must never take.
   * Ignored on update: a lane does not change sides. */
  role?: FactoryLaneRole;
  /** Initial phase for a new lane; only ready/owner_gate/qa_wait/ci_wait are
   * accepted — `running` goes through claimWorktree/claimNextEligible so it
   * always carries an ownership check. Ignored on update. */
  phase?: FactoryLanePhase;
}

function applyPatch(lane: FactoryLane, patch: FactoryLanePatch): void {
  if (patch.title !== undefined) {
    const title = text(patch.title);
    if (!title) throw new FactoryLaneError("invalid", "title must not be empty");
    lane.title = title;
  }
  if (patch.reviewerBotId !== undefined) {
    assertIndependentReviewer(lane.ownerBotId, patch.reviewerBotId);
    lane.reviewerBotId = patch.reviewerBotId;
  }
  if (patch.fullSha !== undefined) {
    if (!FULL_SHA.test(patch.fullSha)) throw new FactoryLaneError("invalid", "fullSha must be a full 40-character hex SHA");
    lane.fullSha = patch.fullSha.toLowerCase();
  }
  // An empty string (or null) clears the field.
  for (const key of ["agentSession", "prUrl", "outcome", "blocker", "nextAction"] as const) {
    if (patch[key] === undefined) continue;
    const value = text(patch[key]);
    if (value) lane[key] = value;
    else delete lane[key];
  }
  if (patch.changedFiles !== undefined) lane.changedFiles = stringList(patch.changedFiles) ?? [];
}

/** Create a lane, or update an existing one's descriptive fields. Changing a
 * lane's repo/branch/worktree/pathClaims while it holds ownership is refused:
 * release first, then re-claim. */
export function upsertLane(input: FactoryLaneInput): FactoryLane {
  assertIndependentReviewer(input.ownerBotId, input.reviewerBotId);
  for (const key of ["title", "ownerBotId", "repo", "branch", "worktreePath"] as const) {
    if (!text(input[key])) throw new FactoryLaneError("invalid", `${key} is required`);
  }
  return commit((draft) => {
    const now = Date.now();
    const existing = input.id ? draft.find((lane) => lane.id === input.id) : undefined;
    if (existing) {
      assertNotTerminal(existing);
      if (existing.ownerBotId !== input.ownerBotId) {
        throw new FactoryLaneError("invalid", `lane ${existing.id} is owned by ${existing.ownerBotId}; ownership is not reassigned by upsert`);
      }
      // Omitted pathClaims means "unchanged", not "drop them".
      const moved =
        laneOwnershipKey(input) !== existing.ownershipKey ||
        (input.pathClaims !== undefined && JSON.stringify(input.pathClaims) !== JSON.stringify(existing.pathClaims ?? []));
      if (moved) {
        if (holdsOwnership(existing)) {
          throw new FactoryLaneError("conflict", `lane ${existing.id} holds ownership; release it before moving its worktree`);
        }
        existing.repo = input.repo.trim();
        existing.branch = input.branch.trim();
        existing.worktreePath = input.worktreePath.trim();
        existing.ownershipKey = laneOwnershipKey(existing);
        if (input.pathClaims?.length) existing.pathClaims = [...input.pathClaims];
        else if (input.pathClaims !== undefined) delete existing.pathClaims;
      }
      applyPatch(existing, input);
      existing.updatedAt = now;
      return structuredClone(existing);
    }
    const phase = input.phase ?? "ready";
    if (phase === "running" || TERMINAL_PHASES.includes(phase)) {
      throw new FactoryLaneError("invalid", `a new lane cannot start ${phase}; claim it instead`);
    }
    if (input.role !== undefined && !(FACTORY_LANE_ROLES as readonly string[]).includes(input.role)) {
      throw new FactoryLaneError("invalid", `unknown lane role ${String(input.role)}`);
    }
    const lane: FactoryLane = {
      id: input.id ?? newId(),
      title: input.title.trim(),
      ownerBotId: input.ownerBotId,
      repo: input.repo.trim(),
      branch: input.branch.trim(),
      worktreePath: input.worktreePath.trim(),
      phase,
      evidence: [],
      ownershipKey: laneOwnershipKey(input),
      createdAt: now,
      updatedAt: now,
    };
    if (input.pathClaims?.length) lane.pathClaims = [...input.pathClaims];
    if (input.role === "qa") lane.role = "qa";
    applyPatch(lane, input);
    // A lane created straight into a frozen phase blocks writers at once, so
    // it must not land on top of someone else's ownership either.
    if (FROZEN_PHASES.includes(phase)) {
      const conflict = findConflict(draft, lane.id, lane);
      if (conflict) throw new FactoryLaneError("conflict", `lane ${conflict.lane.id} already holds ${conflict.why}`);
    }
    draft.push(lane);
    return structuredClone(lane);
  });
}

export function getLane(id: string): FactoryLane | null {
  const lane = all().find((candidate) => candidate.id === id);
  return lane ? structuredClone(lane) : null;
}

export interface FactoryLaneFilter {
  phase?: FactoryLanePhase | readonly FactoryLanePhase[];
  ownerBotId?: string;
  repo?: string;
  includeTerminal?: boolean;
}

export function listLanes(filter: FactoryLaneFilter = {}): FactoryLane[] {
  const phases = filter.phase === undefined ? undefined : ([] as FactoryLanePhase[]).concat(filter.phase);
  return all()
    .filter((lane) => {
      if (phases && !phases.includes(lane.phase)) return false;
      if (!phases && filter.includeTerminal === false && TERMINAL_PHASES.includes(lane.phase)) return false;
      if (filter.ownerBotId !== undefined && lane.ownerBotId !== filter.ownerBotId) return false;
      if (filter.repo !== undefined && norm(lane.repo) !== norm(filter.repo)) return false;
      return true;
    })
    .map((lane) => structuredClone(lane));
}

/** Move a lane to a new phase. Terminal lanes never move again. Entering
 * `running` requires ownership that does not overlap another holder and a
 * protect-gate ALLOW (`ineligible` otherwise); entering a terminal phase
 * releases the lane's claim. */
export function transition(
  id: string,
  phase: FactoryLanePhase,
  patch: FactoryLanePatch = {},
  options: ProtectGateOptions = {},
): FactoryLane {
  if (!isPhase(phase)) throw new FactoryLaneError("invalid", `unknown phase ${String(phase)}`);
  const current = all().find((lane) => lane.id === id);
  let allowed: ProtectDecision | null = null;
  // F2/t1743u: gate entry into ANY frozen phase (running/ci_wait/qa_wait/owner_gate),
  // not only running — otherwise ready→ci_wait can take ownership + fullSha past protect.
  if (FROZEN_PHASES.includes(phase) && current && current.phase !== phase && !TERMINAL_PHASES.includes(current.phase)) {
    // Gate what the lane will be after the patch, so a patch cannot slip a
    // protected writer session or a frozen SHA past the check.
    const after: FactoryLane = {
      ...current,
      ...(patch.agentSession ? { agentSession: patch.agentSession } : {}),
      ...(patch.fullSha ? { fullSha: patch.fullSha.toLowerCase() } : {}),
    };
    const decision = gateLane(after, after, "transition", options.protectDir);
    if (decision?.decision === "DENY") refuse(current.id, decision);
    allowed = decision;
  }
  return commit((draft) => {
    const lane = mustFind(draft, id);
    assertNotTerminal(lane);
    const now = Date.now();
    if (FROZEN_PHASES.includes(phase) && !holdsOwnership(lane)) {
      const conflict = findConflict(draft, lane.id, lane);
      if (conflict) throw new FactoryLaneError("conflict", `lane ${conflict.lane.id} already holds ${conflict.why}`);
      lane.claimedAt = now;
    }
    applyPatch(lane, patch);
    if (allowed) pushGateEvidence(lane, allowed, now);
    const from = lane.phase;
    lane.phase = phase;
    if (TERMINAL_PHASES.includes(phase)) delete lane.claimedAt;
    if (from !== phase) pushEvidence(lane, { kind: "phase", ref: `${from}->${phase}` }, now);
    lane.updatedAt = now;
    return structuredClone(lane);
  });
}

export function appendEvidence(id: string, evidence: Omit<FactoryLaneEvidence, "at"> & { at?: number }): FactoryLane {
  return commit((draft) => {
    const lane = mustFind(draft, id);
    const now = Date.now();
    // Terminal lanes still accept evidence: a late CI result or QA DIGEST
    // belongs in the audit trail even after the outcome is recorded.
    pushEvidence(lane, evidence, now);
    lane.updatedAt = now;
    return structuredClone(lane);
  });
}

export interface ClaimWorktreeInput extends LaneOwnership, ProtectGateOptions {
  ownerBotId: string;
  laneId: string;
}

/** Exclusive claim on repo+branch+worktree (+pathClaims) for one lane's
 * owner. Throws `conflict` when any other holder overlaps, `ineligible` when
 * the protect gate denies the requested ownership (QA work, frozen tip,
 * protected session, unavailable SoT). Re-claiming the same ownership for the
 * same lane is idempotent. */
export function claimWorktree(input: ClaimWorktreeInput): FactoryLane {
  const current = all().find((lane) => lane.id === input.laneId);
  let allowed: ProtectDecision | null = null;
  if (current && !TERMINAL_PHASES.includes(current.phase) && current.ownerBotId === input.ownerBotId) {
    const decision = gateLane(current, input, "claim", input.protectDir);
    if (decision?.decision === "DENY") refuse(current.id, decision);
    allowed = decision;
  }
  return commit((draft) => {
    const lane = mustFind(draft, input.laneId);
    assertNotTerminal(lane);
    if (lane.ownerBotId !== input.ownerBotId) {
      throw new FactoryLaneError("conflict", `lane ${lane.id} is owned by ${lane.ownerBotId}, not ${input.ownerBotId}`);
    }
    const conflict = findConflict(draft, lane.id, input);
    if (conflict) throw new FactoryLaneError("conflict", `lane ${conflict.lane.id} already holds ${conflict.why}`);
    const now = Date.now();
    if (allowed && lane.claimedAt === undefined) pushGateEvidence(lane, allowed, now);
    lane.repo = input.repo.trim();
    lane.branch = input.branch.trim();
    lane.worktreePath = input.worktreePath.trim();
    lane.ownershipKey = laneOwnershipKey(lane);
    if (input.pathClaims?.length) lane.pathClaims = [...input.pathClaims];
    else delete lane.pathClaims;
    if (lane.claimedAt === undefined) {
      lane.claimedAt = now;
      pushEvidence(lane, { kind: "claim", ref: lane.ownershipKey }, now);
    }
    lane.updatedAt = now;
    return structuredClone(lane);
  });
}

/** Drop a lane's explicit claim. A lane still in a frozen phase keeps
 * blocking by phase alone — releasing never unfreezes a tip under review. */
export function releaseOwnership(laneId: string): FactoryLane {
  return commit((draft) => {
    const lane = mustFind(draft, laneId);
    if (lane.claimedAt === undefined) return structuredClone(lane);
    const now = Date.now();
    delete lane.claimedAt;
    pushEvidence(lane, { kind: "release", ref: lane.ownershipKey }, now);
    lane.updatedAt = now;
    return structuredClone(lane);
  });
}

/** Independent QA verdict. Only the lane's assigned reviewer — never its
 * owner — can record one. */
export function recordQaDisposition(
  id: string,
  input: { reviewerBotId: string; disposition: QaDisposition; ref: string; note?: string },
): FactoryLane {
  if (!isQaDisposition(input.disposition)) throw new FactoryLaneError("invalid", `unknown QA disposition ${String(input.disposition)}`);
  return commit((draft) => {
    const lane = mustFind(draft, id);
    assertIndependentReviewer(lane.ownerBotId, input.reviewerBotId);
    if (lane.reviewerBotId !== input.reviewerBotId) {
      throw new FactoryLaneError("qa_independence", `lane ${lane.id} is reviewed by ${lane.reviewerBotId ?? "nobody yet"}, not ${input.reviewerBotId}`);
    }
    const now = Date.now();
    lane.qaDisposition = input.disposition;
    pushEvidence(lane, { kind: "qa", ref: input.ref, note: `${input.disposition}${input.note ? ` — ${input.note}` : ""}` }, now);
    lane.updatedAt = now;
    return structuredClone(lane);
  });
}

export interface ClaimNextEligibleOptions extends ProtectGateOptions {
  /** Phases that count as "someone is waiting" (default ci_wait, qa_wait). */
  waitingPhases?: readonly FactoryLanePhase[];
  /** Try this owner's ready lanes first. */
  preferOwnerBotId?: string;
  /** Dispatch even when nothing is waiting (tests, manual kicks). */
  forceParallel?: boolean;
}

/** The manager-loop step: while at least one lane waits on CI/QA, start the
 * oldest ready lane whose ownership overlaps no frozen or claimed lane and
 * which the protect gate allows. The chosen lane moves to `running` with a
 * claim and a claim evidence entry. Ready lanes with a blocker are skipped;
 * gate-denied lanes are skipped with `protect` evidence. Returns null if
 * nothing is waiting (and not forced) or no ready lane is safe to start.
 * Throws `ineligible` when a protect directory is configured but its SoT
 * cannot be loaded — nothing is dispatched blind. */
export function claimNextEligible(options: ClaimNextEligibleOptions = {}): FactoryLane | null {
  const waitingPhases: readonly FactoryLanePhase[] = options.waitingPhases ?? ["ci_wait", "qa_wait"];
  const waiting = all().filter((lane) => waitingPhases.includes(lane.phase));
  if (!waiting.length && !options.forceParallel) return null;
  // Load the SoT once per step, and before choosing anything: a missing or
  // broken protect list stops the whole step rather than any one lane.
  const protectDir = resolveProtectDir(options.protectDir);
  const sot = protectDir ? loadProtectSoT(protectDir) : undefined;
  if (sot && !sot.ok) {
    throw new FactoryLaneError("ineligible", `protect SoT unavailable, failing closed: ${sot.reason}`);
  }
  const candidates = all()
    .map((lane, index) => ({ lane, index }))
    .filter(({ lane }) => lane.phase === "ready" && !lane.blocker)
    .sort((a, b) => {
      const preferA = a.lane.ownerBotId === options.preferOwnerBotId ? 0 : 1;
      const preferB = b.lane.ownerBotId === options.preferOwnerBotId ? 0 : 1;
      return preferA - preferB || a.lane.createdAt - b.lane.createdAt || a.index - b.index;
    });
  const denied: { laneId: string; decision: ProtectDecision }[] = [];
  let chosen: { lane: FactoryLane; allowed: ProtectDecision | null } | undefined;
  for (const { lane } of candidates) {
    if (findConflict(all(), lane.id, lane)) continue;
    const decision = gateLane(lane, lane, "claim", protectDir ?? undefined, sot);
    if (decision?.decision === "DENY") {
      denied.push({ laneId: lane.id, decision });
      continue;
    }
    chosen = { lane, allowed: decision };
    break;
  }
  const picked = chosen;
  if (!picked && !denied.length) return null;
  return commit((draft) => {
    const now = Date.now();
    for (const { laneId, decision } of denied) {
      const lane = mustFind(draft, laneId);
      pushGateEvidence(lane, decision, now);
      lane.updatedAt = now;
    }
    if (!picked) return null;
    const lane = mustFind(draft, picked.lane.id);
    // Never start a lane twice: only a ready lane is ever dispatched.
    if (lane.phase !== "ready") throw new FactoryLaneError("conflict", `lane ${lane.id} is already ${lane.phase}`);
    lane.claimedAt = lane.claimedAt ?? now;
    lane.phase = "running";
    const dispatched = waiting.length
      ? `dispatched while ${waiting.map((other) => `${other.id}:${other.phase}`).join(", ")} wait`
      : "forced parallel dispatch";
    pushEvidence(
      lane,
      {
        kind: "claim",
        ref: lane.ownershipKey,
        note: picked.allowed ? `${dispatched}; protect ${gateNote(picked.allowed)}` : dispatched,
      },
      now,
    );
    pushEvidence(lane, { kind: "phase", ref: "ready->running" }, now);
    lane.updatedAt = now;
    return structuredClone(lane);
  });
}

export interface FactoryLaneReport {
  id: string;
  title: string;
  phase: FactoryLanePhase;
  finished: boolean;
  ownerBotId: string;
  reviewerBotId?: string;
  repo: string;
  branch: string;
  fullSha?: string;
  prUrl?: string;
  qaDisposition?: QaDisposition;
  outcome?: string;
  blocker?: string;
  nextAction?: string;
  changedFiles: string[];
  evidenceCount: number;
  lastEvidence?: FactoryLaneEvidence;
}

export function laneReport(lane: FactoryLane): FactoryLaneReport {
  const report: FactoryLaneReport = {
    id: lane.id,
    title: lane.title,
    phase: lane.phase,
    finished: TERMINAL_PHASES.includes(lane.phase),
    ownerBotId: lane.ownerBotId,
    repo: lane.repo,
    branch: lane.branch,
    changedFiles: lane.changedFiles ?? [],
    evidenceCount: lane.evidence.length,
  };
  for (const key of ["reviewerBotId", "fullSha", "prUrl", "qaDisposition", "outcome", "blocker", "nextAction"] as const) {
    if (lane[key] !== undefined) (report as unknown as Record<string, unknown>)[key] = lane[key];
  }
  const last = lane.evidence.at(-1);
  if (last) report.lastEvidence = last;
  return report;
}

/** Poll until the lane reaches done/failed/cancelled or the timeout passes.
 * Resolves with the report either way — check `finished`. Reloads from disk
 * each poll when `reload` is set, for a caller in another process. */
export async function waitLane(
  id: string,
  options: { timeoutMs?: number; pollMs?: number; reload?: boolean } = {},
): Promise<FactoryLaneReport> {
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  const pollMs = Math.max(10, options.pollMs ?? 1_000);
  for (;;) {
    if (options.reload) _loadFactoryLanes();
    const lane = getLane(id);
    if (!lane) throw new FactoryLaneError("not_found", `no factory lane ${id}`);
    const report = laneReport(lane);
    if (report.finished || Date.now() >= deadline) return report;
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
  }
}

/** Test helper: forget the in-memory cache (next call reloads from disk). */
export function _resetFactoryLanes(): void {
  lanes = null;
}
