// Implementation-only pipeline. OMB stops at a sealed implementation SHA.
// The only same-task handoff it still delivers is one back to the
// implementer; review, test, release, and the ship gate are outside OMB.
import { execSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import { NO_WRITER_SANDBOX_REASON, type FactorySandbox } from "./factory-sandbox.ts";
import {
  FactoryDispatchError,
  IMPLEMENTER_ID,
  completeFactoryTurn,
  createFactoryTask,
  deliverHandoff,
  factoryTurnGuard,
  getFactoryTask,
  harvestFactoryTask,
  launchFactoryTask,
  listFactoryTasks,
  noteFactorySession,
  recoverFactoryTasks,
  shipFactoryTask,
  _resetFactoryDispatch,
  type FactoryBot,
  type FactoryCompletionDeps,
  type FactoryDeliverDeps,
  type FactoryTask,
} from "./factory-dispatch.ts";

const QA_ID = "223e5e26-37e4-42e3-9026-5983b66a17aa";

function initRepo(): { repo: string; sha: string } {
  const repo = mkdtempSync(join(tmpdir(), "omb-pipe-"));
  execSync("git init -b main", { cwd: repo });
  execSync("git config user.email factory@example.com", { cwd: repo });
  execSync("git config user.name factory", { cwd: repo });
  writeFileSync(join(repo, "README"), "base\n");
  mkdirSync(join(repo, ".omb"));
  writeFileSync(join(repo, ".omb", "required-tests"), "#!/bin/sh\nhead=$(git rev-parse HEAD)\n[ \"$1\" = \"$head\" ] || exit 1\ngrep -q fixed README || exit 1\nexit 0\n");
  chmodSync(join(repo, ".omb", "required-tests"), 0o755);
  writeFileSync(join(repo, ".omb", "release-gate"), "#!/bin/sh\nprintf '%s\\n' \"$1\"\n");
  chmodSync(join(repo, ".omb", "release-gate"), 0o755);
  execSync("git add README .omb && git commit -m base", { cwd: repo });
  return { repo, sha: execSync("git rev-parse HEAD", { cwd: repo }).toString().trim() };
}

function commit(worktree: string, body: string): string {
  writeFileSync(join(worktree, "README"), body);
  execSync("git add README && git commit -m change", { cwd: worktree });
  return execSync("git rev-parse HEAD", { cwd: worktree }).toString().trim();
}

function deps() {
  let n = 0;
  const threads: { threadId: string; cwd?: string }[] = [];
  const bot = (id: string): FactoryBot => ({ id, model: "claude-opus-5-5", driverKind: "claudeAgent" });
  const createThread = (id: string) => {
    const threadId = `t-${id.slice(0, 8)}-${n++}`;
    threads.push({ threadId });
    return { threadId };
  };
  const pinCwd = (_id: string, threadId: string, cwd: string) => {
    const row = threads.find((item) => item.threadId === threadId);
    if (row) row.cwd = cwd;
  };
  return { threads, bot, createThread, pinCwd };
}

function intake(repo: string, sha: string, extra: Record<string, unknown> = {}) {
  return {
    objective: "Add a harmless line",
    specialistId: IMPLEMENTER_ID,
    model: "claude-opus-5-5",
    permissions: "auto",
    repo,
    baseSha: sha,
    acceptance: "README contains harmless",
    dependencies: [],
    requiredEvidence: ["commit"],
    owner: "Bryant Thornton",
    authority: "pipeline proof",
    ...extra,
  };
}

function deliverDeps(local: ReturnType<typeof deps>, starts: { n: number }, start: () => void = () => { starts.n += 1; }): FactoryDeliverDeps {
  return { bot: local.bot, createThread: local.createThread, pinCwd: local.pinCwd, start };
}

function completion(threadId: string, local: ReturnType<typeof deps>, starts: { n: number }) {
  const host: FactoryCompletionDeps = { ok: true, ...deliverDeps(local, starts) };
  return completeFactoryTurn(threadId, host);
}

const store = (): string => join(DATA_DIR, "factory-tasks.json");

/** Rewrites one stored task the way a pre-change store held it. */
function rewriteStored(id: string, change: (row: Record<string, unknown>) => void): void {
  const raw = JSON.parse(readFileSync(store(), "utf8"));
  const row = raw.tasks.find((item: { id: string }) => item.id === id);
  change(row);
  writeFileSync(store(), JSON.stringify(raw));
  _resetFactoryDispatch();
}

/** An implemented task turned into the stored shape of a legacy NOT_CLEAR remediation. */
async function legacyRemediation(): Promise<{ task: FactoryTask; built: string; local: ReturnType<typeof deps>; qaThread: string; qaSession: string }> {
  const { repo, sha } = initRepo();
  const local = deps();
  const task = createFactoryTask(intake(repo, sha), local).task;
  const launched = await launchFactoryTask(task.id, { start: () => {} });
  const built = commit(task.worktree!, "base\nharmless\n");
  await completion(launched.task.ombThreadId!, local, { n: 0 });
  const qaThread = "legacy-qa-thread";
  const qaSession = "00000000-0000-4000-8000-00000000aa01";
  const now = Date.now();
  rewriteStored(task.id, (row) => {
    row.specialistId = QA_ID;
    row.specialistKey = "independent-qa";
    row.role = "qa";
    row.status = "waiting_qa";
    row.phase = "remediate";
    row.writerLock = "implementer";
    row.sessionId = qaSession;
    row.ombThreadId = qaThread;
    row.threads = [...(row.threads as unknown[]), { specialistId: QA_ID, threadId: qaThread }];
    row.assignedReviewerId = QA_ID;
    row.qaDisposition = "NOT_CLEAR";
    row.reviewSha = built;
    row.reviewedSha = built;
    row.revisions = [...(row.revisions as unknown[]), {
      id: "00000000-0000-4000-8000-00000000ab01", kind: "review", sessionId: qaSession, specialistId: QA_ID, generation: 1, sha: built, evidence: [], findings: ["missing fixed"], nextAction: "remediate", disposition: "NOT_CLEAR", createdAt: now,
    }];
    row.handoffs = [{
      id: "00000000-0000-4000-8000-00000000ac01", taskId: task.id, stage: "remediate", repo, worktree: task.worktree, inputSha: built, resultSha: built,
      fromSpecialistId: QA_ID, toSpecialistId: IMPLEMENTER_ID, summary: "missing fixed", requiredEvidence: ["commit"], checks: [], findings: ["missing fixed"],
      nextAction: "fix the finding", createdAt: now,
    }];
  });
  return { task: getFactoryTask(task.id)!, built, local, qaThread, qaSession };
}

// These tests are about the lifecycle, not confinement. The stand-in confines
// nothing; it replaces the detection module for this test file only, because
// production code has no way to install one. Without any sandbox, writers and
// required-tests fail closed (see factory-fence.test.ts).
const sandbox = vi.hoisted(() => ({ current: null as FactorySandbox | null }));
vi.mock("./factory-sandbox.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./factory-sandbox.ts")>()),
  detectFactorySandbox: () => sandbox.current,
}));
const PASS_THROUGH: FactorySandbox = { name: "test-pass-through", wrap: (command, args) => ({ command, args }) };
beforeEach(() => {
  try { unlinkSync(store()); } catch { /* fresh home */ }
  _resetFactoryDispatch();
  sandbox.current = PASS_THROUGH;
});
afterEach(() => { sandbox.current = null; });

