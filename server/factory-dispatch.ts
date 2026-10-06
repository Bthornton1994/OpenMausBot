// Software-factory tasks. This file is the store (DATA_DIR/factory-tasks.json).
// OMB handles task intake and implementation dispatch only. QA and independent
// review are performed outside OMB: this module does not launch QA, assign a
// QA or reviewer seat, or record a QA disposition. Every QA entry point that is
// kept for compatibility rejects with QA_OUTSIDE_OMB and starts nothing.
// A task is not running until its worktree and Claude session id are both on
// disk. A second launch returns that binding or fails closed. A seat this
// process cannot fence is marked unavailable and is not dispatched.

import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, posix } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { newId } from "./contracts.ts";
import { REQUIRED_TESTS_PATH, runRequiredTestsPinned } from "./factory-checks.ts";
import { NO_WRITER_SANDBOX_REASON, detectFactorySandbox } from "./factory-sandbox.ts";
import {
  FACTORY_ENGINE_MODEL,
  FACTORY_SPECIALISTS,
  REVIEWER_DISALLOWED_TOOLS,
  factoryRole,
  isFactorySpecialistId,
  isReadOnlyFactoryRole,
  type FactoryRole,
  type FactorySpecialistId,
  type QaEvidenceDisposition,
} from "./factory-boundary.ts";

export const IMPLEMENTER_ID = "063c67ac-f8ca-4c05-b6b8-e3bbf2e102a7" as const;

/** The one reason every QA entry point gives. It never starts a process. */
export const QA_OUTSIDE_OMB = "QA is performed outside OMB. OMB handles task intake and implementation dispatch only: it does not launch QA, assign a QA or review specialist, or record a QA disposition.";

/** Intake fields that only a QA, review, or release flow used. Sending one is rejected, not ignored. */
const QA_INTAKE_FIELDS = ["qaOfTaskId", "headSha", "prUrl", "qaDisposition", "reviewedSha", "reviewerId", "testerId", "releaseId", "remediationLimit"] as const;

/** "implemented" is the end of OMB's part. "review", "test", "release", "release_ready", "ship", and "shipped" are legacy stored values only. */
export const PIPELINE_PHASES = ["implement", "remediate", "implemented", "review", "test", "release", "release_ready", "ship", "shipped", "blocked"] as const;
export type PipelinePhase = (typeof PIPELINE_PHASES)[number];

export interface FactoryCheck {
  name: string;
  result: string;
  sha: string;
}

export interface FactoryRevision {
  id: string;
  kind: "implementation" | "candidate" | "review" | "test" | "release" | "rejection";
  sessionId: string;
  specialistId: string;
  generation: number;
  /** The SHA this record was created for. Never rewritten. */
  sha: string;
  /** Git tree of `sha` when a candidate is sealed. Never rewritten. */
  tree?: string;
  /** Worktree the candidate was sealed from. Never rewritten. */
  worktree?: string;
  evidence: FactoryEvidence[];
  findings: string[];
  nextAction: string;
  /** Legacy stored value. OMB no longer records a QA disposition. */
  disposition?: QaEvidenceDisposition;
  createdAt: number;
}

/** Legacy stored value. OMB no longer starts QA sessions. */
export interface FactoryQaAttempt {
  sessionId: string;
  /** The SHA this attempt was started against. Never the rejected submission. */
  sha: string;
  handoffId?: string;
  createdAt: number;
}

export interface FactoryHandoff {
  id: string;
  taskId: string;
  stage: "review" | "remediate" | "test" | "release";
  repo: string;
  worktree: string;
  inputSha: string;
  resultSha: string;
  fromSpecialistId: string;
  toSpecialistId: string;
  summary: string;
  requiredEvidence: string[];
  checks: FactoryCheck[];
  findings: string[];
  nextAction: string;
  deliveredAt?: number;
  createdAt: number;
}

export const FACTORY_STATUSES = [
  "bound",
  "launch_intent",
  "running",
  "waiting_ci",
  // Legacy stored value only. A task in waiting_qa still loads and keeps its
  // writer lock, but nothing starts QA from it and no new task enters it.
  "waiting_qa",
  "waiting_owner",
  "waiting_external",
  "harvested",
  "blocked",
  "failed_closed",
  "cancelled",
] as const;
export type FactoryStatus = (typeof FACTORY_STATUSES)[number];

const WAITING: readonly FactoryStatus[] = ["waiting_ci", "waiting_qa", "waiting_owner", "waiting_external"];
const HOLDS_LOCK: readonly FactoryStatus[] = ["bound", "launch_intent", "running", ...WAITING];
const QUIET = new Set<FactoryStatus>(WAITING);

export interface FactoryEvidence {
  at: number;
  kind: string;
  ref: string;
  note?: string;
}

export interface FactoryDependency {
  id: string;
  blocked?: boolean;
}

export interface FactoryTask {
  id: string;
  objective: string;
  specialistId: FactorySpecialistId;
  specialistKey: string;
  role: FactoryRole;
  model: string;
  permissions: "auto";
  repo: string;
  baseSha: string;
  acceptance: string;
  dependencies: FactoryDependency[];
  requiredEvidence: string[];
  status: FactoryStatus;
  ombThreadId?: string;
  worktree?: string;
  sessionId?: string;
  provenSessionId?: string;
  resultSha?: string;
  evidence: FactoryEvidence[];
  checks: string[];
  /** Legacy stored values. OMB no longer records QA. */
  qaDisposition?: QaEvidenceDisposition;
  reviewedSha?: string;
  qaOfTaskId?: string;
  blocker?: string;
  nextAction?: string;
  dispatchKey?: string;
  owner?: string;
  authority?: string;
  /** The writer seat. The task id does not change when a same-task implementation handoff reseats it. */
  implementerId?: FactorySpecialistId;
  /** Legacy stored seats. New tasks never get a reviewer, tester, or release seat. */
  assignedReviewerId?: FactorySpecialistId;
  assignedTesterId?: FactorySpecialistId;
  assignedReleaseId?: FactorySpecialistId;
  phase?: PipelinePhase;
  /** "review" is a legacy stored value. New code sets only "implementer" or "none". */
  writerLock?: "implementer" | "review" | "none";
  handoffs?: FactoryHandoff[];
  threads?: { specialistId: FactorySpecialistId; threadId: string }[];
  findings?: string[];
  checkResults?: FactoryCheck[];
  remediationCount?: number;
  remediationLimit?: number;
  reviewSha?: string;
  testSha?: string;
  releaseSha?: string;
  /** Server binding. A revision's sha is not this field and is never edited. */
  generation?: number;
  branch?: string;
  headSha?: string;
  revisions?: FactoryRevision[];
  /** Session that last received the writer lock, and HEAD at that moment. */
  writerSessionId?: string;
  writerShaAtAssign?: string;
  /** Legacy stored values from the removed QA-only desk task. Such a task loads but cannot launch, harvest, or take a turn. */
  qaOnly?: boolean;
  readOnlyWorktree?: boolean;
  prUrl?: string;
  qaAttempts?: FactoryQaAttempt[];
  createdAt: number;
  updatedAt: number;
}

export interface FactoryView {
  id: string;
  specialistId: string;
  specialistKey: string;
  role: FactoryRole;
  model: string;
  permissions: "auto";
  repo: string;
  baseSha: string;
  state: FactoryStatus;
  quiet: boolean;
  binding: {
    worktree: string | null;
    sessionId: string | null;
    provenSessionId: string | null;
    ombThreadId: string | null;
  };
  evidence: FactoryEvidence[];
  checks: string[];
  qaDisposition: QaEvidenceDisposition | null;
  reviewedSha: string | null;
  resultSha: string | null;
  blocker: string | null;
  nextAction: string | null;
  objective: string;
  acceptance: string;
  dependencies: FactoryDependency[];
  requiredEvidence: string[];
  phase: PipelinePhase | null;
  handoffs: FactoryHandoff[];
  findings: string[];
  remediationCount: number;
  remediationLimit: number;
  reviewSha: string | null;
  testSha: string | null;
  releaseSha: string | null;
  generation: number;
  branch: string | null;
  headSha: string | null;
  revisions: FactoryRevision[];
  prUrl: string | null;
  qaOnly: boolean;
  readOnlyWorktree: boolean;
  qaAttempts: FactoryQaAttempt[];
  createdAt: number;
  updatedAt: number;
}

export type FactoryErrorCode =
  | "invalid"
  | "role_unavailable"
  | "ineligible"
  | "conflict"
  | "not_found"
  | "mismatch"
  | "blocked"
  | "qa_outside_omb";

export class FactoryDispatchError extends Error {
  readonly code: FactoryErrorCode;
  readonly task?: FactoryTask;
  constructor(code: FactoryErrorCode, message: string, task?: FactoryTask) {
    super(message);
    this.name = "FactoryDispatchError";
    this.code = code;
    this.task = task;
  }
}

interface UnavailableRole {
  specialistId: string;
  reason: string;
  at: number;
}

interface FactoryFile {
  version: 1;
  tasks: FactoryTask[];
  unavailableRoles: UnavailableRole[];
}

export interface FactoryBot {
  id: string;
  model?: string;
  driverKind?: string;
}

