// Software-factory tasks. This file is the store (DATA_DIR/factory-tasks.json).
// A task is not running until its worktree and Claude session id are both
// on disk. A second launch returns that binding or fails closed. Reviewer
// seats that this process cannot fence are marked unavailable and are not
// dispatched.

import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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

export const PIPELINE_PHASES = ["implement", "review", "remediate", "test", "release", "release_ready", "ship", "shipped", "blocked"] as const;
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
  disposition?: QaEvidenceDisposition;
  createdAt: number;
}

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
  /** Server binding. A revision's sha is not this field and is never edited. */
  generation?: number;
  branch?: string;
  headSha?: string;
  revisions?: FactoryRevision[];
  /** Session that last received the writer lock, and HEAD at that moment. */
  writerSessionId?: string;
  writerShaAtAssign?: string;
  /** QA-only review: no implementer task. The worktree is the exact head SHA. */
  qaOnly?: boolean;
  /** Checkout mode 0555/0444. Git metadata stays in the common dir. */
  readOnlyWorktree?: boolean;
  prUrl?: string;
  /** One record per QA session. A rejected submission is not rewritten here. */
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
  /** Current PR head. Required before launch when the task has a prUrl. */
  prHead?: (prUrl: string) => string | null | Promise<string | null>;
}

const SHA = /^[0-9a-f]{40}$/i;
const PR_URL = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)\/?$/;
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

function commitExists(repo: string, sha: string): boolean {
  if (!SHA.test(sha)) return false;
  const result = git(["-C", repo, "cat-file", "-t", sha]);
  return result.ok && result.stdout.trim() === "commit";
}

/** Review checkout. Git metadata stays in the common dir, so rev-parse still works. */
function lockWorktreeReadOnly(dest: string): void {
  // Permission changes wait until every symlink resolves inside this worktree.
  // lstat and readlink do not follow a link onto its target, and chmod is never
  // given a symlink path (it would). Write bits drop; the executable bit git
  // uses for 100644 vs 100755 stays. .git is not traversed: a linked worktree
  // stores a gitdir pointer there, and following it would leave the checkout.
  const rootInfo = lstatSync(dest);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new FactoryDispatchError("invalid", "worktree root is not a real directory");
  }
  const root = resolve(dest);
  const pending: string[] = [];
  const fail = (message: string): never => {
    throw new FactoryDispatchError("invalid", message);
  };
  const contained = (candidate: string): boolean => {
    const rel = relative(root, candidate);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  };
  const aboveRoot = (candidate: string): boolean => {
    if (candidate === sep) return root !== sep;
    const prefix = candidate.endsWith(sep) ? candidate : `${candidate}${sep}`;
    return root.startsWith(prefix);
  };
  const readLinkText = (linkPath: string): string => {
    try {
      const text = readlinkSync(linkPath);
      if (!text) return fail("unresolved symlink path");
      return text;
    } catch (error) {
      if (error instanceof FactoryDispatchError) throw error;
      return fail("unresolved symlink path");
    }
  };
  const lstatOr = (path: string, message: string): Stats => {
    try {
      return lstatSync(path);
    } catch {
      return fail(message);
    }
  };
  const resolveSymlink = (linkPath: string, stack: readonly string[]): string => {
    if (stack.includes(linkPath)) fail("symlink cycle");
    return walkLink(readLinkText(linkPath), dirname(linkPath), [...stack, linkPath]);
  };
  const walkLink = (text: string, baseDir: string, stack: readonly string[]): string => {
    if (!isAbsolute(text) && !contained(baseDir)) fail("symlink escapes the worktree");
    let current = isAbsolute(text) ? sep : baseDir;
    for (const part of text.split(sep)) {
      if (part === "" || part === ".") continue;
      if (part === "..") {
        if (!contained(current) || current === root) fail("symlink escapes the worktree");
        current = dirname(current);
        continue;
      }
      const next = join(current, part);
      if (!contained(next)) {
        if (aboveRoot(next)) {
          current = next;
          continue;
        }
        fail("symlink escapes the worktree");
      }
      const info = lstatOr(next, "unresolved symlink path");
      if (info.isSymbolicLink()) {
        current = resolveSymlink(next, stack);
        if (!contained(current)) fail("symlink escapes the worktree");
        continue;
      }
      current = next;
    }
    if (!contained(current)) fail("symlink escapes the worktree");
    return current;
  };
  const visit = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return fail("unresolved worktree path");
    }
    for (const name of names) {
      const path = join(dir, name);
      const info = lstatOr(path, "unresolved worktree path");
      if (info.isSymbolicLink()) {
        resolveSymlink(path, []);
        continue;
      }
      if (name === ".git") {
        pending.push(path);
        continue;
      }
      if (info.isDirectory()) {
        visit(path);
        pending.push(path);
        continue;
      }
      if (info.isFile()) {
        pending.push(path);
        continue;
      }
      fail("unsupported worktree entry");
    }
  };
  visit(root);
  pending.push(root);
  const modes: { path: string; mode: number }[] = [];
  for (const path of pending) {
    const info = lstatOr(path, "unresolved worktree path");
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) fail("unresolved worktree path");
    modes.push({ path, mode: info.mode & 0o777 & ~0o222 });
  }
  for (const item of modes) chmodSync(item.path, item.mode);
}

