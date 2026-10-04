// Queued QA handoff consumption and QA-only desk tasks.
// Live task 6ea2f99b-e29a-4b21-8fa5-b9b6dd56598c is not loaded. The fixture
// copies its shape: waiting_qa, session 69e6f60a still seated, undelivered
// handoff 3218431a, rejection b079f2e2 of aaaa… by that session, and a sealed
// candidate the new session must review. The sealed SHA here is a local
// commit, not the live 9869feef worktree.
import { execFileSync, execSync } from "node:child_process";
import { accessSync, constants, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { enforceFactoryTool } from "./factory-boundary.ts";
import {
  FactoryDispatchError,
  IMPLEMENTER_ID,
  REVIEWER_ID,
  completeFactoryTurn,
  createFactoryTask,
  deliverHandoff,
  getFactoryTask,
  harvestFactoryTask,
  launchFactoryTask,
  releaseWorktreeReadOnly,
  _resetFactoryDispatch,
  type FactoryBot,
  type FactoryCompletionDeps,
  type FactoryDeliverDeps,
  type FactoryRevision,
  type FactoryTask,
} from "./factory-dispatch.ts";

const DEAD = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const REJECTED_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const LIVE_TASK = "6ea2f99b-e29a-4b21-8fa5-b9b6dd56598c";
const LIVE_HANDOFF = "3218431a-7891-4c46-b728-9a80b149e1f3";
const LIVE_SESSION = "69e6f60a-204b-4568-b835-b767d9f83ad7";
const LIVE_REJECTION = "b079f2e2-9a34-4ce7-9bcd-f98f5dbb4ccd";

function initRepo(): { repo: string; sha: string } {
  const repo = mkdtempSync(join(tmpdir(), "omb-qa-"));
  execSync("git init -b main", { cwd: repo });
  execSync("git config user.email factory@example.com", { cwd: repo });
  execSync("git config user.name factory", { cwd: repo });
  writeFileSync(join(repo, "README"), "base\n");
  execSync("git add README && git commit -m base", { cwd: repo });
  return { repo, sha: execSync("git rev-parse HEAD", { cwd: repo }).toString().trim() };
}

function commit(worktree: string, body: string): string {
  writeFileSync(join(worktree, "README"), body);
  execSync("git add README && git commit -m change", { cwd: worktree });
  return execSync("git rev-parse HEAD", { cwd: worktree }).toString().trim();
}

function treeOf(worktree: string, sha: string): string {
  return execFileSync("git", ["rev-parse", `${sha}^{tree}`], { cwd: worktree, encoding: "utf8" }).trim();
}

function local() {
  let n = 0;
  const threads: { threadId: string; cwd?: string }[] = [];
  const scope = Math.random().toString(16).slice(2);
  const bot = (id: string): FactoryBot => ({ id, model: "claude-opus-5-5", driverKind: "claudeAgent" });
  const createThread = (id: string) => {
    const threadId = `qa-${scope}-${id.slice(0, 8)}-${n++}`;
    threads.push({ threadId });
    return { threadId };
  };
  const pinCwd = (_id: string, threadId: string, cwd: string) => {
    const row = threads.find((item) => item.threadId === threadId);
    if (row) row.cwd = cwd;
  };
  return { threads, bot, createThread, pinCwd };
}

function deliverDeps(deps: ReturnType<typeof local>, starts: { n: number }, start: () => void = () => { starts.n += 1; }): FactoryDeliverDeps {
  return { bot: deps.bot, createThread: deps.createThread, pinCwd: deps.pinCwd, start };
}

async function sealMismatch(): Promise<{
  id: string;
  built: string;
  qaSession: string;
  candidateId: string;
  rejection: FactoryRevision;
  deps: ReturnType<typeof local>;
  starts: { n: number };
}> {
  const { repo, sha } = initRepo();
  const deps = local();
  const starts = { n: 0 };
  const created = createFactoryTask({
    objective: "Add a harmless line",
    specialistId: IMPLEMENTER_ID,
    model: "claude-opus-5-5",
    permissions: "auto",
    repo,
    baseSha: sha,
    acceptance: "README contains sealed",
    dependencies: [],
    requiredEvidence: ["commit"],
    owner: "Bryant Thornton",
    authority: "qa handoff proof",
  }, deps).task;
  const launched = await launchFactoryTask(created.id, { start: () => {} });
  const built = commit(created.worktree!, "base\nsealed\n");
  const host: FactoryCompletionDeps = { ok: true, ...deliverDeps(deps, starts) };
  const routed = await completeFactoryTurn(launched.task.ombThreadId!, host);
  const seated = routed.task!;
  const candidate = seated.revisions?.find((item) => item.kind === "candidate");
  if (!candidate) throw new Error("candidate was not sealed");
  const rejected = harvestFactoryTask(seated.id, {
    sessionId: seated.sessionId,
    worktree: seated.worktree,
    resultSha: DEAD,
    reviewedSha: DEAD,
    qaDisposition: "CLEAR",
    evidence: [{ kind: "note", ref: DEAD, note: "disposable scratch mismatch" }],
  });
  const rejection = rejected.revisions?.find((item) => item.kind === "rejection" && item.sha === DEAD);
  if (!rejection) throw new Error("rejection was not stored");
  return { id: seated.id, built, qaSession: seated.sessionId!, candidateId: candidate.id, rejection, deps, starts };
}

function rejectionOf(task: FactoryTask | undefined, id: string): FactoryRevision {
  const found = task?.revisions?.find((item) => item.id === id);
  if (!found) throw new Error(`revision ${id} missing`);
  return found;
}

beforeEach(() => {
  try { unlinkSync(join(DATA_DIR, "factory-tasks.json")); } catch { /* fresh */ }
  _resetFactoryDispatch();
});

describe("queued QA handoff", () => {
  it("keeps the rejection and starts a new QA session against the sealed SHA", async () => {
    const seated = await sealMismatch();
    const before = getFactoryTask(seated.id)!;
    expect(before.qaDisposition).toBeUndefined();
    expect(before.resultSha).toBe(seated.built);
    expect(before.sessionId).toBe(seated.qaSession);
    const queued = before.handoffs?.find((item) => !item.deliveredAt && item.resultSha === seated.built);
    expect(queued?.nextAction).toContain(seated.built);
    const rejectionBefore = JSON.stringify(rejectionOf(before, seated.rejection.id));
    const candidateBefore = JSON.stringify(before.revisions?.find((item) => item.id === seated.candidateId));

    const started = await deliverHandoff(seated.id, deliverDeps(seated.deps, seated.starts), { handoffId: queued!.id });
    expect(started.task.sessionId).toBeTruthy();
    expect(started.task.sessionId).not.toBe(seated.qaSession);
    expect(started.task.status).toBe("running");
    expect(started.task.role).toBe("qa");
    expect(started.task.writerLock).toBe("review");
    expect(started.task.qaDisposition).toBeUndefined();
    expect(started.task.resultSha).toBe(seated.built);
    expect(started.task.handoffs?.find((item) => item.id === queued!.id)?.deliveredAt).toBeTypeOf("number");
    expect(started.task.qaAttempts?.some((item) => item.sessionId === started.task.sessionId && item.sha === seated.built && item.handoffId === queued!.id)).toBe(true);
    expect(started.task.qaAttempts?.some((item) => item.sessionId === seated.qaSession && item.sha === DEAD)).toBe(false);
    expect(JSON.stringify(rejectionOf(started.task, seated.rejection.id))).toBe(rejectionBefore);
    expect(JSON.stringify(started.task.revisions?.find((item) => item.id === seated.candidateId))).toBe(candidateBefore);
    expect(enforceFactoryTool({ role: "qa", worktree: started.task.worktree!, tool: "Write", input: { file_path: join(started.task.worktree!, "README") } }).allow).toBe(false);
    expect(execSync("git rev-parse HEAD", { cwd: started.task.worktree }).toString().trim()).toBe(seated.built);
  });

  it("does not mark a failed launch as delivered", async () => {
    const seated = await sealMismatch();
    const before = getFactoryTask(seated.id)!;
    const queued = before.handoffs?.find((item) => !item.deliveredAt);
    if (!queued) throw new Error("handoff was not queued");
    const rejectionBefore = JSON.stringify(rejectionOf(before, seated.rejection.id));
    let starts = 0;
    await expect(deliverHandoff(seated.id, deliverDeps(seated.deps, seated.starts, () => {
      starts += 1;
      throw new Error("worker failed");
    }), { handoffId: queued.id })).rejects.toBeInstanceOf(FactoryDispatchError);
    const after = getFactoryTask(seated.id)!;
    expect(starts).toBe(1);
    expect(after.status).not.toBe("running");
    expect(after.status === "blocked" || after.status === "waiting_qa").toBe(true);
    expect(after.blocker ?? after.nextAction ?? "").not.toBe("");
    expect(after.handoffs?.find((item) => item.id === queued.id)?.deliveredAt).toBeUndefined();
    expect(after.sessionId).toBe(seated.qaSession);
    expect(after.qaAttempts?.some((item) => item.sessionId !== seated.qaSession)).toBe(false);
    expect(JSON.stringify(rejectionOf(after, seated.rejection.id))).toBe(rejectionBefore);
    expect(after.revisions?.find((item) => item.id === seated.candidateId)?.sha).toBe(seated.built);
    expect(after.qaDisposition).toBeUndefined();
  });

  it("consumes an already waiting handoff from a previous process", async () => {
    const { repo, sha } = initRepo();
    const built = commit(repo, "base\nsealed\n");
    const worktree = join(tmpdir(), `omb-qa-wt-${built.slice(0, 8)}`);
    execSync(`git worktree add --detach ${JSON.stringify(worktree)} ${built}`, { cwd: repo });
    const tree = treeOf(worktree, built);
    const now = Date.now();
    const candidate = {
      id: "cacb9041-46bc-4eff-9f25-000ad3677f24",
      kind: "candidate",
      sessionId: "4da54f69-6f79-4129-89df-0b9ac6e7eedb",
      specialistId: IMPLEMENTER_ID,
      generation: 1,
      sha: built,
      tree,
      worktree,
      evidence: [{ at: now, kind: "seal", ref: built, note: "fixture seal" }],
      findings: [],
      nextAction: `sealed candidate ${built}`,
      createdAt: now,
    };
    const rejection = {
      id: LIVE_REJECTION,
      kind: "rejection",
      sessionId: LIVE_SESSION,
      specialistId: REVIEWER_ID,
      generation: 1,
      sha: REJECTED_SHA,
      evidence: [{ at: now, kind: "rejection", ref: REJECTED_SHA, note: "fixture rejection" }],
      findings: [`claimed ${REJECTED_SHA}`],
      nextAction: `rejected stale SHA ${REJECTED_SHA}`,
      createdAt: now,
    };
    const task = {
      id: LIVE_TASK,
      objective: "Review the sealed candidate",
      specialistId: REVIEWER_ID,
      specialistKey: "independent-qa",
      role: "qa",
      model: "claude-opus-5-5",
      permissions: "auto",
      repo,
      baseSha: sha,
      acceptance: "review only",
      dependencies: [],
      requiredEvidence: ["review"],
      status: "waiting_qa",
      worktree,
      sessionId: LIVE_SESSION,
      resultSha: built,
      headSha: built,
      evidence: [{ at: now, kind: "commit", ref: built }, { at: now, kind: "rejection", ref: REJECTED_SHA }],
      checks: [],
      implementerId: IMPLEMENTER_ID,
      assignedReviewerId: REVIEWER_ID,
      phase: "review",
      writerLock: "review",
      generation: 1,
      branch: "HEAD",
      revisions: [candidate, rejection],
      handoffs: [{
        id: LIVE_HANDOFF,
        taskId: LIVE_TASK,
        stage: "review",
        repo,
        worktree,
        inputSha: built,
        resultSha: built,
        fromSpecialistId: IMPLEMENTER_ID,
        toSpecialistId: REVIEWER_ID,
        summary: `Rejected QA submission did not match sealed candidate ${built.slice(0, 12)}; candidate unchanged`,
        requiredEvidence: ["review"],
        checks: [],
        findings: [],
        nextAction: `fresh independent QA of sealed candidate ${built}`,
        createdAt: now,
      }],
      owner: "Bryant Thornton",
      authority: "fixture",
      createdAt: now,
      updatedAt: now,
      nextAction: `fresh independent QA of sealed candidate ${built}`,
    };
    writeFileSync(join(DATA_DIR, "factory-tasks.json"), JSON.stringify({ version: 1, tasks: [task], unavailableRoles: [] }));
    _resetFactoryDispatch();
    const deps = local();
    const starts = { n: 0 };
    const started = await deliverHandoff(LIVE_TASK, deliverDeps(deps, starts), { handoffId: LIVE_HANDOFF });
    expect(starts.n).toBe(1);
    expect(started.task.sessionId).not.toBe(LIVE_SESSION);
    expect(started.task.status).toBe("running");
    expect(started.task.writerLock).toBe("review");
    expect(started.task.qaAttempts?.map((item) => ({ sessionId: item.sessionId, sha: item.sha, handoffId: item.handoffId }))).toEqual([
      { sessionId: started.task.sessionId, sha: built, handoffId: LIVE_HANDOFF },
    ]);
    expect(started.task.revisions?.find((item) => item.id === LIVE_REJECTION)).toEqual(rejection);
    expect(started.task.revisions?.find((item) => item.kind === "candidate")).toEqual(candidate);
    expect(started.task.qaDisposition).toBeUndefined();
    expect(execSync("git rev-parse HEAD", { cwd: worktree }).toString().trim()).toBe(built);
  });
});

describe("QA-only desk task", () => {
  it("does not need an implementer task and binds the reviewer to the exact head on a read-only worktree", async () => {
    const { repo, sha } = initRepo();
    const head = commit(repo, "base\nreviewed\n");
    const deps = local();
    expect(() => createFactoryTask({
      objective: "Review only",
      specialistId: REVIEWER_ID,
      model: "claude-opus-5-5",
      permissions: "auto",
      repo,
      baseSha: sha,
      acceptance: "read the diff",
      dependencies: [],
      requiredEvidence: ["review"],
      owner: "Bryant Thornton",
      authority: "qa only",
    }, deps)).toThrow(/QA requires the implementer task and its result SHA/);

    const created = createFactoryTask({
      objective: "Review only",
      specialistId: REVIEWER_ID,
      model: "claude-opus-5-5",
      permissions: "auto",
      repo,
      baseSha: sha,
      headSha: head,
      prUrl: "https://github.com/example/repo/pull/8",
      acceptance: "read the diff",
      dependencies: [],
      requiredEvidence: ["review"],
      owner: "Bryant Thornton",
      authority: "qa only",
    }, deps).task;
    expect(created.qaOfTaskId).toBeUndefined();
    expect(created.implementerId).toBeUndefined();
    expect(created.qaOnly).toBe(true);
    expect(created.readOnlyWorktree).toBe(true);
    expect(created.role).toBe("qa");
    expect(created.headSha).toBe(head);
    expect(created.baseSha).toBe(sha);
    expect(execSync("git rev-parse HEAD", { cwd: created.worktree }).toString().trim()).toBe(head);
    expect(() => accessSync(join(created.worktree!, "README"), constants.W_OK)).toThrow();
    expect(enforceFactoryTool({ role: created.role, worktree: created.worktree!, tool: "Edit", input: { file_path: join(created.worktree!, "README") } }).allow).toBe(false);

    let started = 0;
    const launched = await launchFactoryTask(created.id, {
      start: () => { started += 1; },
      prHead: () => head,
    });
    expect(started).toBe(1);
    expect(launched.task.sessionId).toBeTruthy();
    expect(launched.task.qaAttempts).toEqual([
      expect.objectContaining({ sessionId: launched.task.sessionId, sha: head }),
    ]);
    expect(launched.task.status).toBe("running");
    try { if (created.worktree) releaseWorktreeReadOnly(created.worktree); } catch { /* cleanup */ }
  });

  it("refuses launch when the pull request head drifted", async () => {
    const { repo, sha } = initRepo();
    const head = commit(repo, "base\nreviewed\n");
    const drifted = "0123456789abcdef0123456789abcdef01234567";
    const deps = local();
    const created = createFactoryTask({
      objective: "Review only",
      specialistId: REVIEWER_ID,
      model: "claude-opus-5-5",
      permissions: "auto",
      repo,
      baseSha: sha,
      headSha: head,
      prUrl: "https://github.com/example/repo/pull/9",
      acceptance: "read the diff",
      dependencies: [],
      requiredEvidence: ["review"],
      owner: "Bryant Thornton",
      authority: "qa only",
    }, deps).task;
    let started = 0;
    await expect(launchFactoryTask(created.id, {
      start: () => { started += 1; },
      prHead: () => drifted,
    })).rejects.toThrow(/exact SHA/);
    expect(started).toBe(0);
    const after = getFactoryTask(created.id)!;
    expect(after.sessionId).toBeUndefined();
    expect(after.status).toBe("blocked");
    expect(after.status).not.toBe("running");
    expect(after.blocker).toContain(drifted);
    expect(after.qaAttempts ?? []).toEqual([]);
    try { if (created.worktree) releaseWorktreeReadOnly(created.worktree); } catch { /* cleanup */ }
  });
});
