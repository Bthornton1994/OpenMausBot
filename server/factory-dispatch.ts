// Software-factory tasks. This file is the store (DATA_DIR/factory-tasks.json).
// A task is not running until its worktree and Claude session id are both
// on disk. A second launch returns that binding or fails closed. Reviewer
// seats that this process cannot fence are marked unavailable and are not
// dispatched.

import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { newId } from "./contracts.ts";
import {
  FACTORY_ENGINE_MODEL,
  FACTORY_SPECIALISTS,
  QA_DISPOSITIONS,
  REVIEWER_DISALLOWED_TOOLS,
  factoryRole,
  isFactorySpecialistId,
  isReadOnlyFactoryRole,
  type FactoryRole,
  type FactorySpecialistId,
  type QaEvidenceDisposition,
} from "./factory-boundary.ts";

export const IMPLEMENTER_ID = "063c67ac-f8ca-4c05-b6b8-e3bbf2e102a7" as const;
export const REVIEWER_ID = "223e5e26-37e4-42e3-9026-5983b66a17aa" as const;
export const TESTER_ID = "1872d149-0be3-42c6-9218-3ea7d56609a4" as const;
export const RELEASE_ID = "bb034770-3b5a-44de-9ffe-1d851a093afe" as const;

export const PIPELINE_PHASES = ["implement", "review", "remediate", "test", "release", "ship", "shipped", "blocked"] as const;
export type PipelinePhase = (typeof PIPELINE_PHASES)[number];