function githubPrHead(prUrl: string): string | null {
  const match = PR_URL.exec(prUrl.trim());
  if (!match) return null;
  const result = spawnSync("gh", ["pr", "view", match[3], "--repo", `${match[1]}/${match[2]}`, "--json", "headRefOid"], {
    encoding: "utf8",
    timeout: 15_000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout) as { headRefOid?: unknown };
    const sha = typeof parsed.headRefOid === "string" ? parsed.headRefOid.trim().toLowerCase() : "";
    return SHA.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

function rememberQaAttempt(row: FactoryTask, sessionId: string, sha: string, handoffId?: string): void {
  if (!sessionId || !SHA.test(sha)) return;
  if ((row.qaAttempts ?? []).some((item) => item.sessionId === sessionId && item.sha === sha)) return;
  row.qaAttempts = [...(row.qaAttempts ?? []), {
    sessionId,
    sha,
    ...(handoffId ? { handoffId } : {}),
    createdAt: Date.now(),
  }];
}

function worktreeMatches(task: FactoryTask): boolean {
  if (!task.worktree || !existsSync(task.worktree)) return false;
  const head = git(["-C", task.worktree, "rev-parse", "--is-inside-work-tree"]);
  return head.ok && head.stdout.trim() === "true";
}

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
  let qaOnly = false;
  let reviewHead = "";
  let prUrl: string | undefined;
  if (spec.role === "qa") {
    const of = typeof raw.qaOfTaskId === "string" ? raw.qaOfTaskId.trim() : "";
    if (of) {
      const target = getFactoryTask(of);
      if (!target || target.role !== "implementer" || !target.resultSha) {
        throw new FactoryDispatchError("invalid", "QA requires the implementer task and its result SHA");
      }
      if (target.specialistId === specialistId) {
        throw new FactoryDispatchError("invalid", "QA must be a different specialist from the implementer");
      }
      if (baseSha.toLowerCase() !== target.resultSha.toLowerCase()) {
        throw new FactoryDispatchError("invalid", "QA must review the exact result SHA");
      }
    } else if (typeof raw.headSha === "string" && raw.headSha.trim()) {
      reviewHead = raw.headSha.trim().toLowerCase();
      if (!SHA.test(reviewHead)) throw new FactoryDispatchError("invalid", "headSha must be a full 40-hex commit");
      if (!commitExists(repo, baseSha.toLowerCase()) || !commitExists(repo, reviewHead)) {
        throw new FactoryDispatchError("invalid", "baseSha and headSha must be commits in the repo");
      }
      if (!descendsFrom(repo, baseSha.toLowerCase(), reviewHead)) {
        throw new FactoryDispatchError("invalid", "head SHA must descend from the pinned base SHA");
      }
      if (raw.prUrl !== undefined && raw.prUrl !== "") {
        if (typeof raw.prUrl !== "string" || !PR_URL.test(raw.prUrl.trim())) {
          throw new FactoryDispatchError("invalid", "prUrl must be an https GitHub pull request URL");
        }
        prUrl = raw.prUrl.trim();
      }
      qaOnly = true;
    } else {
      throw new FactoryDispatchError("invalid", "QA requires the implementer task and its result SHA");
    }
  }

  const now = (deps.now ?? Date.now)();
  const id = newId();
  const worktree = join(DATA_DIR, "factory-worktrees", id);
  const checkout = qaOnly ? reviewHead : baseSha;
  createWorktree(repo, checkout, worktree);
  if (qaOnly) lockWorktreeReadOnly(worktree);
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
    ...(qaOnly ? { headSha: reviewHead } : bound?.sha ? { headSha: bound.sha } : {}),
    ...(dispatchKey ? { dispatchKey } : {}),
    ...(spec.role === "qa" && typeof raw.qaOfTaskId === "string" && raw.qaOfTaskId.trim() ? { qaOfTaskId: raw.qaOfTaskId.trim() } : {}),
    ...(qaOnly ? {
      qaOnly: true as const,
      readOnlyWorktree: true as const,
      writerLock: "none" as const,
      phase: "review" as const,
      ...(prUrl ? { prUrl } : {}),
    } : {}),
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
  if (task.prUrl) {
    const resolved = deps.prHead ? await deps.prHead(task.prUrl) : githubPrHead(task.prUrl);
    const actual = typeof resolved === "string" ? resolved.trim().toLowerCase() : "";
    if (!SHA.test(actual) || !task.headSha || actual !== task.headSha.toLowerCase()) {
      const reason = SHA.test(actual)
        ? `PR head is ${actual}; create a task targeting that exact SHA`
        : "PR head could not be revalidated; create a task targeting the exact SHA";
      const blocked = mutate(id, (row) => {
        row.status = "blocked";
        row.blocker = reason;
        row.nextAction = reason;
        row.sessionId = undefined;
      });
      throw new FactoryDispatchError("blocked", reason, blocked);
    }
  }
  if (task.qaOnly) {
    const expected = task.headSha ?? "";
    const head = task.worktree ? git(["-C", task.worktree, "rev-parse", "HEAD"]) : { ok: false, stdout: "" };
    const actual = head.ok ? head.stdout.trim().toLowerCase() : "";
    if (!SHA.test(expected) || actual !== expected) {
      const reason = "blocked: worktree is not the exact head SHA";
      const blocked = mutate(id, (row) => {
        row.status = "blocked";
        row.blocker = reason;
        row.nextAction = reason;
        row.sessionId = undefined;
      });
      throw new FactoryDispatchError("blocked", reason, blocked);
    }
  }
  if (unavailableFactoryRoles().some((row) => row.specialistId === task.specialistId)) {
    throw new FactoryDispatchError("role_unavailable", "specialist role is unavailable", task);
  }
  const sessionId = randomUUID();
  const intent = mutate(id, (row) => {
    row.sessionId = sessionId;
    row.status = "launch_intent";
    row.nextAction = "start turn";
    if ((row.role === "implementer" || row.writerLock === "implementer") && row.worktree) {
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
    if (row.qaOnly && row.headSha && row.sessionId) rememberQaAttempt(row, row.sessionId, row.headSha);
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

export function harvestFactoryTask(id: string, raw: FactoryHarvestInput, opts?: { writerSessionEnded?: boolean }): FactoryTask {
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
    qaDisposition = raw.qaDisposition as QaEvidenceDisposition;
  }
  const checks = raw.checks === undefined ? task.checks : Array.isArray(raw.checks) && raw.checks.every((item) => typeof item === "string")
    ? raw.checks.map((item) => item.slice(0, 500))
    : (() => { throw new FactoryDispatchError("invalid", "checks must be a list of strings"); })();
  const canonical = resolveCanonical(task.worktree!, task.repo);
  if (!canonical) throw new FactoryDispatchError("blocked", "canonical worktree HEAD could not be read");
  const claimed = (raw.resultSha as string).toLowerCase();
  const claimedReview = typeof raw.reviewedSha === "string" ? raw.reviewedSha.toLowerCase() : undefined;
  if (qaDisposition && claimedReview === undefined) {
    throw new FactoryDispatchError("invalid", "QA must name the SHA it reviewed");
  }
  const generation = task.generation ?? 1;
  if (claimed !== canonical.sha || (claimedReview !== undefined && claimedReview !== canonical.sha)) {
    const stale = claimed !== canonical.sha ? claimed : claimedReview!;
    return mutate(id, (row) => {
      if (settleSealedQa(row, canonical, claimed, claimedReview, evidence)) return;
      if ((row.revisions ?? []).some((item) => item.kind === "rejection" && item.sessionId === row.sessionId && item.sha === stale && item.generation === generation)) return;
      const note = `rejected ${stale}; prior review evidence was not changed`;
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
        row.phase = row.phase === "shipped" || row.phase === "release_ready" ? row.phase : "blocked";
        row.blocker = uncertain;
        row.nextAction = uncertain;
        return;
      }
      adoptVerifiedCandidate(row, canonical.sha, evidence);
    });
  }
  const kind = stageKind(task);
  if ((task.revisions ?? []).some((item) => item.kind === kind && item.sessionId === task.sessionId && item.sha === canonical.sha && item.generation === generation)) {
    return task;
  }
  const resultSha = canonical.sha;
  return mutate(id, (row) => {
    if (settleSealedQa(row, canonical, claimed, claimedReview, evidence)) return;
    row.headSha = canonical.sha;
    row.branch = canonical.branch;
    row.evidence = [...row.evidence, ...evidence].slice(-200);
    row.checks = checks;
    if (checkResults.length) row.checkResults = [...(row.checkResults ?? []), ...checkResults].slice(-100);
    if (qaDisposition) {
      row.qaDisposition = qaDisposition;
      row.reviewedSha = resultSha;
      row.reviewSha = resultSha;
    }
    if (typeof raw.blocker === "string") row.blocker = raw.blocker.trim().slice(0, 500) || undefined;
    if (row.implementerId && !row.qaOfTaskId) {
      advancePipeline(row, { findings, resultSha, qaDisposition, checkResults, evidence }, { sealBeforeHandoff: opts?.writerSessionEnded === true });
      return;
    }
    row.resultSha = resultSha;
    const next = typeof raw.nextAction === "string" && raw.nextAction.trim() ? raw.nextAction.trim().slice(0, 500) : qaDisposition ? "evidence only; no merge" : "waiting";
    row.nextAction = next;
    pushRevision(row, {
      kind: row.role === "qa" ? "review" : "implementation",
      sessionId: row.sessionId!,
      specialistId: row.specialistId,
      generation: row.generation ?? 1,
      sha: resultSha,
      evidence,
      findings,
      nextAction: next,
      ...(qaDisposition ? { disposition: qaDisposition } : {}),
    });
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

function stageKind(row: FactoryTask): FactoryRevision["kind"] {
  // The seated specialist, not the next phase. A harvest can move the phase
  // before the next session starts; a duplicate completion must still match
  // the revision this session already wrote.
  if (row.role === "qa" || (row.assignedReviewerId && row.specialistId === row.assignedReviewerId)) return "review";
  if (row.assignedTesterId && row.specialistId === row.assignedTesterId) return "test";
  if (row.assignedReleaseId && row.specialistId === row.assignedReleaseId) return "release";
  return "implementation";
}

function pushRevision(row: FactoryTask, rev: Omit<FactoryRevision, "id" | "createdAt">): void {
  const dup = (row.revisions ?? []).some((item) => item.kind === rev.kind && item.sessionId === rev.sessionId && item.sha === rev.sha && item.generation === rev.generation);
  if (dup) return;
  row.revisions = [...(row.revisions ?? []), { ...rev, id: newId(), createdAt: Date.now() }];
}


/** A repo-owned check script. POSIX execs it. Windows cannot start a shebang
 * file, so Git's sh runs the same bytes; if sh is missing the spawn fails
 * and the gate stays closed. */
function runRepoScript(script: string, args: string[], cwd: string): { status: number | null; stdout: string } {
  const result = process.platform === "win32"
    ? spawnSync("sh", [script, ...args], { cwd, encoding: "utf8" })
    : spawnSync(script, args, { cwd, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "" };
}

function runRequiredTests(worktree: string, sha: string): { ran: boolean; ok: boolean; checks: FactoryCheck[] } {
  const script = join(worktree, ".omb", "required-tests");
  if (!worktree || !existsSync(script)) return { ran: false, ok: true, checks: [] };
  const result = runRepoScript(script, [sha], worktree);
  const ok = result.status === 0;
  return { ran: true, ok, checks: [{ name: "required-tests", result: ok ? "pass" : "fail", sha }] };
}

function invalidateReview(row: FactoryTask, sha: string): void {
  // Drops current pointers only. Revisions already stored keep their sha.
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

function worktreeClean(worktree: string): boolean {
  const status = git(["-C", worktree, "status", "--porcelain=v1", "--untracked-files=all"]);
  return status.ok && status.stdout.trim() === "";
}

/** Null when HEAD is proven. Otherwise a reason to stay blocked. Does not adopt HEAD. */
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
  const current = git(["-C", row.worktree, "rev-parse", "HEAD"]);
  if (!current.ok || current.stdout.trim().toLowerCase() !== head) return "blocked: HEAD changed while it was being checked";
  if (!worktreeClean(row.worktree)) return "blocked: worktree is not clean";
  return null;
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

function qaLeaseHolds(row: FactoryTask): boolean {
  if (!row.implementerId || !row.assignedReviewerId) return false;
  if (row.writerLock === "implementer") return false;
  if (row.specialistId === row.implementerId || row.role === "implementer") return false;
  return row.role === "qa" || row.specialistId === row.assignedReviewerId;
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

function candidateDrift(row: FactoryTask, sealed: FactoryRevision): string | null {
  if (!row.worktree || !row.repo || !sealed.worktree || !sealed.tree || !sealed.sha || !sealed.sessionId) {
    return "blocked: task/session/lock provenance could not be proved";
  }
  if (row.worktree !== sealed.worktree) return "blocked: task/session/lock provenance could not be proved";
  const canonical = resolveCanonical(row.worktree, row.repo);
  if (!canonical) return "blocked: task/session/lock provenance could not be proved";
  if (canonical.sha !== sealed.sha) return "blocked: worktree changed after the candidate was sealed";
  const tree = gitTree(row.worktree, canonical.sha);
  if (!tree || tree !== sealed.tree) return "blocked: worktree changed after the candidate was sealed";
  if (!worktreeClean(row.worktree)) return "blocked: worktree is not clean after the candidate was sealed";
  const current = git(["-C", row.worktree, "rev-parse", "HEAD"]);
  if (!current.ok || current.stdout.trim().toLowerCase() !== sealed.sha) return "blocked: worktree changed after the candidate was sealed";
  return null;
}

function rememberRejection(row: FactoryTask, stale: string, evidence: FactoryEvidence[]): void {
  if (!row.sessionId) return;
  const generation = row.generation ?? 1;
  if ((row.revisions ?? []).some((item) => item.kind === "rejection" && item.sessionId === row.sessionId && item.sha === stale && item.generation === generation)) return;
  const note = `rejected ${stale}; prior review evidence was not changed`;
  const rejection: FactoryEvidence = { at: Date.now(), kind: "rejection", ref: stale, note };
  row.evidence = [...row.evidence, ...evidence, rejection].slice(-200);
  pushRevision(row, {
    kind: "rejection",
    sessionId: row.sessionId,
    specialistId: row.specialistId,
    generation,
    sha: stale,
    evidence: [rejection],
    findings: [`claimed ${stale}`],
    nextAction: `rejected stale SHA ${stale}`,
  });
}

function scheduleFreshQa(row: FactoryTask, sealed: FactoryRevision): void {
  const sha = sealed.sha;
  row.resultSha = sha;
  row.headSha = sha;
  row.status = "waiting_qa";
  row.phase = "review";
  row.writerLock = "review";
  row.blocker = undefined;
  row.nextAction = `fresh independent QA of sealed candidate ${sha}`;
  if (!row.worktree || !row.implementerId || !row.assignedReviewerId) return;
  pushHandoff(row, {
    stage: "review",
    repo: row.repo,
    worktree: row.worktree,
    inputSha: sha,
    resultSha: sha,
    fromSpecialistId: row.implementerId,
    toSpecialistId: row.assignedReviewerId,
    summary: `Rejected QA submission did not match sealed candidate ${sha.slice(0, 12)}; candidate unchanged`,
    requiredEvidence: ["review"],
    checks: (row.checkResults ?? []).filter((check) => check.sha === sha),
    findings: [],
    nextAction: `fresh independent QA of sealed candidate ${sha}`,
  });
}

/**
 * QA against a sealed candidate. The implementer session and writer lock are
 * not required once the lease has moved. Returns true when this harvest must
 * not fall through to the writer-lock check.
 */
function settleSealedQa(row: FactoryTask, canonical: { sha: string; branch: string }, claimed: string, claimedReview: string | undefined, evidence: FactoryEvidence[]): boolean {
  if (!qaLeaseHolds(row)) return false;
  if (row.status === "blocked" && row.blocker && row.blocker !== "blocked: writer session has not ended") {
    const stale = claimed !== (sealedCandidate(row)?.sha ?? canonical.sha) ? claimed : claimedReview !== undefined && claimedReview !== (sealedCandidate(row)?.sha ?? canonical.sha) ? claimedReview : undefined;
    if (stale) rememberRejection(row, stale, evidence);
    return true;
  }
  let sealed = sealedCandidate(row);
  if (!sealed) sealed = proveAndSealFromImplementation(row, canonical);
  if (!sealed) {
    if (claimed !== canonical.sha) rememberRejection(row, claimed, evidence);
    else if (claimedReview !== undefined && claimedReview !== canonical.sha) rememberRejection(row, claimedReview, evidence);
    row.status = "blocked";
    row.phase = "blocked";
    row.blocker = "blocked: task/session/lock provenance could not be proved";
    row.nextAction = row.blocker;
    return true;
  }
  const drift = candidateDrift(row, sealed);
  const stale = claimed !== sealed.sha ? claimed : claimedReview !== undefined && claimedReview !== sealed.sha ? claimedReview : undefined;
  if (stale) rememberRejection(row, stale, evidence);
  if (drift) {
    row.status = "blocked";
    row.phase = "blocked";
    row.blocker = drift;
    row.nextAction = drift;
    return true;
  }
  if (stale) {
    scheduleFreshQa(row, sealed);
    return true;
  }
  return false;
}

function proveAndSealFromImplementation(row: FactoryTask, canonical: { sha: string; branch: string }): FactoryRevision | undefined {
  if (sealedCandidate(row)) return sealedCandidate(row);
  if (!qaLeaseHolds(row) || !row.worktree || !row.writerSessionId || !row.implementerId || !row.baseSha) return undefined;
  const generation = row.generation ?? 1;
  const implementation = (row.revisions ?? []).find((item) => item.kind === "implementation" && item.generation === generation && item.sha === canonical.sha && item.sessionId === row.writerSessionId);
  if (!implementation) return undefined;
  if (row.headSha && row.headSha !== canonical.sha) return undefined;
  if (row.resultSha && row.resultSha !== canonical.sha) return undefined;
  if (canonical.sha === row.writerShaAtAssign) return undefined;
  if (!descendsFrom(row.worktree, row.baseSha, canonical.sha)) return undefined;
  if (row.writerShaAtAssign && !descendsFrom(row.worktree, row.writerShaAtAssign, canonical.sha)) return undefined;
  if (!worktreeClean(row.worktree)) return undefined;
  const current = git(["-C", row.worktree, "rev-parse", "HEAD"]);
  if (!current.ok || current.stdout.trim().toLowerCase() !== canonical.sha) return undefined;
  const sealedNow = persistSealedCandidate(row, canonical.sha, [{ at: Date.now(), kind: "seal", ref: canonical.sha, note: `sealed from implementation revision ${implementation.id}` }]);
  return sealedNow ? sealedCandidate(row) : undefined;
}

function adoptVerifiedCandidate(row: FactoryTask, head: string, evidence: FactoryEvidence[]): void {
  const script = join(row.worktree ?? "", ".omb", "required-tests");
  if (!row.worktree || !existsSync(script)) {
    row.status = "blocked";
    row.phase = "blocked";
    row.blocker = "uncertain: required checks are not present for the verified HEAD";
    row.nextAction = row.blocker;
    return;
  }
  if ((row.revisions ?? []).some((item) => item.kind === "review")) row.generation = (row.generation ?? 1) + 1;
  row.qaDisposition = undefined;
  row.reviewedSha = undefined;
  row.reviewSha = undefined;
  row.testSha = undefined;
  row.releaseSha = undefined;
  row.findings = [];
  const tests = runRequiredTests(row.worktree, head);
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
    nextAction: tests.ok ? `fresh QA of verified HEAD ${head}` : `required checks failed for ${head}`,
  });
  row.checkResults = [...(row.checkResults ?? []).filter((check) => check.sha === head), ...tests.checks].slice(-100);
  if (!tests.ok) {
    row.status = "blocked";
    row.phase = "blocked";
    row.writerLock = "implementer";
    row.blocker = `required checks failed for ${head}`;
    row.nextAction = row.blocker;
    return;
  }
  row.resultSha = head;
  row.headSha = head;
  row.writerLock = "review";
  row.phase = "review";
  row.status = "waiting_qa";
  row.blocker = undefined;
  row.nextAction = `fresh QA of verified HEAD ${head}`;
  pushHandoff(row, {
    stage: "review",
    repo: row.repo,
    worktree: row.worktree,
    inputSha: row.writerShaAtAssign ?? row.baseSha,
    resultSha: head,
    fromSpecialistId: row.implementerId!,
    toSpecialistId: row.assignedReviewerId!,
    summary: `Verified HEAD ${head.slice(0, 12)} is a new candidate; prior review evidence was not reused`,
    requiredEvidence: ["review"],
    checks: tests.checks,
    findings: [],
    nextAction: "fresh independent QA of this exact SHA",
  });
}

function rejectStale(row: FactoryTask, claimed: string, reason: string): void {
  const note = `${reason}; reviewed SHA ${row.reviewSha ?? "none"} unchanged`;
  row.evidence = [...row.evidence, { at: Date.now(), kind: "rejection", ref: claimed, note }].slice(-200);
  pushRevision(row, {
    kind: "rejection",
    sessionId: row.sessionId!,
    specialistId: row.specialistId,
    generation: row.generation ?? 1,
    sha: claimed,
    evidence: [{ at: Date.now(), kind: "rejection", ref: claimed, note }],
    findings: [reason],
    nextAction: `rejected stale SHA ${claimed}; reviewed SHA ${row.reviewSha ?? "none"} unchanged`,
  });
  const uncertain = writerHeadUncertain(row, row.headSha && row.headSha !== claimed ? row.headSha : claimed, false);
  row.status = "blocked";
  row.phase = "blocked";
  row.blocker = uncertain ?? `rejected stale SHA ${claimed}; reviewed SHA ${row.reviewSha ?? "none"} unchanged`;
  row.nextAction = row.blocker;
}

function advancePipeline(row: FactoryTask, input: { findings: string[]; resultSha: string; qaDisposition?: QaEvidenceDisposition; checkResults: FactoryCheck[]; evidence: FactoryEvidence[] }, opts?: { sealBeforeHandoff?: boolean }): void {
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
    if (opts?.sealBeforeHandoff) {
      const reason = writerHeadUncertain(row, input.resultSha, true);
      if (reason) {
        row.status = "blocked";
        row.phase = "blocked";
        row.blocker = reason;
        row.nextAction = reason;
        return;
      }
    }
    const hadOtherReview = (row.revisions ?? []).some((item) => item.kind === "review" && item.sha !== input.resultSha);
    if (hadOtherReview) {
      row.generation = (row.generation ?? 1) + 1;
      row.qaDisposition = undefined;
      row.reviewedSha = undefined;
      row.reviewSha = undefined;
      row.testSha = undefined;
      row.releaseSha = undefined;
      row.findings = [];
    } else if (row.reviewSha && row.reviewSha !== input.resultSha) {
      invalidateReview(row, input.resultSha);
    }
    if (opts?.sealBeforeHandoff && !persistSealedCandidate(row, input.resultSha, input.evidence)) return;
    const tests = hadOtherReview ? runRequiredTests(worktree, input.resultSha) : { ran: false, ok: true, checks: [] as FactoryCheck[] };
    row.resultSha = input.resultSha;
    const nextAction = tests.ran && !tests.ok
      ? `required tests failed for ${input.resultSha}; fresh QA was not started`
      : "independent review of the exact SHA";
    pushRevision(row, {
      kind: "implementation",
      sessionId: row.sessionId!,
      specialistId: from,
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
      checks: [...input.checkResults, ...tests.checks],
      findings: [],
      nextAction: "independent review of the exact SHA",
    });
    return;
  }
  if (row.phase === "review" || row.specialistId === row.assignedReviewerId) {
    if (row.resultSha && input.resultSha !== row.resultSha) {
      rejectStale(row, input.resultSha, "review does not match the implementation SHA");
      return;
    }
    row.findings = input.findings;
    row.reviewSha = input.resultSha;
    row.reviewedSha = input.resultSha;
    row.resultSha = input.resultSha;
    pushRevision(row, {
      kind: "review",
      sessionId: row.sessionId!,
      specialistId: from,
      generation: row.generation ?? 1,
      sha: input.resultSha,
      evidence: input.evidence,
      findings: input.findings,
      nextAction: input.findings.length || input.qaDisposition === "NOT_CLEAR" ? "remediate on a new implementation session" : "test the reviewed SHA",
      ...(input.qaDisposition ? { disposition: input.qaDisposition } : {}),
    });
    if (input.findings.length || input.qaDisposition === "NOT_CLEAR") {
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
        summary: input.findings.join("; ").slice(0, 500) || "NOT_CLEAR",
        requiredEvidence: row.requiredEvidence,
        checks: row.checkResults ?? [],
        findings: input.findings,
        nextAction: "fix the finding; the server will read the new SHA, rerun required tests, and request fresh QA",
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
      rejectStale(row, input.resultSha, `tests do not match reviewed SHA ${row.reviewSha ?? "none"}`);
      return;
    }
    row.testSha = input.resultSha;
    row.resultSha = input.resultSha;
    pushRevision(row, {
      kind: "test",
      sessionId: row.sessionId!,
      specialistId: from,
      generation: row.generation ?? 1,
      sha: input.resultSha,
      evidence: input.evidence,
      findings: [],
      nextAction: "release review",
    });
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
      nextAction: "release reviewer records the outcome; release_ready is not a deployment",
    });
    return;
  }
  if (row.phase === "release" || row.specialistId === row.assignedReleaseId) {
    if (row.testSha !== input.resultSha || row.reviewSha !== input.resultSha) {
      rejectStale(row, input.resultSha, "release review does not match tested SHA");
      return;
    }
    row.releaseSha = input.resultSha;
    row.resultSha = input.resultSha;
    pushRevision(row, {
      kind: "release",
      sessionId: row.sessionId!,
      specialistId: from,
      generation: row.generation ?? 1,
      sha: input.resultSha,
      evidence: input.evidence,
      findings: input.findings,
      nextAction: `release_ready ${input.resultSha}; not shipped`,
    });
    row.phase = "release";
    row.status = "harvested";
    row.writerLock = "none";
    row.nextAction = "release_ready only after the repo gate; a gate match is not a deployment";
  }
}

export interface FactoryDeliverDeps extends FactoryLaunchDeps {
  bot: (id: string) => FactoryBot | null;
  createThread: (botId: string, title: string) => { threadId: string };
  pinCwd: (botId: string, threadId: string, cwd: string) => void;
}

/** A fresh sealed-candidate handoff that must not be marked launched unless the lease still matches. */
function sealedReviewUnsafe(row: FactoryTask, handoff: FactoryHandoff): string | null {
  if (handoff.stage !== "review" || !handoff.nextAction.startsWith("fresh independent QA of sealed candidate")) return null;
  const sealed = sealedCandidate(row);
  if (!sealed) return "blocked: sealed candidate is missing";
  if (handoff.resultSha !== sealed.sha || handoff.inputSha !== sealed.sha) return "blocked: handoff SHA is not the sealed candidate";
  if (row.writerLock === "implementer" || row.role === "implementer") return "blocked: QA lease is not read-only";
  if (!row.worktree || row.worktree !== handoff.worktree || row.worktree !== sealed.worktree) {
    return "blocked: task/session/lock provenance could not be proved";
  }
  return candidateDrift(row, sealed);
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
    row.qaAttempts = snapshot.qaAttempts ? structuredClone(snapshot.qaAttempts) : undefined;
  });
}

/** Starts the specialist named on the newest undelivered handoff. A retry returns that handoff and does not start another worker. */
export async function deliverHandoff(id: string, deps: FactoryDeliverDeps, opts?: { handoffId?: string }): Promise<{ task: FactoryTask; duplicate: boolean }> {
  const task = getFactoryTask(id);
  if (!task) throw new FactoryDispatchError("not_found", "no such factory task");
  const requested = opts?.handoffId?.trim();
  let pending = requested
    ? task.handoffs?.find((item) => item.id === requested)
    : [...(task.handoffs ?? [])].reverse().find((item) => !item.deliveredAt);
  if (requested && !pending) throw new FactoryDispatchError("not_found", "no such handoff", task);
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
  if (pending.stage === "remediate" && task.writerLock !== "implementer") {
    throw new FactoryDispatchError("blocked", "remediation waits until the reviewer turn ends and the lock transfers", task);
  }
  const unsafe = sealedReviewUnsafe(task, pending);
  if (unsafe) {
    const blocked = mutate(id, (row) => {
      row.status = "blocked";
      row.phase = row.phase === "shipped" || row.phase === "release_ready" ? row.phase : "blocked";
      row.blocker = unsafe;
      row.nextAction = unsafe;
      const handoff = row.handoffs?.find((item) => item.id === pending!.id);
      if (handoff) handoff.deliveredAt = undefined;
    });
    throw new FactoryDispatchError("blocked", unsafe, blocked);
  }
  const rejectedSessions = new Set((task.revisions ?? []).filter((item) => item.kind === "rejection").map((item) => item.sessionId));
  const snapshot = structuredClone(task);
  const handoffId = pending.id;
  const reviewSha = pending.resultSha;
  try {
    // Durable only after the lease is safe. A failed start rolls this back.
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
      throw new FactoryDispatchError("blocked", "refusing to reuse the QA session that submitted the rejected SHA", launched.task);
    }
    if (pending.stage === "review" && factoryRole(target) === "qa") {
      return {
        task: mutate(id, (row) => {
          if (row.sessionId) rememberQaAttempt(row, row.sessionId, reviewSha, handoffId);
        }),
        duplicate: launched.duplicate,
      };
    }
    return { task: getFactoryTask(id)!, duplicate: launched.duplicate };
  } catch (error) {
    const blocker = error instanceof Error ? error.message : "handoff failed";
    const restored = leaveHandoffUnlaunched(id, handoffId, snapshot, blocker);
    throw new FactoryDispatchError("blocked", blocker, restored);
  }
}

export function releaseGateAuthorizes(worktree: string, sha: string): { ok: boolean; reason: string } {
  const gate = join(worktree, ".omb", "release-gate");
  if (!existsSync(gate)) return { ok: false, reason: `release gate did not authorize ${sha}: .omb/release-gate is missing` };
  const result = runRepoScript(gate, [sha], worktree);
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
    row.phase = "release_ready";
    row.status = "harvested";
    row.blocker = undefined;
    row.nextAction = `release_ready ${row.resultSha}; not shipped`;
    row.evidence = [...row.evidence, { at: Date.now(), kind: "gate", ref: row.resultSha!, note: "repo gate matched this SHA; not a deployment" }];
  });
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
 * another writer.
 */
