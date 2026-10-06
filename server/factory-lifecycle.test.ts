import { execFileSync, execSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { FactorySandbox } from "./factory-sandbox.ts";
import {
  IMPLEMENTER_ID,
  QA_OUTSIDE_OMB,
  completeFactoryTurn,
  createFactoryTask,
  FactoryDispatchError,
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
  try { unlinkSync(join(DATA_DIR, "factory-tasks.json")); } catch { /* fresh */ }
  _resetFactoryDispatch();
  sandbox.current = PASS_THROUGH;
});
afterEach(() => { sandbox.current = null; });

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
    // The sealed SHA is the result. No QA or review session is started.
    expect(routed.task?.status).toBe("harvested");
    expect(routed.task?.phase).toBe("implemented");
    expect(routed.task?.writerLock).toBe("none");
    expect(routed.task?.resultSha).toBe(built);
    expect(routed.task?.headSha).toBe(built);
    expect(routed.task?.specialistId).toBe(IMPLEMENTER_ID);
    expect(routed.task?.sessionId).toBe(writerSession);
    expect(routed.task?.nextAction).toContain(QA_OUTSIDE_OMB);
    expect(routed.task?.handoffs ?? []).toEqual([]);
    expect(routed.task?.revisions?.find((item) => item.kind === "candidate")?.sha).toBe(built);
    expect(routed.task?.revisions?.find((item) => item.id === rejection?.id)?.sha).toBe(sha);
    expect(routed.task?.checkResults?.some((check) => check.sha === built && check.result === "pass")).toBe(true);
    expect(starts.n).toBe(0);
    expect(deps.threads).toHaveLength(1);
    const again = await completion(writerThread, deps, starts);
    expect(again.duplicate).toBe(true);
    expect(starts.n).toBe(0);
    expect(again.task?.revisions?.filter((item) => item.kind === "candidate")).toHaveLength(1);
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
    const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: otherTask.worktree, encoding: "utf8" }).trim();
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

  it("does not adopt a HEAD the writer did not produce, and never routes to QA", async () => {
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
    // No commit: HEAD is still the writer's starting SHA.
    const ended = await completion(launched.task.ombThreadId!, deps, starts);
    expect(ended.task?.status).toBe("blocked");
    expect(ended.task?.blocker).toMatch(/not produced by the latest assigned writer/);
    expect(ended.task?.writerLock).toBe("implementer");
    expect(ended.task?.resultSha).toBeUndefined();
    expect(ended.task?.revisions?.some((item) => item.kind === "candidate")).toBe(false);
    expect(ended.task?.handoffs ?? []).toEqual([]);
    expect(starts.n).toBe(0);
    // The blocked writer still reserves the repository.
    expect(() => createFactoryTask({
      objective: "A second writer must not start",
      specialistId: IMPLEMENTER_ID,
      model: "claude-opus-5-5",
      permissions: "auto",
      repo,
      baseSha: sha,
      acceptance: "none",
      dependencies: [],
      requiredEvidence: ["commit"],
      owner: "Bryant Thornton",
      authority: "lifecycle proof",
      dispatchKey: "second",
    }, deps)).toThrow(/writer/);
  });

  it("blocks a worker that did not finish cleanly, keeps its lock, and accepts no SHA", async () => {
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
    commit(task.worktree!, "base\nfixed\n");
    const ended = await completion(launched.task.ombThreadId!, deps, starts, false);
    expect(ended.task?.status).toBe("blocked");
    expect(ended.task?.status).not.toBe("waiting_qa");
    expect(ended.task?.blocker).toMatch(/did not finish cleanly/);
    expect(ended.task?.writerLock).toBe("implementer");
    expect(ended.task?.resultSha).toBeUndefined();
    expect(starts.n).toBe(0);
    expect(() => createFactoryTask({
      objective: "A second writer must not start",
      specialistId: IMPLEMENTER_ID,
      model: "claude-opus-5-5",
      permissions: "auto",
      repo,
      baseSha: sha,
      acceptance: "none",
      dependencies: [],
      requiredEvidence: ["commit"],
      owner: "Bryant Thornton",
      authority: "lifecycle proof",
      dispatchKey: "second",
    }, deps)).toThrow(/writer/);
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
    expect(starts.n).toBe(1);
    const file = JSON.parse(readFileSync(join(DATA_DIR, "factory-tasks.json"), "utf8"));
    const row = file.tasks.find((item: { id: string }) => item.id === task.id);
    const writers = row.threads.filter((item: { specialistId: string }) => item.specialistId === IMPLEMENTER_ID);
    expect(writers).toHaveLength(1);
  });

  it("keeps the worktree lock while a stale SHA is blocked", async () => {
    const { repo, sha } = initRepo();
    const deps = local();
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
    await launchFactoryTask(task.id, { start: () => {} });
    const blocked = harvestFactoryTask(task.id, {
      sessionId: task.sessionId,
      worktree: task.worktree,
      resultSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      evidence: [{ kind: "commit", ref: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", note: "stale" }],
    });
    expect(blocked.status).toBe("blocked");
    expect(() => createFactoryTask({
      objective: "A second writer must not start",
      specialistId: IMPLEMENTER_ID,
      model: "claude-opus-5-5",
      permissions: "auto",
      repo,
      baseSha: sha,
      acceptance: "none",
      dependencies: [],
      requiredEvidence: ["commit"],
      owner: "Bryant Thornton",
      authority: "lifecycle proof",
    }, deps)).toThrow(FactoryDispatchError);
  });
});