describe("implementation-only pipeline", () => {
  it("stops at the sealed implementation SHA with no review handoff and frees the repository", async () => {
    const { repo, sha } = initRepo();
    const local = deps();
    const starts = { n: 0 };
    const task = createFactoryTask(intake(repo, sha), local).task;
    expect(task.phase).toBe("implement");
    expect(task.writerLock).toBe("implementer");
    expect(task.assignedReviewerId).toBeUndefined();
    expect(task.assignedTesterId).toBeUndefined();
    expect(task.assignedReleaseId).toBeUndefined();
    expect(() => createFactoryTask(intake(repo, sha, { dispatchKey: "second" }), deps())).toThrow(/writer/);
    const launched = await launchFactoryTask(task.id, { start: () => {} });
    const built = commit(task.worktree!, "base\nharmless\n");

    const desk = harvestFactoryTask(task.id, {
      sessionId: launched.task.sessionId,
      worktree: task.worktree,
      resultSha: built,
      evidence: [{ kind: "commit", ref: built }],
      checkResults: [{ name: "unit", result: "pass", sha: built }],
    });
    expect(desk.status).toBe("running");
    expect(desk.resultSha).toBeUndefined();
    expect(desk.revisions?.some((item) => item.kind === "candidate" || item.kind === "implementation")).toBe(false);

    const done = await completion(launched.task.ombThreadId!, local, starts);
    expect(done.duplicate).toBe(false);
    expect(done.task?.id).toBe(task.id);
    expect(done.task?.status).toBe("harvested");
    expect(done.task?.phase).toBe("implemented");
    expect(done.task?.resultSha).toBe(built);
    expect(done.task?.handoffs ?? []).toEqual([]);
    expect(done.task?.revisions?.filter((item) => item.kind === "implementation" && item.sha === built)).toHaveLength(1);
    expect(done.task?.revisions?.filter((item) => item.kind === "candidate" && item.sha === built)).toHaveLength(1);
    expect(done.task?.revisions?.some((item) => item.kind === "review" || item.kind === "test" || item.kind === "release")).toBe(false);
    expect(starts.n).toBe(0);
    expect(local.threads).toHaveLength(1);

    // The ship gate is outside OMB, even with a release gate script present.
    expect(() => shipFactoryTask(task.id, {})).toThrow(FactoryDispatchError);
    expect(getFactoryTask(task.id)?.status).toBe("harvested");
    expect(getFactoryTask(task.id)?.phase).toBe("implemented");

    // A later stale claim stays rejected evidence and does not rewrite the result.
    const stale = harvestFactoryTask(task.id, {
      sessionId: launched.task.sessionId,
      worktree: task.worktree,
      resultSha: sha,
      evidence: [{ kind: "commit", ref: sha }],
    });
    expect(stale.resultSha).toBe(built);
    expect(stale.revisions?.some((item) => item.kind === "rejection" && item.sha === sha)).toBe(true);
    expect(stale.revisions?.find((item) => item.kind === "candidate")?.sha).toBe(built);

    // The writer lock was released when OMB's part ended.
    const next = createFactoryTask(intake(repo, sha, { dispatchKey: "next" }), deps());
    expect(next.task.id).not.toBe(task.id);
  });

  it("delivers a stored same-task implementation handoff once, retests the new SHA, and starts no QA", async () => {
    const legacy = await legacyRemediation();
    const starts = { n: 0 };
    const fix = await deliverHandoff(legacy.task.id, deliverDeps(legacy.local, starts));
    expect(starts.n).toBe(1);
    expect(fix.task.id).toBe(legacy.task.id);
    expect(fix.task.specialistId).toBe(IMPLEMENTER_ID);
    expect(fix.task.role).toBe("implementer");
    expect(fix.task.status).toBe("running");
    expect(fix.task.sessionId).not.toBe(legacy.qaSession);
    expect(fix.task.ombThreadId).not.toBe(legacy.qaThread);
    expect(fix.task.writerSessionId).toBe(fix.task.sessionId);
    const again = await deliverHandoff(legacy.task.id, deliverDeps(legacy.local, starts));
    expect(again.duplicate).toBe(true);
    expect(starts.n).toBe(1);

    const fixed = commit(legacy.task.worktree!, "base\nharmless\nfixed\n");
    const done = await completion(fix.task.ombThreadId!, legacy.local, starts);
    expect(done.task?.status).toBe("harvested");
    expect(done.task?.phase).toBe("implemented");
    expect(done.task?.resultSha).toBe(fixed);
    expect(done.task?.generation).toBe(2);
    expect(done.task?.reviewSha).toBeUndefined();
    expect(done.task?.qaDisposition).toBeUndefined();
    expect(done.task?.checkResults?.some((check) => check.name === "required-tests" && check.result === "pass" && check.sha === fixed)).toBe(true);
    expect(done.task?.revisions?.find((item) => item.kind === "review")?.sha).toBe(legacy.built);
    expect(done.task?.handoffs?.filter((item) => !item.deliveredAt)).toEqual([]);
    expect(starts.n).toBe(1);
    const duplicate = await completion(fix.task.ombThreadId!, legacy.local, starts);
    expect(duplicate.duplicate).toBe(true);
    expect(starts.n).toBe(1);
  });

  it("does not mark a failed implementation handoff start as delivered", async () => {
    const legacy = await legacyRemediation();
    const handoffId = legacy.task.handoffs![0]!.id;
    let tries = 0;
    await expect(deliverHandoff(legacy.task.id, deliverDeps(legacy.local, { n: 0 }, () => {
      tries += 1;
      throw new Error("worker failed");
    }))).rejects.toBeInstanceOf(FactoryDispatchError);
    expect(tries).toBe(1);
    const after = getFactoryTask(legacy.task.id)!;
    expect(after.status).toBe("blocked");
    expect(after.handoffs?.find((item) => item.id === handoffId)?.deliveredAt).toBeUndefined();
    expect(after.sessionId).toBe(legacy.qaSession);
  });

  it("does not deliver a stored implementation handoff when the writer lock was not transferred", async () => {
    const legacy = await legacyRemediation();
    rewriteStored(legacy.task.id, (row) => { row.writerLock = "review"; });
    const starts = { n: 0 };
    await expect(deliverHandoff(legacy.task.id, deliverDeps(legacy.local, starts))).rejects.toThrow(/writer lock/);
    expect(starts.n).toBe(0);
  });

  it("does not launch a second worker when restart recovery runs", async () => {
    const legacy = await legacyRemediation();
    const starts = { n: 0 };
    await deliverHandoff(legacy.task.id, deliverDeps(legacy.local, starts));
    _resetFactoryDispatch();
    recoverFactoryTasks();
    const after = JSON.parse(readFileSync(store(), "utf8"));
    const row = after.tasks.find((item: { id: string }) => item.id === legacy.task.id);
    expect(row.handoffs.filter((item: { deliveredAt?: number }) => item.deliveredAt).length).toBe(1);
    const retry = await deliverHandoff(legacy.task.id, deliverDeps(legacy.local, starts));
    expect(retry.duplicate).toBe(true);
    expect(starts.n).toBe(1);
  });
});