export interface FactoryCreateDeps {
  now?: () => number;
  bot: (id: string) => FactoryBot | null;
  /** Creates the OMB thread and returns its id. Must not start a turn. */
  createThread: (botId: string, title: string) => { threadId: string };
  /** Pins the thread folder before any turn. */
  pinCwd: (botId: string, threadId: string, cwd: string) => void;
  /** When false, the seat cannot be fenced and dispatch is blocked. */
  boundaryEnforced?: (bot: FactoryBot) => boolean;
}

export interface FactoryLaunchDeps {
  now?: () => number;
  /** Called only after session id and worktree are durable. */
  start: (task: FactoryTask) => Promise<void> | void;
}

const SHA = /^[0-9a-f]{40}$/i;
const UNSUPPORTED_PERMISSIONS = new Set([
  "bypass",
  "bypasspermissions",
  "full",
  "ask",
  "edits",
  "custom",
  "dangerously-skip-permissions",
]);

let cache: FactoryFile | null = null;

const filePath = (): string => join(DATA_DIR, "factory-tasks.json");

function emptyFile(): FactoryFile {
  return { version: 1, tasks: [], unavailableRoles: [] };
}

function load(): FactoryFile {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(readFileSync(filePath(), "utf8")) as FactoryFile;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.tasks)) cache = emptyFile();
    else cache = { version: 1, tasks: parsed.tasks, unavailableRoles: parsed.unavailableRoles ?? [] };
  } catch {
    cache = emptyFile();
  }
  return cache;
}

function save(next: FactoryFile): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileAtomic(filePath(), JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  cache = next;
}

export function _resetFactoryDispatch(): void {
  cache = null;
}

export function viewTask(task: FactoryTask): FactoryView {
  return {
    id: task.id,
    specialistId: task.specialistId,
    specialistKey: task.specialistKey,
    role: task.role,
    model: task.model,
    permissions: "auto",
    repo: task.repo,
    baseSha: task.baseSha,
    state: task.status,
    quiet: QUIET.has(task.status),
    binding: {
      worktree: task.worktree ?? null,
      sessionId: task.sessionId ?? null,
      provenSessionId: task.provenSessionId ?? null,
      ombThreadId: task.ombThreadId ?? null,
    },
    evidence: task.evidence,
    checks: task.checks,
    qaDisposition: task.qaDisposition ?? null,
    reviewedSha: task.reviewedSha ?? null,
    resultSha: task.resultSha ?? null,
    blocker: task.blocker ?? null,
    nextAction: task.nextAction ?? null,
    objective: task.objective,
    acceptance: task.acceptance,
    dependencies: task.dependencies,
    requiredEvidence: task.requiredEvidence,
    phase: task.phase ?? null,
    handoffs: task.handoffs ?? [],
    findings: task.findings ?? [],
    remediationCount: task.remediationCount ?? 0,
    remediationLimit: task.remediationLimit ?? defaultRemediationLimit(),
    reviewSha: task.reviewSha ?? null,
    testSha: task.testSha ?? null,
    releaseSha: task.releaseSha ?? null,
    generation: task.generation ?? 1,
    branch: task.branch ?? null,
    headSha: task.headSha ?? null,
    revisions: task.revisions ?? [],
    prUrl: task.prUrl ?? null,
    qaOnly: task.qaOnly === true,
    readOnlyWorktree: task.readOnlyWorktree === true,
    qaAttempts: task.qaAttempts ?? [],
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

export function listFactoryTasks(): FactoryView[] {
  return load().tasks.map(viewTask);
}

export function getFactoryTask(id: string): FactoryTask | undefined {
  return load().tasks.find((task) => task.id === id);
}

export function factoryTaskByThread(threadId: string): FactoryTask | undefined {
  return load().tasks.find((task) => task.ombThreadId === threadId || task.threads?.some((row) => row.threadId === threadId));
}

export function unavailableFactoryRoles(): UnavailableRole[] {
  return load().unavailableRoles;
}

function text(value: unknown, label: string, max = 4_000): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new FactoryDispatchError("invalid", `${label} is required`);
  }
  return value.trim().slice(0, max);
}

function parseDependencies(value: unknown): FactoryDependency[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new FactoryDispatchError("invalid", "dependencies must be a list");
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new FactoryDispatchError("invalid", `dependencies[${index}] must be an object`);
    }
    const row = item as { id?: unknown; blocked?: unknown };
    if (typeof row.id !== "string" || !row.id.trim()) {
      throw new FactoryDispatchError("invalid", `dependencies[${index}].id is required`);
    }
    if (row.blocked !== undefined && typeof row.blocked !== "boolean") {
      throw new FactoryDispatchError("invalid", `dependencies[${index}].blocked must be a boolean`);
    }
    return { id: row.id.trim(), ...(row.blocked ? { blocked: true } : {}) };
  });
}

function parseEvidenceRequired(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new FactoryDispatchError("invalid", "requiredEvidence must be a non-empty list of strings");
  }
  return value.map((item) => (item as string).trim().slice(0, 500));
}

export function parseFactoryPermissions(value: unknown): "auto" {
  if (typeof value !== "string" || !value.trim()) {
    throw new FactoryDispatchError("invalid", "permissions must be auto");
  }
  const token = value.trim();
  if (token === "auto") return "auto";
  if (UNSUPPORTED_PERMISSIONS.has(token.toLowerCase()) || token !== "auto") {
    throw new FactoryDispatchError("invalid", `unsupported permission value: ${token}`);
  }
  return "auto";
}

function eligibility(input: {
  owner?: string;
  authority?: string;
  protectedSession?: boolean;
  frozenTip?: boolean;
  dependencies: FactoryDependency[];
}): string[] {
  const reasons: string[] = [];
  if (!input.owner?.trim()) reasons.push("missing owner");
  if (!input.authority?.trim()) reasons.push("unclear authority");
  if (input.protectedSession) reasons.push("protected session");
  if (input.frozenTip) reasons.push("frozen tip");
  if (input.dependencies.some((dep) => dep.blocked)) reasons.push("blocked dependency");
  return reasons;
}

