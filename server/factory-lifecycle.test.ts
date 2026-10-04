import { execSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import {
  IMPLEMENTER_ID,
  REVIEWER_ID,
  completeFactoryTurn,
  createFactoryTask,
  harvestFactoryTask,
  launchFactoryTask,
  noteFactorySession,
  recoverFactoryTasks,
  _resetFactoryDispatch,
  type FactoryBot,
  type FactoryCompletionDeps,
} from "./factory-dispatch.ts";

function initRepo(): { repo: string; sha: string } {
  const repo = mkdtempSync(join(tmpdir(), "omb-life-"));
  execSync("git init -b main", { cwd: repo });
  execSync("git config user.email factory@example.com", { cwd: repo });
  execSync("git config user.name factory", { cwd: repo });
  writeFileSync(join(repo, "README"), "base\n");
  mkdirSync(join(repo, ".omb"));
  writeFileSync(join(repo, ".omb", "required-tests"), "#!/bin/sh\nhead=$(git rev-parse HEAD)\n[ \"$1\" = \"$head\" ] || exit 1\ngrep -q fixed README || exit 1\nexit 0\n");
  chmodSync(join(repo, ".omb", "required-tests"), 0o755);
  execSync("git add README .omb && git commit -m base", { cwd: repo });
  return { repo, sha: execSync("git rev-parse HEAD", { cwd: repo }).toString().trim() };
}

function commit(worktree: string, body: string): string {
  writeFileSync(join(worktree, "README"), body);
  execSync("git add README && git commit -m change", { cwd: worktree });
  return execSync("git rev-parse HEAD", { cwd: worktree }).toString().trim();
}

function local() {
  let n = 0;
  const threads: { threadId: string; cwd?: string }[] = [];
  const bot = (id: string): FactoryBot => ({ id, model: "claude-opus-5-5", driverKind: "claudeAgent" });
  const createThread = (id: string) => {
    const threadId = `life-${id.slice(0, 8)}-${n++}`;
    threads.push({ threadId });
    return { threadId };
  };
  const pinCwd = (_id: string, threadId: string, cwd: string) => {
    const row = threads.find((item) => item.threadId === threadId);
    if (row) row.cwd = cwd;
  };
  return { threads, bot, createThread, pinCwd };
}

function completion(threadId: string, deps: ReturnType<typeof local>, starts: { n: number }, ok = true) {
  const host: FactoryCompletionDeps = {
    ok,
    bot: deps.bot,
    createThread: deps.createThread,
    pinCwd: deps.pinCwd,
    start: () => { starts.n += 1; },
  };
  return completeFactoryTurn(threadId, host);
}

beforeEach(() => {
  try { unlinkSync(join(DATA_DIR, "factory-tasks.json")); } catch { /* fresh */ }
  _resetFactoryDispatch();
});

describe("server-owned factory lifecycle", () => {
  it("adopts a clean descendant HEAD only after the writer session ends", async () => {
    const { repo, sha } = initRepo();
    const deps = local();
    const starts = { n: 0 };
    const task = createFactoryTask({
      objective: "Add a harmless line",
      specialistId: IMPLEMENTER_ID,
      model: "claude-opus-5-5",
      permissions: "auto",
      repo,
      baseSha: sha,
      acceptance: "README contains fixed",
      dependencies: [],
      requiredEvidence: ["commit"],
      owner: "Bryant Thornton",
      authority: "lifecycle proof",
    }, deps).task;
    const launched = await launchFactoryTask(task.id, { start: () => {} });
    const built = commit(task.worktree!, "base\nfixed\n");
    const writerSession = launched.task.sessionId!;
    const writerThread = launched.task.ombThreadId!;
    const mismatched = harvestFactoryTask(task.id, {
      sessionId: writerSession,
      worktree: task.worktree,
      resultSha: sha,
      evidence: [{ kind: "commit", ref: sha, note: "agent named the base" }],
    });
    const rejection = mismatched.revisions?.find((item) => item.kind === "rejection" && item.sha === sha);
    expect(mismatched.status).toBe("blocked");
    expect(mismatched.blocker).toMatch(/writer session has not ended/);
    expect(mismatched.resultSha).toBeUndefined();
    expect(mismatched.revisions?.some((item) => item.kind === "candidate")).toBe(false);
    expect(rejection?.sha).toBe(sha);

    const routed = await completion(writerThread, deps, starts);
    expect(routed.task?.status).toBe("running");
    expect(routed.task?.phase).toBe("review");
    expect(routed.task?.resultSha).toBe(built);
    expect(routed.task?.headSha).toBe(built);
    expect(routed.task?.specialistId).toBe(REVIEWER_ID);
    expect(routed.task?.sessionId).not.toBe(writerSession);
    expect(routed.task?.revisions?.find((item) => item.kind === "candidate")?.sha).toBe(built);
    expect(routed.task?.revisions?.find((item) => item.id === rejection?.id)?.sha).toBe(sha);
    expect(routed.task?.checkResults?.some((check) => check.sha === built && check.result === "pass")).toBe(true);
    expect(starts.n).toBe(1);
    const again = await completion(writerThread, deps, starts);
    expect(again.duplicate).toBe(true);
    expect(starts.n).toBe(1);
  });

  it("stays blocked when the worktree is dirty or HEAD does not descend from the recorded base", async () => {
    const { repo, sha } = initRepo();
    const deps = local();
    const starts = { n: 0 };
    const task = createFactoryTask({
      objective: "Add a harmless line",
      specialistId: IMPLEMENTER_ID,
      model: "claude-opus-5-5",
      permissions: "auto",
      repo,
      baseSha: sha,
      acceptance: "README contains fixed",
      dependencies: [],
      requiredEvidence: ["commit"],
      owner: "Bryant Thornton",
      authority: "lifecycle proof",
    }, deps).task;
    const launched = await launchFactoryTask(task.id, { start: () => {} });
    const built = commit(task.worktree!, "base\nfixed\n");
    writeFileSync(join(task.worktree!, "untracked.txt"), "concurrent\n");
    const dirty = harvestFactoryTask(task.id, {
      sessionId: launched.task.sessionId,
      worktree: task.worktree,
      resultSha: sha,
      evidence: [{ kind: "commit", ref: sha }],
    });
    expect(dirty.revisions?.filter((item) => item.kind === "rejection")).toHaveLength(1);
    const afterEnd = await completion(launched.task.ombThreadId!, deps, starts);
    expect(afterEnd.task?.status).toBe("blocked");
    expect(afterEnd.task?.blocker).toMatch(/not clean/);
    expect(afterEnd.task?.resultSha).toBeUndefined();
    expect(afterEnd.task?.revisions?.some((item) => item.kind === "candidate")).toBe(false);
    expect(afterEnd.task?.revisions?.find((item) => item.kind === "rejection")?.sha).toBe(sha);
    expect(starts.n).toBe(0);

    const other = initRepo();
    const otherTask = createFactoryTask({
      objective: "Add a harmless line",
      specialistId: IMPLEMENTER_ID,
      model: "claude-opus-5-5",
      permissions: "auto",
      repo: other.repo,
      baseSha: other.sha,
      acceptance: "README contains fixed",
      dependencies: [],
      requiredEvidence: ["commit"],
      owner: "Bryant Thornton",
      authority: "lifecycle proof",
      dispatchKey: "orphan",
    }, deps).task;
    const otherLaunch = await launchFactoryTask(otherTask.id, { start: () => {} });
    const tree = execSync("git rev-parse HEAD^{tree}", { cwd: otherTask.worktree }).toString().trim();
    const orphan = execSync(`git commit-tree ${tree} -m orphan`, { cwd: otherTask.worktree }).toString().trim();
    execSync(`git reset --hard ${orphan}`, { cwd: otherTask.worktree });
    const claimed = harvestFactoryTask(otherTask.id, {
      sessionId: otherLaunch.task.sessionId,
      worktree: otherTask.worktree,
      resultSha: other.sha,
      evidence: [{ kind: "commit", ref: other.sha }],
    });
    expect(claimed.status).toBe("blocked");
    const ended = await completion(otherLaunch.task.ombThreadId!, deps, starts);
    expect(ended.task?.status).toBe("blocked");
    expect(ended.task?.blocker).toMatch(/recorded base|latest assigned writer/);
    expect(ended.task?.revisions?.some((item) => item.kind === "candidate")).toBe(false);
    expect(ended.task?.revisions?.some((item) => item.kind === "rejection" && item.sha === other.sha)).toBe(true);
    expect(execSync("git rev-parse HEAD", { cwd: otherTask.worktree }).toString().trim()).toBe(orphan);
    expect(orphan).not.toBe(other.sha);
    expect(built).not.toBe(sha);
  });

  it("routes NOT_CLEAR to a new implementation session, retests, and requires fresh QA on the new SHA", async () => {
    const { repo, sha } = initRepo();
    const deps = local();
    const starts = { n: 0 };
    const task = createFactoryTask({
      objective: "Add a harmless line",
      specialistId: IMPLEMENTER_ID,
      model: "claude-opus-5-5",
      permissions: "auto",
      repo,
      baseSha: sha,
      acceptance: "README contains fixed",
      dependencies: [],
      requiredEvidence: ["commit"],
      owner: "Bryant Thornton",
      authority: "lifecycle proof",
      remediationLimit: 2,
    }, deps).task;
    const launched = await launchFactoryTask(task.id, { start: () => {} });
    const built = commit(task.worktree!, "base\nharmless\n");
    const writerThread = launched.task.ombThreadId!;
    const reviewTurn = await completion(writerThread, deps, starts);
    expect(starts.n).toBe(1);
    const qaSession = reviewTurn.task!.sessionId!;
    const found = harvestFactoryTask(task.id, {
      sessionId: qaSession,
      worktree: task.worktree,
      resultSha: built,
      evidence: [{ kind: "review", ref: built }],
      findings: ["missing fixed"],
      qaDisposition: "NOT_CLEAR",
      reviewedSha: built,
    });
    expect(found.writerLock).toBe("implementer");
    expect(found.phase).toBe("remediate");
    const oldReview = found.revisions?.find((item) => item.kind === "review");
    expect(oldReview?.sha).toBe(built);
    const repeated = harvestFactoryTask(task.id, {
      sessionId: qaSession,
      worktree: task.worktree,
      resultSha: built,
      evidence: [{ kind: "review", ref: built }],
      findings: ["missing fixed"],
      qaDisposition: "NOT_CLEAR",
      reviewedSha: built,
    });
    expect(repeated.remediationCount).toBe(1);
    expect(repeated.revisions?.find((item) => item.id === oldReview?.id)?.sha).toBe(built);
    const qaThread = reviewTurn.task!.ombThreadId!;
    const fixTurn = await completion(qaThread, deps, starts);
    expect(fixTurn.task?.specialistId).toBe(IMPLEMENTER_ID);
    expect(fixTurn.task?.sessionId).not.toBe(qaSession);
    expect(fixTurn.task?.ombThreadId).not.toBe(qaThread);
    expect(starts.n).toBe(2);
    const again = await completion(qaThread, deps, starts);
    expect(again.duplicate).toBe(true);
    expect(starts.n).toBe(2);

    const fixed = commit(task.worktree!, "base\nharmless\nfixed\n");
    const fixThread = fixTurn.task!.ombThreadId!;
    const fixSession = fixTurn.task!.sessionId!;
    const fresh = await completion(fixThread, deps, starts);
    expect(fresh.task?.resultSha).toBe(fixed);
    expect(fresh.task?.headSha).toBe(fixed);
    expect(fresh.task?.generation).toBe(2);
    expect(fresh.task?.reviewSha).toBeUndefined();
    expect(fresh.task?.testSha).toBeUndefined();
    expect(fresh.task?.releaseSha).toBeUndefined();
    expect(fresh.task?.qaDisposition).toBeUndefined();
    expect(fresh.task?.specialistId).toBe(REVIEWER_ID);
    expect(fresh.task?.sessionId).not.toBe(fixSession);
    expect(fresh.task?.checkResults?.some((check) => check.name === "required-tests" && check.result === "pass" && check.sha === fixed)).toBe(true);
    expect(fresh.task?.revisions?.find((item) => item.id === oldReview?.id)?.sha).toBe(built);
    expect(fresh.task?.revisions?.some((item) => item.kind === "implementation" && item.sha === fixed && item.generation === 2)).toBe(true);
    expect(fresh.task?.phase).toBe("review");
    expect(starts.n).toBe(3);

    const duplicate = await completion(fixThread, deps, starts);
    expect(duplicate.duplicate).toBe(true);
    expect(starts.n).toBe(3);
  });

  it("restores one proven binding on restart and does not start a second writer", async () => {
    const { repo, sha } = initRepo();
    const deps = local();
    const starts = { n: 0 };
    const task = createFactoryTask({
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
      authority: "lifecycle proof",
    }, deps).task;
    const launched = await launchFactoryTask(task.id, { start: () => { starts.n += 1; } });
    noteFactorySession(launched.task.ombThreadId!, launched.task.sessionId!);
    _resetFactoryDispatch();
    const recovered = recoverFactoryTasks();
    expect(recovered.restored).toEqual([task.id]);
    expect(recovered.blocked).toEqual([]);
    const boundThread = launched.task.ombThreadId!;
    const first = await completion(boundThread, deps, starts);
    const second = await completion(boundThread, deps, starts);
    expect(second.duplicate).toBe(true);
    expect(first.task?.sessionId === launched.task.sessionId || first.task?.threads?.some((row) => row.threadId === launched.task.ombThreadId)).toBe(true);
    expect(starts.n).toBeLessThanOrEqual(2);
    const file = JSON.parse(readFileSync(join(DATA_DIR, "factory-tasks.json"), "utf8"));
    const row = file.tasks.find((item: { id: string }) => item.id === task.id);
    const writers = row.threads.filter((item: { specialistId: string }) => item.specialistId === IMPLEMENTER_ID);
    expect(writers).toHaveLength(1);
  });
});