export interface FactoryCheck {
  name: string;
  result: string;
  sha: string;
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
  qaDisposition?: QaEvidenceDisposition;
  reviewedSha?: string;
  qaOfTaskId?: string;
  blocker?: string;
  nextAction?: string;
  dispatchKey?: string;
  owner?: string;
  authority?: string;
  /** Pipeline seats. The task id does not change when the seat changes. */
  implementerId?: FactorySpecialistId;
  assignedReviewerId?: FactorySpecialistId;
  assignedTesterId?: FactorySpecialistId;
  assignedReleaseId?: FactorySpecialistId;
  phase?: PipelinePhase;
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
  | "blocked";

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

function holdsWriterLock(task: FactoryTask): boolean {
  return task.role === "implementer" && HOLDS_LOCK.includes(task.status);
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

export function createFactoryTask(raw: Record<string, unknown>, deps: FactoryCreateDeps): { task: FactoryTask; duplicate: boolean } {
  const permissions = parseFactoryPermissions(raw.permissions ?? raw.approvalMode);
  const specialistId = raw.specialistId;
  if (!isFactorySpecialistId(specialistId)) {
    throw new FactoryDispatchError("invalid", "specialist is not a registered factory id");
  }
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
  if (spec.role === "implementer") {
    const writer = load().tasks.find((task) => holdsWriterLock(task) && task.repo === repo);
    if (writer) {
      throw new FactoryDispatchError("conflict", `repository already has writer ${writer.id}`, writer);
    }
  }
  if (spec.role === "qa") {
    const of = typeof raw.qaOfTaskId === "string" ? raw.qaOfTaskId : "";
    const target = of ? getFactoryTask(of) : undefined;
    if (!target || target.role !== "implementer" || !target.resultSha) {
      throw new FactoryDispatchError("invalid", "QA requires the implementer task and its result SHA");
    }
    if (target.specialistId === specialistId) {
      throw new FactoryDispatchError("invalid", "QA must be a different specialist from the implementer");
    }
    if (baseSha.toLowerCase() !== target.resultSha.toLowerCase()) {
      throw new FactoryDispatchError("invalid", "QA must review the exact result SHA");
    }
  }

  const now = (deps.now ?? Date.now)();
  const id = newId();
  const worktree = join(DATA_DIR, "factory-worktrees", id);
  createWorktree(repo, baseSha, worktree);
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
    ...(dispatchKey ? { dispatchKey } : {}),
    ...(spec.role === "qa" && typeof raw.qaOfTaskId === "string" ? { qaOfTaskId: raw.qaOfTaskId } : {}),
    ...(spec.role === "implementer" ? pipelineSeat(raw, specialistId) : {}),
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
  const sessionId = randomUUID();
  const intent = mutate(id, (row) => {
    row.sessionId = sessionId;
    row.status = "launch_intent";
    row.nextAction = "start turn";
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
  qaDisposition?: unknown;
  reviewedSha?: unknown;
  blocker?: unknown;
  nextAction?: unknown;
  findings?: unknown;
  checkResults?: unknown;
}

export function harvestFactoryTask(id: string, raw: FactoryHarvestInput): FactoryTask {
  const task = getFactoryTask(id);
  if (!task) throw new FactoryDispatchError("not_found", "no such factory task");
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
  const findings = parseFindings(raw.findings);
  const checkResults = parseCheckResults(raw.checkResults);
  let qaDisposition: QaEvidenceDisposition | undefined;
  const exactSha = (task.resultSha ?? task.baseSha).toLowerCase();
  if (raw.qaDisposition !== undefined) {
    if (task.implementerId && task.specialistId === task.implementerId) {
      throw new FactoryDispatchError("invalid", "the implementer cannot clear QA or its own implementation");
    }
    if (task.assignedReviewerId && task.specialistId !== task.assignedReviewerId) {
      throw new FactoryDispatchError("invalid", "only the assigned independent reviewer can record a QA disposition");
    }
    if (task.role !== "qa") {
      throw new FactoryDispatchError("invalid", "only Independent QA can record a disposition; the implementer cannot clear QA");
    }
    if (typeof raw.qaDisposition !== "string" || !(QA_DISPOSITIONS as readonly string[]).includes(raw.qaDisposition)) {
      throw new FactoryDispatchError("invalid", "QA disposition must be CLEAR, KEEP_DRAFT, or NOT_CLEAR");
    }
    if (typeof raw.reviewedSha !== "string" || raw.reviewedSha.toLowerCase() !== exactSha) {
      throw new FactoryDispatchError("mismatch", "QA must review the exact SHA");
    }
    qaDisposition = raw.qaDisposition as QaEvidenceDisposition;
  }
  const checks = raw.checks === undefined ? task.checks : Array.isArray(raw.checks) && raw.checks.every((item) => typeof item === "string")
    ? raw.checks.map((item) => item.slice(0, 500))
    : (() => { throw new FactoryDispatchError("invalid", "checks must be a list of strings"); })();
  const resultSha = (raw.resultSha as string).toLowerCase();
  return mutate(id, (row) => {
    row.resultSha = resultSha;
    row.evidence = [...row.evidence, ...evidence].slice(-200);
    row.checks = checks;
    if (checkResults.length) row.checkResults = [...(row.checkResults ?? []), ...checkResults].slice(-100);
    if (qaDisposition) {
      row.qaDisposition = qaDisposition;
      row.reviewedSha = exactSha;
      row.reviewSha = exactSha;
    }
    if (typeof raw.blocker === "string") row.blocker = raw.blocker.trim().slice(0, 500) || undefined;
    if (row.implementerId && !row.qaOfTaskId) {
      advancePipeline(row, { findings, resultSha, qaDisposition, checkResults });
      return;
    }
    if (typeof raw.nextAction === "string" && raw.nextAction.trim()) row.nextAction = raw.nextAction.trim().slice(0, 500);
    else row.nextAction = qaDisposition ? "evidence only; no merge" : "waiting";
    row.status = row.role === "implementer" && !qaDisposition ? "waiting_qa" : "harvested";
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
  if (task.status === "blocked" || task.status === "failed_closed" || task.status === "cancelled") {
    throw new FactoryDispatchError("blocked", task.blocker || "factory task is blocked");
  }
  if (task.status !== "launch_intent" && task.status !== "running") {
    throw new FactoryDispatchError("blocked", "factory turn refused before launch intent was stored");
  }
  if (!task.sessionId || !task.worktree) {
    throw new FactoryDispatchError("blocked", "factory turn refused without a stored binding");
  }
  const seat = task.threads?.find((row) => row.threadId === threadId);
  const specialistId = seat?.specialistId ?? task.specialistId;
  const role = isFactorySpecialistId(specialistId) ? factoryRole(specialistId) : task.role;
  if (role === "implementer" && task.writerLock && task.writerLock !== "implementer") {
    throw new FactoryDispatchError("blocked", "remediation waits until the reviewer turn ends and the lock transfers");
  }
  if (task.ombThreadId && task.ombThreadId !== threadId && (task.status === "running" || task.status === "launch_intent")) {
    throw new FactoryDispatchError("blocked", "this specialist turn has ended");
  }
  return {
    sessionId: task.sessionId,
    worktree: task.worktree,
    role,
    disallowedTools: isReadOnlyFactoryRole(role) ? [...REVIEWER_DISALLOWED_TOOLS] : [],
  };
}


function defaultRemediationLimit(): number {
  const raw = Number(process.env.OMB_FACTORY_REMEDIATION_LIMIT ?? "2");
  if (!Number.isInteger(raw) || raw < 1 || raw > 20) return 2;
  return raw;
}

function specialistOr(value: unknown, fallback: FactorySpecialistId, label: string): FactorySpecialistId {
  if (value === undefined) return fallback;
  if (!isFactorySpecialistId(value)) throw new FactoryDispatchError("invalid", `${label} is not a registered specialist`);
  return value;
}

function pipelineSeat(raw: Record<string, unknown>, implementerId: FactorySpecialistId): Pick<FactoryTask, "implementerId" | "assignedReviewerId" | "assignedTesterId" | "assignedReleaseId" | "phase" | "writerLock" | "handoffs" | "findings" | "checkResults" | "remediationCount" | "remediationLimit"> {
  const reviewer = specialistOr(raw.reviewerId, REVIEWER_ID, "reviewerId");
  const tester = specialistOr(raw.testerId, TESTER_ID, "testerId");
  const release = specialistOr(raw.releaseId, RELEASE_ID, "releaseId");
  if (new Set([implementerId, reviewer, tester, release]).size < 4) {
    throw new FactoryDispatchError("invalid", "implementer, reviewer, tester, and release reviewer must be different specialists");
  }
  const limit = raw.remediationLimit === undefined ? defaultRemediationLimit() : raw.remediationLimit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new FactoryDispatchError("invalid", "remediationLimit must be an integer from 1 to 20");
  }
  return {
    implementerId,
    assignedReviewerId: reviewer,
    assignedTesterId: tester,
    assignedReleaseId: release,
    phase: "implement",
    writerLock: "implementer",
    handoffs: [],
    findings: [],
    checkResults: [],
    remediationCount: 0,
    remediationLimit: limit,
  };
}

function parseFindings(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new FactoryDispatchError("invalid", "findings must be a list of strings");
  }
  return value.map((item) => item.trim().slice(0, 500));
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

function invalidateReview(row: FactoryTask, sha: string): void {
  row.qaDisposition = undefined;
  row.reviewedSha = undefined;
  row.reviewSha = undefined;
  row.testSha = undefined;
  row.releaseSha = undefined;
  row.findings = [];
  row.checkResults = (row.checkResults ?? []).filter((check) => check.sha === sha);
  row.phase = "review";
  row.nextAction = `fresh review and tests required: SHA changed to ${sha}`;
}

function pushHandoff(row: FactoryTask, handoff: Omit<FactoryHandoff, "id" | "taskId" | "createdAt">): void {
  const key = `${handoff.stage}:${handoff.resultSha}:${handoff.toSpecialistId}`;
  const existing = (row.handoffs ?? []).find((item) => `${item.stage}:${item.resultSha}:${item.toSpecialistId}` === key && !item.deliveredAt);
  if (existing) return;
  row.handoffs = [...(row.handoffs ?? []), { ...handoff, id: newId(), taskId: row.id, createdAt: Date.now() }];
}

function advancePipeline(row: FactoryTask, input: { findings: string[]; resultSha: string; qaDisposition?: QaEvidenceDisposition; checkResults: FactoryCheck[] }): void {
  const worktree = row.worktree ?? "";
  const from = row.specialistId;
  if (!row.evidence.length) {
    row.status = "blocked";
    row.phase = "blocked";
    row.blocker = "missing evidence";
    row.nextAction = "blocked: missing evidence";
    return;
  }
  if (row.phase === "implement" || row.phase === "remediate") {
    if (row.reviewSha && row.reviewSha !== input.resultSha) invalidateReview(row, input.resultSha);
    row.writerLock = "review";
    row.phase = "review";
    row.status = "waiting_qa";
    row.findings = [];
    row.nextAction = "independent review";
    pushHandoff(row, {
      stage: "review",
      repo: row.repo,
      worktree,
      inputSha: row.baseSha,
      resultSha: input.resultSha,
      fromSpecialistId: from,
      toSpecialistId: row.assignedReviewerId!,
      summary: `Implementation ${input.resultSha.slice(0, 12)} is ready for independent review`,
      requiredEvidence: ["review"],
      checks: input.checkResults,
      findings: [],
      nextAction: "independent review of the exact SHA",
    });
    return;
  }
  if (row.phase === "review" || row.specialistId === row.assignedReviewerId) {
    row.findings = input.findings;
    row.reviewSha = input.resultSha;
    if (input.findings.length) {
      const limit = row.remediationLimit ?? defaultRemediationLimit();
      const used = row.remediationCount ?? 0;
      if (used >= limit) {
        row.status = "blocked";
        row.phase = "blocked";
        row.writerLock = "none";
        row.blocker = `remediation limit ${limit} reached`;
        row.nextAction = "CoS decision needed: remediation limit reached";
        return;
      }
      row.remediationCount = used + 1;
      row.writerLock = "implementer";
      row.phase = "remediate";
      row.status = "waiting_qa";
      row.nextAction = "remediate on a new implementation session";
      pushHandoff(row, {
        stage: "remediate",
        repo: row.repo,
        worktree,
        inputSha: input.resultSha,
        resultSha: input.resultSha,
        fromSpecialistId: from,
        toSpecialistId: row.implementerId!,
        summary: input.findings.join("; ").slice(0, 500),
        requiredEvidence: row.requiredEvidence,
        checks: row.checkResults ?? [],
        findings: input.findings,
        nextAction: "fix the finding, then a fresh review is required if the SHA changes",
      });
      return;
    }
    row.writerLock = "none";
    row.phase = "test";
    row.status = "waiting_qa";
    row.nextAction = "test the reviewed SHA";
    pushHandoff(row, {
      stage: "test",
      repo: row.repo,
      worktree,
      inputSha: input.resultSha,
      resultSha: input.resultSha,
      fromSpecialistId: from,
      toSpecialistId: row.assignedTesterId!,
      summary: `Review recorded ${input.qaDisposition ?? "no disposition"} for ${input.resultSha.slice(0, 12)}`,
      requiredEvidence: ["test"],
      checks: row.checkResults ?? [],
      findings: [],
      nextAction: "tester verifies this exact SHA",
    });
    return;
  }
  if (row.phase === "test" || row.specialistId === row.assignedTesterId) {
    if (!input.checkResults.length) {
      row.status = "blocked";
      row.phase = "blocked";
      row.blocker = "missing evidence: tester checks";
      row.nextAction = "blocked: missing evidence";
      return;
    }
    if (input.checkResults.some((check) => check.sha !== input.resultSha) || row.reviewSha !== input.resultSha) {
      invalidateReview(row, input.resultSha);
      row.status = "blocked";
      row.blocker = `stale SHA: tests do not match reviewed SHA ${row.reviewSha ?? "none"}`;
      row.nextAction = "fresh review and tests required";
      return;
    }
    row.testSha = input.resultSha;
    row.phase = "release";
    row.writerLock = "none";
    row.status = "waiting_qa";
    row.nextAction = "release review";
    pushHandoff(row, {
      stage: "release",
      repo: row.repo,
      worktree,
      inputSha: input.resultSha,
      resultSha: input.resultSha,
      fromSpecialistId: from,
      toSpecialistId: row.assignedReleaseId!,
      summary: `Tests recorded for ${input.resultSha.slice(0, 12)}`,
      requiredEvidence: ["release"],
      checks: input.checkResults,
      findings: row.findings ?? [],
      nextAction: "release reviewer records the outcome; a ship message is not authorization",
    });
    return;
  }
  if (row.phase === "release" || row.specialistId === row.assignedReleaseId) {
    if (row.testSha !== input.resultSha || row.reviewSha !== input.resultSha) {
      invalidateReview(row, input.resultSha);
      row.status = "blocked";
      row.blocker = "stale SHA: release review does not match tested SHA";
      row.nextAction = "fresh review and tests required";
      return;
    }
    row.releaseSha = input.resultSha;
    row.phase = "release";
    row.status = "harvested";
    row.writerLock = "none";
    row.nextAction = "ship only when the repo gate authorizes this exact SHA";
  }
}

export interface FactoryDeliverDeps extends FactoryLaunchDeps {
  bot: (id: string) => FactoryBot | null;
  createThread: (botId: string, title: string) => { threadId: string };
  pinCwd: (botId: string, threadId: string, cwd: string) => void;
}

/** Starts the specialist named on the newest undelivered handoff. A retry returns that handoff and does not start another worker. */
export async function deliverHandoff(id: string, deps: FactoryDeliverDeps): Promise<{ task: FactoryTask; duplicate: boolean }> {
  const task = getFactoryTask(id);
  if (!task) throw new FactoryDispatchError("not_found", "no such factory task");
  const pending = [...(task.handoffs ?? [])].reverse().find((item) => !item.deliveredAt);
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
    });
    throw new FactoryDispatchError("role_unavailable", `specialist ${target} is unavailable`, blocked);
  }
  if (pending.stage === "remediate" && task.writerLock !== "implementer") {
    throw new FactoryDispatchError("blocked", "remediation waits until the reviewer turn ends and the lock transfers", task);
  }
  // The handoff record is durable before the next specialist is started.
  mutate(id, (row) => {
    const handoff = row.handoffs?.find((item) => item.id === pending.id);
    if (handoff && !handoff.deliveredAt) handoff.deliveredAt = Date.now();
  });
  const stored = getFactoryTask(id)!;
  const marked = stored.handoffs?.find((item) => item.id === pending.id);
  if (!marked?.deliveredAt) throw new FactoryDispatchError("blocked", "handoff was not stored", stored);
  try {
    const thread = deps.createThread(target, `${pending.stage}: ${task.objective}`.slice(0, 80));
    deps.pinCwd(target, thread.threadId, task.worktree!);
    mutate(id, (row) => {
      const spec = FACTORY_SPECIALISTS[target];
      row.specialistId = target;
      row.specialistKey = spec.key;
      row.role = spec.role;
      row.threads = [...(row.threads ?? []), { specialistId: target, threadId: thread.threadId }];
      row.ombThreadId = thread.threadId;
      if (row.sessionId) row.evidence = row.evidence;
      row.sessionId = undefined;
      row.provenSessionId = undefined;
      row.status = "bound";
      row.nextAction = pending.nextAction;
    });
  } catch (error) {
    mutate(id, (row) => {
      const handoff = row.handoffs?.find((item) => item.id === pending.id);
      if (handoff && !row.sessionId) handoff.deliveredAt = undefined;
      row.status = "blocked";
      row.blocker = error instanceof Error ? error.message : "handoff failed";
    });
    throw error;
  }
  return launchFactoryTask(id, deps);
}

export function releaseGateAuthorizes(worktree: string, sha: string): { ok: boolean; reason: string } {
  const gate = join(worktree, ".omb", "release-gate");
  if (!existsSync(gate)) return { ok: false, reason: `release gate did not authorize ${sha}: .omb/release-gate is missing` };
  const result = spawnSync(gate, [sha], { cwd: worktree, encoding: "utf8" });
  const out = (result.stdout ?? "").trim();
  if (result.status !== 0 || out !== sha) {
    return { ok: false, reason: `release gate did not authorize ${sha}` };
  }
  return { ok: true, reason: "" };
}

/** Ship is the repo gate for this exact SHA. A message, admin flag, or bypass is rejected. */
export function shipFactoryTask(id: string, raw: Record<string, unknown> = {}): FactoryTask {
  if ("message" in raw || "ship" in raw || raw.admin === true || raw.bypass === true || raw.approvalMode === "full") {
    throw new FactoryDispatchError("invalid", "an agent ship message is not authorization, and there is no admin bypass");
  }
  const task = getFactoryTask(id);
  if (!task) throw new FactoryDispatchError("not_found", "no such factory task");
  if (!task.resultSha || !task.worktree) {
    throw new FactoryDispatchError("blocked", "missing evidence", task);
  }
  if (task.reviewSha !== task.resultSha || task.testSha !== task.resultSha || task.releaseSha !== task.resultSha) {
    const blocked = mutate(id, (row) => {
      row.status = "blocked";
      row.phase = "blocked";
      row.blocker = "release gate blocked: review, tests, and release review must match the exact SHA";
      row.nextAction = "fresh review and tests required";
    });
    throw new FactoryDispatchError("blocked", blocked.blocker ?? "release gate blocked", blocked);
  }
  const gate = releaseGateAuthorizes(task.worktree, task.resultSha);
  if (!gate.ok) {
    const blocked = mutate(id, (row) => {
      row.status = "blocked";
      row.phase = "blocked";
      row.blocker = gate.reason;
      row.nextAction = "CoS decision needed: release gate blocked";
    });
    throw new FactoryDispatchError("blocked", gate.reason, blocked);
  }
  return mutate(id, (row) => {
    row.phase = "shipped";
    row.status = "harvested";
    row.blocker = undefined;
    row.nextAction = `shipped ${row.resultSha}`;
    row.evidence = [...row.evidence, { at: Date.now(), kind: "gate", ref: row.resultSha!, note: "repo gate authorized this SHA" }];
  });
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

## Seats

Seven specialist ids are registered in the app. Coding seats use catalog Claude Opus 5.5 (\`claude-opus-5-5\`). That is not another product name. Fable (\`claude-fable-5-1\`) is advisor-only and is not an implementer. Finch stays and is not a specialist.

Permissions are Auto only. \`bypassPermissions\` and Full are rejected. Read-only seats (navigator, security, UI, game, QA, release) cannot edit files or submit implementation changes: the Claude spawn disallows those tools and a PreToolUse hook fails closed. The implementer writes only inside the task worktree. If that fence cannot be applied, the role is marked unavailable and dispatch is blocked.

## How a task starts

1. Intake: objective, specialist id, model, permissions, repo, base SHA, acceptance, dependencies, required evidence, owner, authority.
2. Missing owner, unclear authority, a protected session, a frozen tip, or a blocked dependency does not create a worktree.
3. The app creates an isolated git worktree and stores the task-to-worktree binding before any worker turn. It does not use the bot's global folder as the pin.
4. Launch stores the Claude session id on that same task, then starts the turn. Status becomes running only after both are stored. A second launch returns the binding and does not start another writer.
5. Quiet waits (\`waiting_ci\`, \`waiting_qa\`, \`waiting_owner\`, \`waiting_external\`) keep the worktree reserved.
6. Harvest writes the result SHA, evidence, checks, blocker, and next action on the same task. A session or worktree mismatch, or missing evidence, is rejected. CLEAR, KEEP_DRAFT, and NOT_CLEAR are evidence only. The implementer cannot record them. QA is a different specialist and reviews the exact SHA. Nothing is merged.
7. Restart resumes only when the stored session id was proven and the worktree still matches. Otherwise the task stays blocked.

## Same-task pipeline

An implementer task hands off on that same task id: independent review, remediation if the reviewer records findings, test, then release review. Each handoff is stored before the next specialist starts (task, repo, worktree, input SHA, result SHA, both specialist ids, summary, required evidence, checks, findings, next action). A retry sees the stored handoff and does not start a second worker.

The implementer writes only in the assigned worktree. Reviewers and testers cannot edit files. Remediation returns to the implementer only after the reviewer turn ends and the writer lock transfers. A changed SHA invalidates the review and requires a fresh review and tests. The implementer cannot clear its own work. Only the assigned Independent QA specialist records a disposition.

Remediation stops at the configured limit (default 2). Evidence stays, the task is blocked, and the next action names the CoS decision. Other tasks can continue on other worktrees. Ship runs the repo's \`.omb/release-gate\` for that exact SHA. An agent message, admin flag, or bypass is not authorization. Missing evidence, a wrong SHA, or an unavailable specialist blocks the task with that reason.

## Out of scope

Markout C2/C3/C5, Media Lens live URL, and Release Rescue host work stay ineligible. Do not open a non-loopback listener.
`;