export async function completeFactoryTurn(threadId: string, deps: FactoryCompletionDeps): Promise<{ task: FactoryTask | null; duplicate: boolean }> {
  const task = factoryTaskByThread(threadId);
  if (!task) return { task: null, duplicate: false };
  if (task.ombThreadId !== threadId) return { task, duplicate: true };
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
    if (reconsidered.status === "blocked" || reconsidered.status === "failed_closed" || reconsidered.status === "cancelled") {
      return { task: reconsidered, duplicate: true };
    }
  } else if (task.status === "blocked" || task.status === "failed_closed" || task.status === "cancelled" || task.phase === "release_ready" || task.phase === "shipped") {
    return { task, duplicate: true };
  }
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
      const waiting = mutate(task.id, (row) => {
        const canonical = resolveCanonical(row.worktree!, row.repo);
        if (canonical) {
          row.headSha = canonical.sha;
          row.branch = canonical.branch;
        }
        row.evidence = [...row.evidence, { at: Date.now(), kind: "turn", ref: row.sessionId!, note: "worker completion was not ok; SHA was not accepted" }].slice(-200);
        row.status = "waiting_qa";
        row.blocker = undefined;
        row.nextAction = "worker did not finish cleanly; waiting for a recoverable retry";
      });
      return { task: waiting, duplicate: false };
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
    const kind = stageKind(task);
    const generation = task.generation ?? 1;
    const recorded = (task.revisions ?? []).some((item) => item.kind === kind && item.sessionId === task.sessionId && item.sha === canonical.sha && item.generation === generation);
    if (!recorded && kind === "implementation") {
      harvestFactoryTask(task.id, {
        sessionId: task.sessionId,
        worktree: task.worktree,
        resultSha: canonical.sha,
        evidence: [{ kind: "commit", ref: canonical.sha, note: "server read git HEAD at worker completion" }],
      }, { writerSessionEnded: true });
    } else if (!recorded) {
      const waiting = mutate(task.id, (row) => {
        row.headSha = canonical.sha;
        row.branch = canonical.branch;
        row.evidence = [...row.evidence, { at: Date.now(), kind: "turn", ref: canonical.sha, note: "session ended without a result bound to server HEAD" }].slice(-200);
        if (row.status === "running" || row.status === "launch_intent") row.status = "waiting_qa";
        row.blocker = undefined;
        row.nextAction = `waiting for a result bound to server HEAD ${canonical.sha}`;
      });
      return { task: waiting, duplicate: false };
    }
  }
  const current = getFactoryTask(task.id)!;
  if (current.ombThreadId !== threadId) return { task: current, duplicate: true };
  const pending = [...(current.handoffs ?? [])].reverse().find((item) => !item.deliveredAt);
  if (!pending || current.status === "running" || current.status === "launch_intent" || current.status === "blocked") {
    return { task: current, duplicate: !pending };
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

## Seats

Seven specialist ids are registered in the app. Coding seats use catalog Claude Opus 5.5 (\`claude-opus-5-5\`). That is not another product name. Fable (\`claude-fable-5-1\`) is advisor-only and is not an implementer. Finch stays and is not a specialist.

Permissions are Auto only. \`bypassPermissions\` and Full are rejected. Read-only seats (navigator, security, UI, game, QA, release) cannot edit files or submit implementation changes: the Claude spawn disallows those tools and a PreToolUse hook fails closed. The implementer writes only inside the task worktree. If that fence cannot be applied, the role is marked unavailable and dispatch is blocked.

## How a task starts

1. Intake: objective, specialist id, model, permissions, repo, base SHA, acceptance, dependencies, required evidence, owner, authority.
2. Missing owner, unclear authority, a protected session, a frozen tip, or a blocked dependency does not create a worktree.
3. The app creates an isolated git worktree and stores the task-to-worktree binding before any worker turn. It does not use the bot's global folder as the pin.
4. Launch stores the Claude session id on that same task, then starts the turn. Status becomes running only after both are stored. A second launch returns the binding and does not start another writer.
5. Quiet waits (\`waiting_ci\`, \`waiting_qa\`, \`waiting_owner\`, \`waiting_external\`) keep the worktree reserved.
6. On worker completion the server reads the task, specialist, session, generation, canonical worktree, repository, branch, and git HEAD. An agent SHA or a done message is not the result. Each implementation and review is an immutable revision. A mismatched SHA is stored as a rejected revision and does not rewrite prior review evidence. When the implementer session ends and still holds the exclusive writer lock, the server verifies that binding, a clean worktree, actual HEAD, and ancestry from the recorded base, then stores an immutable candidate (generation, writer session, SHA, tree, worktree, and the verification evidence) before the worktree moves to a read-only QA lease. QA is compared to that sealed SHA. The writer session and writer lock do not have to stay active after the lease moves. A mismatched QA SHA stays rejected evidence, the candidate is unchanged, and the pending QA handoff is consumed into a new Independent QA session against the sealed SHA on the read-only lease when that launch is safe. If it cannot be launched safely, the handoff stays unlaunched and the task stays blocked. The rejected session is not reused and the rejected revision is not edited. A rejected review is not CLEAR. If the worktree changes after sealing, or task, session, and lock provenance cannot be proved, the task stays blocked. A newer HEAD is not adopted and a prior review is not rewritten. NOT_CLEAR starts a different implementation session only after QA has ended and the writer lock has transferred. The new SHA gets required tests and fresh QA. Old QA, security, and release results do not apply to it. release_ready is not shipped.
7. Restart resumes only when the stored session id was proven and the worktree still matches. Otherwise the task stays blocked.

## Same-task pipeline

An implementer task hands off on that same task id: independent review, remediation if the reviewer records findings, test, then release review. Each handoff is stored before the next specialist starts (task, repo, worktree, input SHA, result SHA, both specialist ids, summary, required evidence, checks, findings, next action). A retry sees the stored handoff and does not start a second worker.

The implementer writes only in the assigned worktree. Reviewers and testers cannot edit files. Remediation returns to the implementer only after the reviewer turn ends and the writer lock transfers. A changed SHA invalidates the review and requires a fresh review and tests. The implementer cannot clear its own work. Only the assigned Independent QA specialist records a disposition.

Remediation stops at the configured limit (default 2). Evidence stays, the task is blocked, and the next action names the CoS decision. Other tasks can continue on other worktrees. The repo gate can mark release_ready for that exact SHA. That is not a deployment. An agent ship message, admin flag, bypass, or a scratch gate does not set shipped. Missing evidence, a wrong SHA, or an unavailable specialist blocks the task with that reason.

## Out of scope

Markout C2/C3/C5, Media Lens live URL, and Release Rescue host work stay ineligible. Do not open a non-loopback listener.
`;