describe("with no OS sandbox, no writer is created, launched, or resumed", () => {
  const worktreesOf = (repo: string) => execSync("git worktree list --porcelain", { cwd: repo }).toString().split("\n").filter((line) => line.startsWith("worktree "));

  it("refuses intake before any worktree, task record, or thread exists", () => {
    const { repo, sha } = initRepo();
    const local = deps();
    sandbox.current = null;
    expect(() => createFactoryTask(intake(repo, sha), local)).toThrow(NO_WRITER_SANDBOX_REASON);
    expect(local.threads).toEqual([]);
    expect(listFactoryTasks()).toEqual([]);
    expect(worktreesOf(repo)).toHaveLength(1);
  });

  it("refuses an implementation handoff before a thread, a pin, or any change to the task", async () => {
    const legacy = await legacyRemediation();
    const before = JSON.stringify(getFactoryTask(legacy.task.id));
    const threads = legacy.local.threads.length;
    const starts = { n: 0 };
    sandbox.current = null;
    await expect(deliverHandoff(legacy.task.id, deliverDeps(legacy.local, starts))).rejects.toThrow(NO_WRITER_SANDBOX_REASON);
    expect(starts.n).toBe(0);
    expect(legacy.local.threads).toHaveLength(threads);
    expect(JSON.stringify(getFactoryTask(legacy.task.id))).toBe(before);
    expect(getFactoryTask(legacy.task.id)?.handoffs?.every((item) => !item.deliveredAt)).toBe(true);
  });

  it.each(["launch_intent", "running"] as const)("does not start a turn for a stored %s task, and leaves its record alone", async (status) => {
    const { repo, sha } = initRepo();
    const local = deps();
    const task = createFactoryTask(intake(repo, sha), local).task;
    const launched = await launchFactoryTask(task.id, { start: () => {} });
    const threadId = launched.task.ombThreadId!;
    noteFactorySession(threadId, launched.task.sessionId!);
    rewriteStored(task.id, (row) => { row.status = status; });
    const before = JSON.stringify(getFactoryTask(task.id));

    // Control: with a sandbox the same stored task is a valid turn.
    expect(factoryTurnGuard(threadId)?.sessionId).toBe(launched.task.sessionId);
    sandbox.current = null;
    expect(() => factoryTurnGuard(threadId)).toThrow(NO_WRITER_SANDBOX_REASON);
    expect(JSON.stringify(getFactoryTask(task.id))).toBe(before);
  });

  it("does not restore a proven stored writer to running, and keeps its session and binding", async () => {
    const { repo, sha } = initRepo();
    const local = deps();
    const task = createFactoryTask(intake(repo, sha), local).task;
    const launched = await launchFactoryTask(task.id, { start: () => {} });
    noteFactorySession(launched.task.ombThreadId!, launched.task.sessionId!);
    const stored = getFactoryTask(task.id)!;
    expect(stored.provenSessionId).toBe(stored.sessionId);

    sandbox.current = null;
    _resetFactoryDispatch();
    const result = recoverFactoryTasks();
    expect(result.restored).toEqual([]);
    expect(result.blocked).toEqual([task.id]);
    const after = getFactoryTask(task.id)!;
    expect(after.status).toBe("blocked");
    expect(after.blocker).toBe(NO_WRITER_SANDBOX_REASON);
    expect(after.sessionId).toBe(stored.sessionId);
    expect(after.provenSessionId).toBe(stored.provenSessionId);
    expect(after.worktree).toBe(stored.worktree);
    expect(after.writerLock).toBe("implementer");
    expect(() => factoryTurnGuard(launched.task.ombThreadId!)).toThrow();
  });
});