function git(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("git", args, { encoding: "utf8" });
  return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function createWorktree(repo: string, sha: string, dest: string): void {
  mkdirSync(dirname(dest), { recursive: true });
  const added = git(["-C", repo, "worktree", "add", "--detach", dest, sha]);
  if (!added.ok) throw new FactoryDispatchError("invalid", `could not create worktree: ${added.stderr.trim() || added.stdout.trim()}`);
  const head = git(["-C", dest, "rev-parse", "HEAD"]);
  if (!head.ok || head.stdout.trim().toLowerCase() !== sha.toLowerCase()) {
    throw new FactoryDispatchError("invalid", "worktree HEAD does not match the base SHA");
  }
}

function worktreeMatches(task: FactoryTask): boolean {
  if (!task.worktree || !existsSync(task.worktree)) return false;
  const head = git(["-C", task.worktree, "rev-parse", "--is-inside-work-tree"]);
  return head.ok && head.stdout.trim() === "true";
}

/** QA-only failure. Nothing is written and nothing is started. */
function qaOutside(task?: FactoryTask, detail?: string): FactoryDispatchError {
  return new FactoryDispatchError("qa_outside_omb", detail ? `${QA_OUTSIDE_OMB} ${detail}` : QA_OUTSIDE_OMB, task);
}

/** A legacy QA, review, or QA-only task. It loads, but OMB does not dispatch or harvest it. */
function isQaTask(task: FactoryTask): boolean {
  return task.qaOnly === true || task.role !== "implementer";
}

/** Phases that only a removed QA, review, test, or release stage could have set. */
const QA_PHASES: readonly PipelinePhase[] = ["review", "test", "release", "release_ready", "ship", "shipped"];

function holdsWriterLock(task: FactoryTask): boolean {
  if (task.role !== "implementer") return false;
  // A stale-SHA block keeps the canonical worktree. Dropping it would let a
  // second writer start before this session ends and the seat moves.
  if (task.status === "blocked" && task.writerLock === "implementer") return true;
  return HOLDS_LOCK.includes(task.status);
}

function mutate(id: string, change: (task: FactoryTask) => void): FactoryTask {
  const current = load();
  const task = current.tasks.find((item) => item.id === id);
  if (!task) throw new FactoryDispatchError("not_found", "no such factory task");
  change(task);
  task.updatedAt = Date.now();
  save({ ...current, tasks: current.tasks });
  return task;
}

/** No writer is created, launched, or resumed without a real OS sandbox. Every
 * writer entry point calls this before it touches a worktree, thread, or pin. */
function requireWriterSandbox(task?: FactoryTask): void {
  if (!detectFactorySandbox()) throw new FactoryDispatchError("blocked", NO_WRITER_SANDBOX_REASON, task);
}

export function createFactoryTask(raw: Record<string, unknown>, deps: FactoryCreateDeps): { task: FactoryTask; duplicate: boolean } {
  const permissions = parseFactoryPermissions(raw.permissions ?? raw.approvalMode);
  const specialistId = raw.specialistId;
  if (!isFactorySpecialistId(specialistId)) {
    throw new FactoryDispatchError("invalid", "specialist is not a registered factory id");
  }
  // Before any write: no worktree, no unavailable-role record, no thread.
  if (FACTORY_SPECIALISTS[specialistId].role !== "implementer") {
    throw qaOutside(undefined, `${FACTORY_SPECIALISTS[specialistId].name} is not dispatched by OMB.`);
  }
  const qaField = QA_INTAKE_FIELDS.find((key) => raw[key] !== undefined);
  if (qaField) throw qaOutside(undefined, `Intake field ${qaField} is not accepted.`);
  const model = text(raw.model, "model", 200);
  if (model !== FACTORY_ENGINE_MODEL) {
    throw new FactoryDispatchError("invalid", `model must be the configured engine model ${FACTORY_ENGINE_MODEL}`);
  }
  const objective = text(raw.objective, "objective");
  const repo = text(raw.repo, "repo", 2_000);
  const baseSha = text(raw.baseSha, "baseSha", 64);
  if (!SHA.test(baseSha)) throw new FactoryDispatchError("invalid", "baseSha must be a full 40-hex commit");
  const acceptance = text(raw.acceptance, "acceptance");
  const dependencies = parseDependencies(raw.dependencies);
  const requiredEvidence = parseEvidenceRequired(raw.requiredEvidence);
  const owner = typeof raw.owner === "string" ? raw.owner.trim() : "";
  const authority = typeof raw.authority === "string" ? raw.authority.trim() : "";
  const reasons = eligibility({
    owner,
    authority,
    protectedSession: raw.protectedSession === true,
    frozenTip: raw.frozenTip === true,
    dependencies,
  });
  if (reasons.length) throw new FactoryDispatchError("ineligible", reasons.join("; "));
  const dispatchKey = typeof raw.dispatchKey === "string" && raw.dispatchKey.trim() ? raw.dispatchKey.trim() : undefined;
  const existing = dispatchKey
    ? load().tasks.find((task) => task.dispatchKey === dispatchKey && task.status !== "cancelled" && task.status !== "failed_closed")
    : undefined;
  if (existing) return { task: existing, duplicate: true };

  const spec = FACTORY_SPECIALISTS[specialistId];
  const bot = deps.bot(specialistId);
  if (!bot) throw new FactoryDispatchError("invalid", "registered specialist is not seated");
  if (bot.model !== FACTORY_ENGINE_MODEL) {
    throw new FactoryDispatchError("invalid", "specialist model is not the configured engine model");
  }
  const enforced = deps.boundaryEnforced ? deps.boundaryEnforced(bot) : bot.driverKind === "claudeAgent";
  if (!enforced) {
    const now = (deps.now ?? Date.now)();
    const current = load();
    const unavailableRoles = current.unavailableRoles.filter((row) => row.specialistId !== specialistId);
    unavailableRoles.push({ specialistId, reason: "boundary cannot be enforced for this engine", at: now });
    save({ ...current, unavailableRoles });
    throw new FactoryDispatchError("role_unavailable", `${spec.name} is unavailable because its tool boundary cannot be enforced`);
  }
  const writer = load().tasks.find((task) => holdsWriterLock(task) && task.repo === repo);
  if (writer) {
    throw new FactoryDispatchError("conflict", `repository already has writer ${writer.id}`, writer);
  }
  // Before the worktree, the task record, the thread, and the pin.
  requireWriterSandbox();
  const now = (deps.now ?? Date.now)();
  const id = newId();
  const worktree = join(DATA_DIR, "factory-worktrees", id);
  createWorktree(repo, baseSha, worktree);
  const bound = resolveCanonical(worktree, repo);
  const task: FactoryTask = {
    id,
    objective,
    specialistId,
    specialistKey: spec.key,
    role: factoryRole(specialistId),
    model: FACTORY_ENGINE_MODEL,
    permissions,
    repo,
    baseSha: baseSha.toLowerCase(),
    acceptance,
    dependencies,
    requiredEvidence,
    status: "bound",
    worktree,
    evidence: [],
    checks: [],
    generation: 1,
    revisions: [],
    ...(bound?.branch ? { branch: bound.branch } : {}),
    ...(bound?.sha ? { headSha: bound.sha } : {}),
    ...(dispatchKey ? { dispatchKey } : {}),
    ...implementationSeat(specialistId),
    owner,
    authority,
    createdAt: now,
    updatedAt: now,
    nextAction: "launch",
  };
  // Durable worktree binding before any OMB thread and before any turn.
  const current = load();
  save({ ...current, tasks: [...current.tasks, task] });
  try {
    const title = typeof raw.title === "string" && raw.title.trim() ? raw.title.trim().slice(0, 80) : objective.slice(0, 80);
    const thread = deps.createThread(specialistId, title);
    deps.pinCwd(specialistId, thread.threadId, worktree);
    return { task: mutate(id, (row) => {
      row.ombThreadId = thread.threadId;
      row.threads = [{ specialistId, threadId: thread.threadId }];
    }), duplicate: false };
  } catch (error) {
    mutate(id, (row) => {
      row.status = "failed_closed";
      row.blocker = error instanceof Error ? error.message : "could not bind the OMB thread";
      row.nextAction = "blocked";
    });
    throw error;
  }
}

export async function launchFactoryTask(id: string, deps: FactoryLaunchDeps): Promise<{ task: FactoryTask; duplicate: boolean }> {
  const task = getFactoryTask(id);
  if (!task) throw new FactoryDispatchError("not_found", "no such factory task");
  // A stored QA, review, or QA-only task is left exactly as it was.
  if (isQaTask(task)) throw qaOutside(task);
  if (!task.worktree || !worktreeMatches(task)) {
    const blocked = mutate(id, (row) => {
      row.status = "blocked";
      row.blocker = "worktree binding is missing";
      row.nextAction = "blocked";
    });
    throw new FactoryDispatchError("blocked", "worktree binding is missing", blocked);
  }
  if (task.sessionId) {
    return { task, duplicate: true };
  }
  if (task.status !== "bound") {
    throw new FactoryDispatchError("blocked", `cannot launch from ${task.status}`, task);
  }
  if (unavailableFactoryRoles().some((row) => row.specialistId === task.specialistId)) {
    throw new FactoryDispatchError("role_unavailable", "specialist role is unavailable", task);
  }
  // The writer's shell can run arbitrary programs, and the command-text guard
  // cannot confine them. Without a real OS sandbox no writer is started.
  if (task.role === "implementer" && !detectFactorySandbox()) {
    const blocked = mutate(id, (row) => {
      row.status = "blocked";
      row.blocker = NO_WRITER_SANDBOX_REASON;
      row.nextAction = "blocked";
    });
    throw new FactoryDispatchError("blocked", NO_WRITER_SANDBOX_REASON, blocked);
  }
  const sessionId = randomUUID();
  const intent = mutate(id, (row) => {
    row.sessionId = sessionId;
    row.status = "launch_intent";
    row.nextAction = "start turn";
    if (row.role === "implementer" && row.worktree) {
      const assigned = git(["-C", row.worktree, "rev-parse", "HEAD"]);
      const assignedSha = assigned.ok ? assigned.stdout.trim().toLowerCase() : "";
      if (SHA.test(assignedSha)) {
        row.writerSessionId = sessionId;
        row.writerShaAtAssign = assignedSha;
      } else {
        row.writerSessionId = undefined;
        row.writerShaAtAssign = undefined;
      }
    }
  });
  if (!intent.sessionId || !intent.worktree) {
    throw new FactoryDispatchError("blocked", "launch intent was not stored", intent);
  }
  try {
    await deps.start(getFactoryTask(id)!);
  } catch (error) {
    const blocked = mutate(id, (row) => {
      row.status = "blocked";
      row.blocker = error instanceof Error ? error.message : "launch failed";
      row.nextAction = "blocked";
    });
    throw new FactoryDispatchError("blocked", blocked.blocker ?? "launch failed", blocked);
  }
  const running = mutate(id, (row) => {
    if (!row.sessionId || !row.worktree) {
      row.status = "blocked";
      row.blocker = "running refused without a stored binding";
      return;
    }
    row.status = "running";
    row.nextAction = "harvest";
  });
  if (running.status !== "running") {
    throw new FactoryDispatchError("blocked", running.blocker ?? "running refused", running);
  }
  return { task: running, duplicate: false };
}

export function noteFactorySession(threadId: string, sessionId: string): FactoryTask | null {
  const task = factoryTaskByThread(threadId);
  if (!task || !task.sessionId || task.ombThreadId !== threadId) return null;
  if (task.sessionId !== sessionId) {
    return mutate(task.id, (row) => {
      row.status = "blocked";
      row.blocker = "provider session does not match the stored binding";
      row.nextAction = "blocked";
    });
  }
  return mutate(task.id, (row) => {
    row.provenSessionId = sessionId;
  });
}

export interface FactoryHarvestInput {
  sessionId?: unknown;
  worktree?: unknown;
  resultSha?: unknown;
  evidence?: unknown;
  checks?: unknown;
  /** Refused with QA_OUTSIDE_OMB. Present only so a QA submission is rejected, not ignored. */
  qaDisposition?: unknown;
  /** Refused with QA_OUTSIDE_OMB. */
  reviewedSha?: unknown;
  blocker?: unknown;
  checkResults?: unknown;
}

export function harvestFactoryTask(id: string, raw: FactoryHarvestInput, opts?: { writerSessionEnded?: boolean }): FactoryTask {
  const task = getFactoryTask(id);
  if (!task) throw new FactoryDispatchError("not_found", "no such factory task");
  // QA submissions are refused before any check that could write: no
  // rejection record, no status change, no handoff.
  if (raw.qaDisposition !== undefined || raw.reviewedSha !== undefined) {
    throw qaOutside(task, "A QA disposition or reviewed SHA is not recorded.");
  }
  if (isQaTask(task)) throw qaOutside(task);
  if (task.phase && QA_PHASES.includes(task.phase)) {
    throw qaOutside(task, "This task is past implementation.");
  }
  if (typeof raw.sessionId !== "string" || raw.sessionId !== task.sessionId) {
    throw new FactoryDispatchError("mismatch", "harvest session does not match the task binding");
  }
  if (typeof raw.worktree !== "string" || raw.worktree !== task.worktree) {
    throw new FactoryDispatchError("mismatch", "harvest worktree does not match the task binding");
  }
  if (!Array.isArray(raw.evidence) || raw.evidence.length === 0) {
    throw new FactoryDispatchError("invalid", "harvest requires evidence");
  }
  if (typeof raw.resultSha !== "string" || !SHA.test(raw.resultSha)) {
    throw new FactoryDispatchError("invalid", "resultSha must be a full 40-hex commit");
  }
  const evidence: FactoryEvidence[] = raw.evidence.map((item, index) => {
    if (!item || typeof item !== "object") throw new FactoryDispatchError("invalid", `evidence[${index}] is invalid`);
    const row = item as { kind?: unknown; ref?: unknown; note?: unknown };
    if (typeof row.kind !== "string" || !row.kind.trim() || typeof row.ref !== "string" || !row.ref.trim()) {
      throw new FactoryDispatchError("invalid", `evidence[${index}] needs kind and ref`);
    }
    return {
      at: Date.now(),
      kind: row.kind.trim().slice(0, 40),
      ref: row.ref.trim().slice(0, 500),
      ...(typeof row.note === "string" && row.note.trim() ? { note: row.note.trim().slice(0, 500) } : {}),
    };
  });
  const checkResults = parseCheckResults(raw.checkResults);
  const checks = raw.checks === undefined ? task.checks : Array.isArray(raw.checks) && raw.checks.every((item) => typeof item === "string")
    ? raw.checks.map((item) => item.slice(0, 500))
    : (() => { throw new FactoryDispatchError("invalid", "checks must be a list of strings"); })();
  const canonical = resolveCanonical(task.worktree!, task.repo);
  if (!canonical) throw new FactoryDispatchError("blocked", "canonical worktree HEAD could not be read");
  const claimed = (raw.resultSha as string).toLowerCase();
  const generation = task.generation ?? 1;
  if (claimed !== canonical.sha) {
    // A mismatched SHA is kept as rejected evidence. It never becomes the result.
    const stale = claimed;
    return mutate(id, (row) => {
      if ((row.revisions ?? []).some((item) => item.kind === "rejection" && item.sessionId === row.sessionId && item.sha === stale && item.generation === generation)) return;
      const note = `rejected ${stale}; prior evidence was not changed`;
      row.branch = canonical.branch;
      row.evidence = [...row.evidence, ...evidence, { at: Date.now(), kind: "rejection", ref: stale, note }].slice(-200);
      pushRevision(row, {
        kind: "rejection",
        sessionId: row.sessionId!,
        specialistId: row.specialistId,
        generation,
        sha: stale,
        evidence: [{ at: Date.now(), kind: "rejection", ref: stale, note }],
        findings: [`claimed ${stale}`],
        nextAction: `rejected stale SHA ${stale}`,
      });
      const uncertain = writerHeadUncertain(row, canonical.sha, false);
      if (uncertain) {
        row.status = "blocked";
        row.phase = "blocked";
        row.blocker = uncertain;
        row.nextAction = uncertain;
        return;
      }
      adoptVerifiedCandidate(row, canonical.sha, evidence);
    });
  }
  if ((task.revisions ?? []).some((item) => item.kind === "implementation" && item.sessionId === task.sessionId && item.sha === canonical.sha && item.generation === generation)) {
    return task;
  }
  return mutate(id, (row) => {
    row.headSha = canonical.sha;
    row.branch = canonical.branch;
    row.evidence = [...row.evidence, ...evidence].slice(-200);
    row.checks = checks;
    if (checkResults.length) row.checkResults = [...(row.checkResults ?? []), ...checkResults].slice(-100);
    if (typeof raw.blocker === "string") row.blocker = raw.blocker.trim().slice(0, 500) || undefined;
    completeImplementation(row, { resultSha: canonical.sha, checkResults, evidence }, { sessionEnded: opts?.writerSessionEnded === true });
  });
}

export function cancelFactoryTask(id: string): FactoryTask {
  const task = getFactoryTask(id);
  if (!task) throw new FactoryDispatchError("not_found", "no such factory task");
  return mutate(id, (row) => {
    row.status = "cancelled";
    row.nextAction = "cancelled";
  });
}

export function waitFactoryTask(id: string, status: FactoryStatus): FactoryTask {
  if (!QUIET.has(status)) throw new FactoryDispatchError("invalid", "wait status must be a quiet wait");
  const task = getFactoryTask(id);
  if (!task) throw new FactoryDispatchError("not_found", "no such factory task");
  // waiting_qa stays loadable for stored tasks, but nothing new enters it.
  if (status === "waiting_qa") throw qaOutside(task, "A task cannot be moved to waiting_qa.");
  if (!task.worktree) throw new FactoryDispatchError("blocked", "quiet wait keeps a worktree, and this task has none");
  return mutate(id, (row) => {
    row.status = status;
    row.nextAction = status;
  });
}

export function recoverFactoryTasks(): { restored: string[]; blocked: string[] } {
  const restored: string[] = [];
  const blocked: string[] = [];
  const current = load();
  let changed = false;
  for (const task of current.tasks) {
    if (task.status !== "launch_intent" && task.status !== "running") continue;
    if (isQaTask(task)) {
      // A stored QA or review session is not resumed. Nothing is started.
      task.status = "blocked";
      task.blocker = QA_OUTSIDE_OMB;
      task.nextAction = QA_OUTSIDE_OMB;
      blocked.push(task.id);
      changed = true;
      continue;
    }
    if (!detectFactorySandbox()) {
      // Not resumed. The session, binding, and writer lock stay as stored.
      task.status = "blocked";
      task.blocker = NO_WRITER_SANDBOX_REASON;
      task.nextAction = "blocked";
      blocked.push(task.id);
      changed = true;
      continue;
    }
    const proven = Boolean(task.sessionId && task.provenSessionId === task.sessionId && worktreeMatches(task));
    if (proven) {
      task.status = "running";
      task.blocker = undefined;
      task.nextAction = "resume the stored binding";
      restored.push(task.id);
      changed = true;
      continue;
    }
    task.status = "blocked";
    task.blocker = "restart recovery failed closed: session or worktree did not match";
    task.nextAction = "blocked";
    blocked.push(task.id);
    changed = true;
  }
  if (changed) save({ ...current, tasks: current.tasks.map((task) => ({ ...task, updatedAt: Date.now() })) });
  return { restored, blocked };
}

export function factoryTurnGuard(threadId: string): {
  sessionId: string;
  worktree: string;
  role: FactoryRole;
  disallowedTools: string[];
} | null {
  const task = factoryTaskByThread(threadId);
  if (!task) return null;
  const seat = task.threads?.find((row) => row.threadId === threadId);
  const specialistId = seat?.specialistId ?? task.specialistId;
  const role = isFactorySpecialistId(specialistId) ? factoryRole(specialistId) : task.role;
  // No QA or review turn starts on a factory thread, whatever its stored state.
  if (isQaTask(task) || role !== "implementer") throw qaOutside(task);
  // A stored launch_intent or running task cannot start or resume a turn
  // either. This only reads: the stored record and session are left alone.
  requireWriterSandbox();
  if (task.status === "blocked" || task.status === "failed_closed" || task.status === "cancelled") {
    throw new FactoryDispatchError("blocked", task.blocker || "factory task is blocked");
  }
  if (task.status !== "launch_intent" && task.status !== "running") {
    throw new FactoryDispatchError("blocked", "factory turn refused before launch intent was stored");
  }
  if (!task.sessionId || !task.worktree) {
    throw new FactoryDispatchError("blocked", "factory turn refused without a stored binding");
  }
  if (task.writerLock && task.writerLock !== "implementer") {
    throw new FactoryDispatchError("blocked", "the implementer turn needs the writer lock");
  }
  if (task.ombThreadId && task.ombThreadId !== threadId && (task.status === "running" || task.status === "launch_intent")) {
    throw new FactoryDispatchError("blocked", "this specialist turn has ended");
  }
  return {
    sessionId: task.sessionId,
    worktree: task.worktree,
    role,
    // Always empty for the implementer. Kept so a read-only role can never
    // reach a turn without its tool fence.
    disallowedTools: isReadOnlyFactoryRole(role) ? [...REVIEWER_DISALLOWED_TOOLS] : [],
  };
}


function defaultRemediationLimit(): number {
  const raw = Number(process.env.OMB_FACTORY_REMEDIATION_LIMIT ?? "2");
  if (!Number.isInteger(raw) || raw < 1 || raw > 20) return 2;
  return raw;
}

function implementationSeat(implementerId: FactorySpecialistId): Pick<FactoryTask, "implementerId" | "phase" | "writerLock" | "handoffs" | "findings" | "checkResults"> {
  return {
    implementerId,
    phase: "implement",
    writerLock: "implementer",
    handoffs: [],
    findings: [],
    checkResults: [],
  };
}

function parseCheckResults(value: unknown): FactoryCheck[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new FactoryDispatchError("invalid", "checkResults must be a list");
  return value.map((item, index) => {
    if (!item || typeof item !== "object") throw new FactoryDispatchError("invalid", `checkResults[${index}] is invalid`);
    const row = item as { name?: unknown; result?: unknown; sha?: unknown };
    if (typeof row.name !== "string" || !row.name.trim() || typeof row.result !== "string" || !row.result.trim()) {
      throw new FactoryDispatchError("invalid", `checkResults[${index}] needs name and result`);
    }
    if (typeof row.sha !== "string" || !SHA.test(row.sha)) {
      throw new FactoryDispatchError("invalid", `checkResults[${index}].sha must be a full SHA`);
    }
    return { name: row.name.trim().slice(0, 80), result: row.result.trim().slice(0, 80), sha: row.sha.toLowerCase() };
  });
}

function resolveCanonical(worktree: string, repo: string): { sha: string; branch: string } | null {
  if (!worktree || !repo || !existsSync(worktree)) return null;
  const head = git(["-C", worktree, "rev-parse", "HEAD"]);
  if (!head.ok) return null;
  const sha = head.stdout.trim().toLowerCase();
  if (!SHA.test(sha)) return null;
  const branchResult = git(["-C", worktree, "rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = branchResult.ok ? branchResult.stdout.trim() : "";
  if (!branch) return null;
  const common = git(["-C", worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const repoCommon = git(["-C", repo, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common.ok || !repoCommon.ok) return null;
  try {
    if (realpathSync(common.stdout.trim()) !== realpathSync(repoCommon.stdout.trim())) return null;
  } catch {
    return null;
  }
  return { sha, branch };
}

function pushRevision(row: FactoryTask, rev: Omit<FactoryRevision, "id" | "createdAt">): void {
  const dup = (row.revisions ?? []).some((item) => item.kind === rev.kind && item.sessionId === rev.sessionId && item.sha === rev.sha && item.generation === rev.generation);
  if (dup) return;
  row.revisions = [...(row.revisions ?? []), { ...rev, id: newId(), createdAt: Date.now() }];
}


/** Runs the base-pinned required-tests for `sha`. The writer's own copy is
 * never executed; one that differs from the recorded base is a failure. */
function runRequiredTests(row: FactoryTask, sha: string): { ran: boolean; ok: boolean; checks: FactoryCheck[]; reason?: string; refused?: true } {
  if (!row.worktree) return { ran: false, ok: true, checks: [] };
  const outcome = runRequiredTestsPinned(row.worktree, row.baseSha, sha);
  if (outcome.state === "undefined") return { ran: false, ok: true, checks: [] };
  // Refused: the script was not run and the seal must not proceed (no sandbox,
  // or the definition could not be read reliably).
  if (outcome.state === "unsandboxed" || outcome.state === "unreadable") return { ran: false, ok: false, checks: [], reason: outcome.reason, refused: true };
  const ok = outcome.state === "ran" && outcome.ok;
  const reason = outcome.state === "modified" || (outcome.state === "ran" && !outcome.ok) ? outcome.reason : undefined;
  return { ran: true, ok, checks: [{ name: "required-tests", result: ok ? "pass" : "fail", sha }], ...(reason ? { reason } : {}) };
}

/** The pinned definition exists at the recorded base. */
function requiredTestsDefinedAtBase(row: FactoryTask): boolean {
  if (!row.worktree || !row.baseSha) return false;
  return git(["-C", row.worktree, "ls-tree", row.baseSha, "--", REQUIRED_TESTS_PATH]).stdout.trim() !== "";
}

/** Drops legacy review pointers. Revisions already stored keep their sha. */
function clearReviewPointers(row: FactoryTask, sha: string): void {
  row.qaDisposition = undefined;
  row.reviewedSha = undefined;
  row.reviewSha = undefined;
  row.testSha = undefined;
  row.releaseSha = undefined;
  row.findings = [];
  row.checkResults = (row.checkResults ?? []).filter((check) => check.sha === sha);
}

function worktreeClean(worktree: string): boolean {
  const status = git(["-C", worktree, "status", "--porcelain=v1", "--untracked-files=all"]);
  return status.ok && status.stdout.trim() === "";
}

/** Paths of every symlink in the tree at `head`, including links inherited
 * unchanged from the base, whose target is absolute or climbs out of the tree.
 * Null when the tree cannot be read. */
function escapingSymlinks(worktree: string, head: string): string[] | null {
  const tree = spawnSync("git", ["-C", worktree, "ls-tree", "-r", "-z", "--full-tree", head], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (tree.status !== 0) return null;
  const escaping: string[] = [];
  for (const entry of (tree.stdout ?? "").split("\0")) {
    const meta = entry.match(/^120000 blob ([0-9a-f]+)\t/);
    if (!meta) continue;
    const path = entry.slice(entry.indexOf("\t") + 1);
    const blob = git(["-C", worktree, "cat-file", "blob", meta[1]!]);
    if (!blob.ok) return null;
    const target = blob.stdout.replace(/\\/g, "/");
    const resolved = posix.normalize(posix.join(posix.dirname(path), target));
    if (/^([A-Za-z]:|\/)/.test(target) || resolved === ".." || resolved.startsWith("../")) escaping.push(path);
  }
  return escaping;
}

/** What must still hold right before a candidate is sealed or the writer lock
 * is released: HEAD is the SHA being sealed, the worktree is clean, and no
 * symlink in the sealed tree, inherited or committed, points out of it. */
function worktreeStateProblem(row: FactoryTask, head: string): string | null {
  if (!row.worktree) return "blocked: task has no assigned writer";
  const current = git(["-C", row.worktree, "rev-parse", "HEAD"]);
  if (!current.ok || current.stdout.trim().toLowerCase() !== head.toLowerCase()) return "blocked: HEAD changed while it was being checked";
  if (!worktreeClean(row.worktree)) return "blocked: worktree is not clean";
  const links = escapingSymlinks(row.worktree, head);
  if (links === null) return "blocked: committed symlinks could not be inspected";
  if (links.length) return `blocked: committed symlink points outside the worktree: ${links[0]}`;
  return null;
}

function blockTask(row: FactoryTask, reason: string): void {
  row.status = "blocked";
  row.phase = "blocked";
  row.blocker = reason;
  row.nextAction = reason;
}

function descendsFrom(worktree: string, ancestor: string, head: string): boolean {
  if (!SHA.test(ancestor) || !SHA.test(head)) return false;
  return git(["-C", worktree, "merge-base", "--is-ancestor", ancestor, head]).ok;
}

/**
 * Null only when every acceptance link holds. A mismatch never adopts HEAD
 * on a partial check. `sessionEnded` is true only when the writer turn is
 * finishing. A desk harvest during the turn passes false and stays blocked.
 * Status may still be running at that finish; the flag is the end of the turn.
 */
function writerHeadUncertain(row: FactoryTask, head: string, sessionEnded: boolean): string | null {
  if (!row.worktree || !row.implementerId) return "blocked: task has no assigned writer";
  if (!sessionEnded) return "blocked: writer session has not ended";
  if (row.writerLock !== "implementer" || !holdsWriterLock(row)) return "blocked: task does not own the worktree lock";
  if (!row.writerSessionId || !row.writerShaAtAssign || !row.baseSha) return "blocked: latest writer assignment was not recorded";
  if (row.sessionId !== row.writerSessionId || row.specialistId !== row.implementerId) {
    return "blocked: seated session is not the latest assigned writer";
  }
  const canonical = resolveCanonical(row.worktree, row.repo);
  if (!canonical || canonical.sha !== head) return "blocked: canonical worktree HEAD could not be confirmed";
  if (!SHA.test(head) || head === row.writerShaAtAssign) return "blocked: HEAD was not produced by the latest assigned writer";
  if (!descendsFrom(row.worktree, row.baseSha, head)) return "blocked: HEAD does not descend from the recorded base";
  if (!descendsFrom(row.worktree, row.writerShaAtAssign, head)) return "blocked: HEAD was not produced by the latest assigned writer";
  return worktreeStateProblem(row, head);
}

function gitTree(worktree: string, sha: string): string | null {
  const result = git(["-C", worktree, "rev-parse", `${sha}^{tree}`]);
  if (!result.ok) return null;
  const tree = result.stdout.trim().toLowerCase();
  return SHA.test(tree) ? tree : null;
}

/** Immutable candidate for this generation. Missing tree or worktree is not sealed. */
function sealedCandidate(row: FactoryTask): FactoryRevision | undefined {
  const generation = row.generation ?? 1;
  const found = (row.revisions ?? []).filter((item) => item.kind === "candidate" && item.generation === generation && SHA.test(item.sha) && !!item.tree && SHA.test(item.tree) && !!item.worktree && !!item.sessionId);
  return found.length ? found[found.length - 1] : undefined;
}

function persistSealedCandidate(row: FactoryTask, head: string, evidence: FactoryEvidence[]): boolean {
  if (!row.worktree || !row.writerSessionId || !row.implementerId) {
    row.status = "blocked";
    row.phase = "blocked";
    row.blocker = "blocked: task/session/lock provenance could not be proved";
    row.nextAction = row.blocker;
    return false;
  }
  const tree = gitTree(row.worktree, head);
  if (!tree) {
    row.status = "blocked";
    row.phase = "blocked";
    row.blocker = "blocked: task/session/lock provenance could not be proved";
    row.nextAction = row.blocker;
    return false;
  }
  const generation = row.generation ?? 1;
  const note = `sealed candidate ${head} tree ${tree} worktree ${row.worktree} generation ${generation} writer ${row.writerSessionId}`;
  pushRevision(row, {
    kind: "candidate",
    sessionId: row.writerSessionId,
    specialistId: row.implementerId,
    generation,
    sha: head,
    tree,
    worktree: row.worktree,
    evidence: [...evidence, { at: Date.now(), kind: "seal", ref: head, note }],
    findings: [],
    nextAction: `sealed candidate ${head}`,
  });
  return sealedCandidate(row)?.sha === head;
}

/** End of OMB's part. The sealed SHA is the result; review happens outside OMB. */
function finishImplementation(row: FactoryTask, head: string): void {
  row.resultSha = head;
  row.headSha = head;
  row.writerLock = "none";
  row.phase = "implemented";
  row.status = "harvested";
  row.blocker = undefined;
  row.nextAction = `implementation sealed at ${head}. ${QA_OUTSIDE_OMB}`;
}

function adoptVerifiedCandidate(row: FactoryTask, head: string, evidence: FactoryEvidence[]): void {
  if (!row.worktree || !requiredTestsDefinedAtBase(row)) {
    blockTask(row, "uncertain: required checks are not defined at the recorded base");
    return;
  }
  if ((row.revisions ?? []).some((item) => item.kind === "review")) row.generation = (row.generation ?? 1) + 1;
  clearReviewPointers(row, head);
  const tests = runRequiredTests(row, head);
  if (tests.refused) {
    blockTask(row, tests.reason!);
    return;
  }
  const drift = worktreeStateProblem(row, head);
  if (drift) {
    row.checkResults = [...(row.checkResults ?? []).filter((check) => check.sha === head), ...tests.checks].slice(-100);
    blockTask(row, `${drift} (after required checks ran; not sealed)`);
    return;
  }
  const tree = gitTree(row.worktree, head);
  if (!tree || !row.writerSessionId || !row.implementerId) {
    row.status = "blocked";
    row.phase = "blocked";
    row.blocker = "blocked: task/session/lock provenance could not be proved";
    row.nextAction = row.blocker;
    return;
  }
  const note = `sealed candidate ${head} tree ${tree} worktree ${row.worktree} generation ${row.generation ?? 1} writer ${row.writerSessionId}`;
  pushRevision(row, {
    kind: "candidate",
    sessionId: row.writerSessionId,
    specialistId: row.implementerId,
    generation: row.generation ?? 1,
    sha: head,
    tree,
    worktree: row.worktree,
    evidence: [...evidence, { at: Date.now(), kind: "seal", ref: head, note }],
    findings: [],
    nextAction: tests.ok ? `sealed verified HEAD ${head}` : `required checks failed for ${head}`,
  });
  row.checkResults = [...(row.checkResults ?? []).filter((check) => check.sha === head), ...tests.checks].slice(-100);
  if (!tests.ok) {
    row.status = "blocked";
    row.phase = "blocked";
    row.writerLock = "implementer";
    row.blocker = `required checks failed for ${head}${tests.reason ? `: ${tests.reason}` : ""}`;
    row.nextAction = row.blocker;
    return;
  }
  finishImplementation(row, head);
}

/**
 * Implementation result on the same task. Only a verified clean writer HEAD
 * at the end of the writer session is sealed and accepted. A desk harvest
 * during the session stores evidence and leaves the task where it is.
 */
function completeImplementation(row: FactoryTask, input: { resultSha: string; checkResults: FactoryCheck[]; evidence: FactoryEvidence[] }, opts: { sessionEnded: boolean }): void {
  if (!row.evidence.length) {
    row.status = "blocked";
    row.phase = "blocked";
    row.blocker = "missing evidence";
    row.nextAction = "blocked: missing evidence";
    return;
  }
  if (row.phase !== "implement" && row.phase !== "remediate") {
    row.nextAction = `evidence recorded for ${input.resultSha}; the task is ${row.phase ?? row.status}`;
    return;
  }
  if (!opts.sessionEnded) {
    row.nextAction = `evidence recorded for ${input.resultSha}; the server seals the candidate when the writer session ends`;
    return;
  }
  const reason = writerHeadUncertain(row, input.resultSha, true);
  if (reason) {
    row.status = "blocked";
    row.phase = "blocked";
    row.blocker = reason;
    row.nextAction = reason;
    return;
  }
  // Legacy rows can carry an older review. It never applies to a new SHA.
  const hadOtherReview = (row.revisions ?? []).some((item) => item.kind === "review" && item.sha !== input.resultSha);
  if (hadOtherReview) {
    row.generation = (row.generation ?? 1) + 1;
    clearReviewPointers(row, input.resultSha);
  } else if (row.reviewSha && row.reviewSha !== input.resultSha) {
    clearReviewPointers(row, input.resultSha);
  }
  // Every seal path checks the base definition. With one and no OS sandbox the
  // script is not spawned and the seal is refused; with none, nothing runs.
  const tests = runRequiredTests(row, input.resultSha);
  if (tests.refused) {
    blockTask(row, tests.reason!);
    return;
  }
  const drift = worktreeStateProblem(row, input.resultSha);
  if (drift) {
    if (tests.checks.length) row.checkResults = [...(row.checkResults ?? []), ...tests.checks].slice(-100);
    blockTask(row, tests.ran ? `${drift} (after required checks ran; not sealed)` : `${drift} (not sealed)`);
    return;
  }
  if (!persistSealedCandidate(row, input.resultSha, input.evidence)) return;
  row.resultSha = input.resultSha;
  const nextAction = tests.ran && !tests.ok
    ? `required tests failed for ${input.resultSha}${tests.reason ? `: ${tests.reason}` : ""}`
    : `implementation sealed at ${input.resultSha}`;
  pushRevision(row, {
    kind: "implementation",
    sessionId: row.sessionId!,
    specialistId: row.specialistId,
    generation: row.generation ?? 1,
    sha: input.resultSha,
    evidence: input.evidence,
    findings: [],
    nextAction,
  });
  if (tests.ran && !tests.ok) {
    row.checkResults = [...(row.checkResults ?? []), ...tests.checks].slice(-100);
    row.evidence = [...row.evidence, { at: Date.now(), kind: "test", ref: input.resultSha, note: "required tests failed" }].slice(-200);
    row.status = "waiting_ci";
    row.phase = "remediate";
    row.writerLock = "implementer";
    row.nextAction = nextAction;
    return;
  }
  if (tests.checks.length) row.checkResults = [...(row.checkResults ?? []).filter((check) => check.sha === input.resultSha), ...tests.checks].slice(-100);
  row.findings = [];
  finishImplementation(row, input.resultSha);
}

export interface FactoryDeliverDeps extends FactoryLaunchDeps {
  bot: (id: string) => FactoryBot | null;
  createThread: (botId: string, title: string) => { threadId: string };
  pinCwd: (botId: string, threadId: string, cwd: string) => void;
}

/** A same-task handoff back to the implementer. Every other stage was QA, review, test, or release. */
function isImplementationHandoff(handoff: FactoryHandoff): boolean {
  return handoff.stage === "remediate"
    && isFactorySpecialistId(handoff.toSpecialistId)
    && factoryRole(handoff.toSpecialistId) === "implementer";
}

function leaveHandoffUnlaunched(id: string, handoffId: string, snapshot: FactoryTask, blocker: string): FactoryTask {
  return mutate(id, (row) => {
    const next = structuredClone(snapshot);
    for (const key of Object.keys(row)) delete (row as unknown as Record<string, unknown>)[key];
    Object.assign(row, next);
    const handoff = row.handoffs?.find((item) => item.id === handoffId);
    if (handoff) handoff.deliveredAt = undefined;
    row.status = "blocked";
    row.phase = row.phase === "shipped" || row.phase === "release_ready" ? row.phase : "blocked";
    row.blocker = blocker.slice(0, 500);
    row.nextAction = row.blocker;
  });
}

/**
 * Starts the implementer named on the newest undelivered same-task handoff.
 * A retry returns that handoff and does not start another worker. A QA,
 * review, test, or release handoff is refused before anything is written.
 */
export async function deliverHandoff(id: string, deps: FactoryDeliverDeps, opts?: { handoffId?: string }): Promise<{ task: FactoryTask; duplicate: boolean }> {
  const task = getFactoryTask(id);
  if (!task) throw new FactoryDispatchError("not_found", "no such factory task");
  const requested = opts?.handoffId?.trim();
  let pending = requested
    ? task.handoffs?.find((item) => item.id === requested)
    : [...(task.handoffs ?? [])].reverse().find((item) => !item.deliveredAt);
  if (requested && !pending) throw new FactoryDispatchError("not_found", "no such handoff", task);
  const considered = pending ?? task.handoffs?.[task.handoffs.length - 1];
  if (considered && !isImplementationHandoff(considered)) {
    throw qaOutside(task, `Handoff ${considered.id} (${considered.stage}) is not delivered.`);
  }
  if (pending?.deliveredAt) return { task, duplicate: true };
  if (!pending) {
    const last = task.handoffs?.[task.handoffs.length - 1];
    if (last?.deliveredAt) return { task, duplicate: true };
    throw new FactoryDispatchError("blocked", "no handoff is waiting", task);
  }
  if (!task.evidence.length || !task.resultSha) {
    const blocked = mutate(id, (row) => {
      row.status = "blocked";
      row.phase = "blocked";
      row.blocker = "missing evidence";
      row.nextAction = "blocked: missing evidence";
      const handoff = row.handoffs?.find((item) => item.id === pending!.id);
      if (handoff) handoff.deliveredAt = undefined;
    });
    throw new FactoryDispatchError("blocked", "missing evidence", blocked);
  }
  if (task.status === "running" || task.status === "launch_intent") {
    throw new FactoryDispatchError("blocked", "the current specialist turn has not ended", task);
  }
  const target = pending.toSpecialistId;
  if (!isFactorySpecialistId(target)) throw new FactoryDispatchError("invalid", "handoff specialist is not registered");
  if (unavailableFactoryRoles().some((row) => row.specialistId === target)) {
    const blocked = mutate(id, (row) => {
      row.status = "blocked";
      row.phase = "blocked";
      row.blocker = `specialist ${target} is unavailable`;
      row.nextAction = "blocked: specialist unavailable";
      const handoff = row.handoffs?.find((item) => item.id === pending!.id);
      if (handoff) handoff.deliveredAt = undefined;
    });
    throw new FactoryDispatchError("role_unavailable", `specialist ${target} is unavailable`, blocked);
  }
  const bot = deps.bot(target);
  if (!bot || bot.model !== FACTORY_ENGINE_MODEL || bot.driverKind !== "claudeAgent") {
    const blocked = mutate(id, (row) => {
      row.status = "blocked";
      row.phase = "blocked";
      row.blocker = `specialist ${target} is unavailable`;
      row.nextAction = "blocked: specialist unavailable";
      const handoff = row.handoffs?.find((item) => item.id === pending!.id);
      if (handoff) handoff.deliveredAt = undefined;
    });
    throw new FactoryDispatchError("role_unavailable", `specialist ${target} is unavailable`, blocked);
  }
  if (task.writerLock !== "implementer") {
    throw new FactoryDispatchError("blocked", "the implementer handoff waits until the writer lock transfers", task);
  }
  // Before the thread, the pin, and any change to the task record. The
  // handoff stays pending, so a retry works once a sandbox exists.
  requireWriterSandbox(task);
  const rejectedSessions = new Set((task.revisions ?? []).filter((item) => item.kind === "rejection").map((item) => item.sessionId));
  const snapshot = structuredClone(task);
  const handoffId = pending.id;
  try {
    // Durable before the start. A failed start rolls this back.
    mutate(id, (row) => {
      const handoff = row.handoffs?.find((item) => item.id === handoffId);
      if (handoff && !handoff.deliveredAt) handoff.deliveredAt = Date.now();
    });
    const stored = getFactoryTask(id)!;
    const marked = stored.handoffs?.find((item) => item.id === handoffId);
    if (!marked?.deliveredAt) throw new FactoryDispatchError("blocked", "handoff was not stored", stored);
    const thread = deps.createThread(target, `${pending.stage}: ${task.objective}`.slice(0, 80));
    deps.pinCwd(target, thread.threadId, task.worktree!);
    mutate(id, (row) => {
      const spec = FACTORY_SPECIALISTS[target];
      row.specialistId = target;
      row.specialistKey = spec.key;
      row.role = spec.role;
      row.threads = [...(row.threads ?? []), { specialistId: target, threadId: thread.threadId }];
      row.ombThreadId = thread.threadId;
      row.sessionId = undefined;
      row.provenSessionId = undefined;
      row.status = "bound";
      row.nextAction = pending.nextAction;
    });
    const launched = await launchFactoryTask(id, deps);
    if (!launched.task.sessionId || rejectedSessions.has(launched.task.sessionId) || launched.task.status !== "running") {
      throw new FactoryDispatchError("blocked", "refusing to reuse a session that submitted a rejected SHA", launched.task);
    }
    return { task: getFactoryTask(id)!, duplicate: launched.duplicate };
  } catch (error) {
    const blocker = error instanceof Error ? error.message : "handoff failed";
    const restored = leaveHandoffUnlaunched(id, handoffId, snapshot, blocker);
    throw new FactoryDispatchError("blocked", blocker, restored);
  }
}

/**
 * release_ready depended on review, tests, and release review recorded in
 * OMB. Those are performed outside OMB now, so this refuses without writing.
 */
export function shipFactoryTask(id: string, _raw: Record<string, unknown> = {}): FactoryTask {
  const task = getFactoryTask(id);
  if (!task) throw new FactoryDispatchError("not_found", "no such factory task");
  throw qaOutside(task, "OMB does not mark a task release_ready.");
}

export function factorySpecialistPrompt(task: FactoryTask): string {
  const handoff = [...(task.handoffs ?? [])].reverse().find((item) => item.deliveredAt);
  if (!handoff) return task.objective;
  return [
    task.objective,
    `Handoff ${handoff.stage} on factory task ${task.id}.`,
    `Repo ${handoff.repo}. Worktree ${handoff.worktree}. Branch ${task.branch ?? "unknown"}.`,
    `Server generation ${task.generation ?? 1}.`,
    `Input SHA ${handoff.inputSha}. The server reads git HEAD itself. Do not expect a reported SHA to be trusted.`,
    `From ${handoff.fromSpecialistId} to ${handoff.toSpecialistId}.`,
    handoff.summary,
    `Required evidence: ${handoff.requiredEvidence.join(", ") || "none"}.`,
    handoff.findings.length ? `Findings: ${handoff.findings.join("; ")}` : "Findings: none.",
    handoff.nextAction,
    "Stay inside this worktree. Do not merge, push, or claim the task is shipped. A ship message is not a deployment.",
  ].join("\n");
}

export interface FactoryCompletionDeps extends FactoryDeliverDeps {
  ok: boolean;
}

/**
 * Session lifecycle harvest. Identity, generation, worktree, repo, branch,
 * and HEAD come from the server. A done message is not accepted here.
 * A second completion for a thread that is no longer current does not start
 * another writer. A QA or review session is never started from here.
 */
export async function completeFactoryTurn(threadId: string, deps: FactoryCompletionDeps): Promise<{ task: FactoryTask | null; duplicate: boolean }> {
  const task = factoryTaskByThread(threadId);
  if (!task) return { task: null, duplicate: false };
  if (task.ombThreadId !== threadId) return { task, duplicate: true };
  if (isQaTask(task)) {
    // A stored QA or review session that ends is not harvested or handed on.
    if (task.status !== "running" && task.status !== "launch_intent") return { task, duplicate: true };
    const blocked = mutate(task.id, (row) => {
      row.evidence = [...row.evidence, { at: Date.now(), kind: "turn", ref: row.sessionId ?? threadId, note: "QA or review session ended; its result was not accepted" }].slice(-200);
      row.status = "blocked";
      row.blocker = QA_OUTSIDE_OMB;
      row.nextAction = QA_OUTSIDE_OMB;
    });
    return { task: blocked, duplicate: false };
  }
  if (task.status === "blocked" && task.worktree && task.writerSessionId && task.sessionId === task.writerSessionId && (task.revisions ?? []).some((item) => item.kind === "rejection")) {
    const canonical = resolveCanonical(task.worktree, task.repo);
    if (!canonical) return { task, duplicate: true };
    const reconsidered = mutate(task.id, (row) => {
      const reason = writerHeadUncertain(row, canonical.sha, true);
      if (reason) {
        row.status = "blocked";
        row.phase = "blocked";
        row.blocker = reason;
        row.nextAction = reason;
        return;
      }
      if ((row.revisions ?? []).some((item) => item.kind === "candidate" && item.sha === canonical.sha && item.sessionId === row.writerSessionId)) return;
      adoptVerifiedCandidate(row, canonical.sha, [{ at: Date.now(), kind: "commit", ref: canonical.sha, note: "server read git HEAD after the writer session ended" }]);
    });
    return { task: reconsidered, duplicate: reconsidered.status === "blocked" || reconsidered.status === "failed_closed" || reconsidered.status === "cancelled" };
  }
  if (task.status === "blocked" || task.status === "failed_closed" || task.status === "cancelled" || (task.phase && QA_PHASES.includes(task.phase))) {
    return { task, duplicate: true };
  }
  let harvested = false;
  if (task.status === "running" || task.status === "launch_intent") {
    if (!task.sessionId || !task.worktree) {
      const blocked = mutate(task.id, (row) => {
        row.status = "blocked";
        row.blocker = "completion failed closed: session or worktree binding is missing";
        row.nextAction = "blocked";
      });
      return { task: blocked, duplicate: false };
    }
    if (!deps.ok) {
      // The writer keeps its lock (blocked with writerLock "implementer").
      const blocked = mutate(task.id, (row) => {
        const canonical = resolveCanonical(row.worktree!, row.repo);
        if (canonical) {
          row.headSha = canonical.sha;
          row.branch = canonical.branch;
        }
        row.evidence = [...row.evidence, { at: Date.now(), kind: "turn", ref: row.sessionId!, note: "worker completion was not ok; SHA was not accepted" }].slice(-200);
        row.status = "blocked";
        row.blocker = "worker did not finish cleanly; SHA was not accepted";
        row.nextAction = row.blocker;
      });
      return { task: blocked, duplicate: false };
    }
    const canonical = resolveCanonical(task.worktree, task.repo);
    if (!canonical) {
      const blocked = mutate(task.id, (row) => {
        row.status = "blocked";
        row.blocker = "completion failed closed: canonical HEAD could not be read";
        row.nextAction = "blocked";
      });
      return { task: blocked, duplicate: false };
    }
    const generation = task.generation ?? 1;
    const recorded = (task.revisions ?? []).some((item) => item.kind === "implementation" && item.sessionId === task.sessionId && item.sha === canonical.sha && item.generation === generation);
    if (!recorded) {
      harvestFactoryTask(task.id, {
        sessionId: task.sessionId,
        worktree: task.worktree,
        resultSha: canonical.sha,
        evidence: [{ kind: "commit", ref: canonical.sha, note: "server read git HEAD at worker completion" }],
      }, { writerSessionEnded: true });
      harvested = true;
    }
  }
  const current = getFactoryTask(task.id)!;
  if (current.ombThreadId !== threadId) return { task: current, duplicate: true };
  const pending = [...(current.handoffs ?? [])].reverse().find((item) => !item.deliveredAt);
  // Only a same-task implementation handoff is delivered. Nothing else starts.
  if (!pending || !isImplementationHandoff(pending) || current.status === "running" || current.status === "launch_intent" || current.status === "blocked") {
    return { task: current, duplicate: !harvested && !pending };
  }
  const delivered = await deliverHandoff(current.id, deps);
  return { task: delivered.task, duplicate: delivered.duplicate };
}

export function portfolioDocument(): {
  version: 1;
  groundedIn: string[];
  goals: Array<{ id: string; objective: string; eligible: boolean; reasons: string[] }>;
  eligible: string[];
} {
  const goals = [
    {
      id: "markout-c2",
      objective: "Markout C2 stays owner-gated. Do not invent Kraken, counsel, or P0 work.",
      owner: "",
      authority: "",
      frozenTip: true,
      protectedSession: false,
      dependencies: [{ id: "owner-c2", blocked: true }],
      source: "portfolio ledger and the 2026-10-03 operating task",
    },
    {
      id: "markout-c3",
      objective: "Markout C3 stays owner-gated.",
      owner: "",
      authority: "",
      frozenTip: true,
      protectedSession: false,
      dependencies: [{ id: "owner-c3", blocked: true }],
      source: "portfolio ledger",
    },
    {
      id: "markout-c5",
      objective: "Markout C5 stays owner-gated. No host capture work.",
      owner: "",
      authority: "",
      frozenTip: true,
      protectedSession: false,
      dependencies: [{ id: "owner-c5", blocked: true }],
      source: "portfolio ledger",
    },
    {
      id: "media-lens-live",
      objective: "Media Lens LIVE_URL stays off.",
      owner: "",
      authority: "",
      frozenTip: true,
      protectedSession: false,
      dependencies: [{ id: "live-url", blocked: true }],
      source: "2026-10-03 operating task",
    },
    {
      id: "release-rescue-111",
      objective: "Release Rescue #111 stays held. Do not relabel it passed and do not do host work.",
      owner: "",
      authority: "",
      frozenTip: true,
      protectedSession: false,
      dependencies: [{ id: "rr-111-hold", blocked: true }],
      source: "2026-10-03 operating task",
    },
  ];
  const viewed = goals.map((goal) => {
    const reasons = eligibility(goal);
    return { id: goal.id, objective: goal.objective, source: goal.source, eligible: reasons.length === 0, reasons };
  });
  return {
    version: 1,
    groundedIn: [
      "docs/factory-lanes.md",
      "docs/factory-onboarding.md",
      "Portfolio ledger: Markout C2/C3/C5 owner-gated",
      "Operating task 2026-10-03: LIVE_URL stays off; Release Rescue #111 stays held",
    ],
    goals: viewed,
    eligible: viewed.filter((goal) => goal.eligible).map((goal) => goal.id),
  };
}

export const FACTORY_ONBOARDING = `# Software factory onboarding

The store is the OpenMausBot app (\`DATA_DIR/factory-tasks.json\`, loopback API \`/api/factory\`). A directory outside the app is not a second source of truth.

## Scope

OMB handles task intake and implementation dispatch only. QA and independent review are performed outside OMB. OMB does not launch QA, assign a QA or review specialist, record a QA disposition (CLEAR, KEEP_DRAFT, NOT_CLEAR), or mark a task release_ready. OMB does not provide a QA worktree, a read-only review snapshot, or QA isolation.

Every QA entry point that is still routed rejects with the error code \`qa_outside_omb\` (HTTP 410) and starts nothing: a QA, review, test, or release specialist at intake, a QA intake field (\`qaOfTaskId\`, \`headSha\`, \`prUrl\`, \`qaDisposition\`, \`reviewedSha\`, \`reviewerId\`, \`testerId\`, \`releaseId\`, \`remediationLimit\`), a harvest that carries a QA disposition or reviewed SHA, a launch, harvest, or turn on a stored QA or review task, a delivery of a stored review, test, or release handoff, a wait into \`waiting_qa\`, and the ship gate.

A stored task in \`waiting_qa\` or another QA state still loads. It keeps its worktree reservation and nothing starts QA from it. Cancel it to release the repository.

## Seats

Seven specialist ids are registered in the app. Only the Software Implementer is dispatched. Coding seats use catalog Claude Opus 5.5 (\`claude-opus-5-5\`). That is not another product name. Fable (\`claude-fable-5-1\`) is advisor-only and is not an implementer. Finch stays and is not a specialist.

Permissions are Auto only. \`bypassPermissions\` and Full are rejected. The implementer writes only inside the task worktree: the Claude spawn and a PreToolUse hook fail closed outside it, and the implementer cannot push or merge. If that fence cannot be applied, the role is marked unavailable and dispatch is blocked.

## How a task starts

1. Intake: objective, implementer specialist id, model, permissions, repo, base SHA, acceptance, dependencies, required evidence, owner, authority.
2. Missing owner, unclear authority, a protected session, a frozen tip, or a blocked dependency does not create a worktree. A repository that already has a writer is refused.
3. The app creates an isolated git worktree and stores the task-to-worktree binding before any worker turn. It does not use the bot's global folder as the pin.
4. Launch stores the Claude session id on that same task, then starts the turn. Status becomes running only after both are stored. A second launch returns the binding and does not start another writer.
5. Quiet waits (\`waiting_ci\`, \`waiting_owner\`, \`waiting_external\`) keep the worktree reserved.
6. On worker completion the server reads the task, specialist, session, generation, canonical worktree, repository, branch, and git HEAD. An agent SHA or a done message is not the result. A mismatched SHA is stored as a rejected revision and is never adopted. When the implementer session ends and still holds the exclusive writer lock, the server verifies that binding, a clean worktree, actual HEAD, and ancestry from the recorded base and from the writer's starting SHA, then stores an immutable candidate (generation, writer session, SHA, tree, worktree, and the verification evidence). That sealed SHA is the task result and the task is harvested. A desk harvest during the writer session records evidence only. If the worktree is dirty, HEAD does not descend, or provenance cannot be proved, the task stays blocked and keeps its writer lock.
7. Restart resumes only when the stored session id was proven and the worktree still matches. Otherwise the task stays blocked. A stored QA or review session is not resumed.

## Same-task handoffs

A stored implementation handoff (stage \`remediate\`, to the implementer) is still delivered on the same task id after the previous turn ends and the writer lock is held by the implementer. It is stored before the next session starts, a retry does not start a second worker, a failed start leaves it undelivered, and a session that submitted a rejected SHA is not reused.

## Out of scope

Markout C2/C3/C5, Media Lens live URL, and Release Rescue host work stay ineligible. Do not open a non-loopback listener.
`;
