// Regression for the sealed implementation candidate. The server seals the
// writer's verified clean HEAD when the writer session ends; a mismatched SHA
// is kept as rejected evidence and never becomes the result. QA of the sealed
// SHA happens outside OMB, so no QA session is started here.
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { enforceFactoryTool } from "./factory-boundary.ts";
import {
  IMPLEMENTER_ID,
  completeFactoryTurn,
  createFactoryTask,
  getFactoryTask,
  harvestFactoryTask,
  launchFactoryTask,
  noteFactorySession,
  recoverFactoryTasks,
  _resetFactoryDispatch,
  type FactoryBot,
  type FactoryCompletionDeps,
  type FactoryRevision,
  type FactoryTask,
} from "./factory-dispatch.ts";

const DEAD = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

function initRepo(): { repo: string; sha: string } {
  const repo = mkdtempSync(join(tmpdir(), "omb-seal-"));
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
    const threadId = `seal-${scope}-${id.slice(0, 8)}-${n++}`;
    threads.push({ threadId });
    return { threadId };
  };
  const pinCwd = (_id: string, threadId: string, cwd: string) => {
    const row = threads.find((item) => item.threadId === threadId);
    if (row) row.cwd = cwd;
  };
  return { threads, bot, createThread, pinCwd };
}

function completion(threadId: string, deps: ReturnType<typeof local>, starts: { n: number }) {
  const host: FactoryCompletionDeps = {
    ok: true,
    bot: deps.bot,
    createThread: deps.createThread,
    pinCwd: deps.pinCwd,
    start: () => { starts.n += 1; },
  };
  return completeFactoryTurn(threadId, host);
}

function intake(repo: string, sha: string) {
  return {
    objective: "Add a harmless line",
    specialistId: IMPLEMENTER_ID,
    model: "claude-opus-5-5",
    permissions: "auto" as const,
    repo,
    baseSha: sha,
    acceptance: "README contains sealed",
    dependencies: [],
    requiredEvidence: ["commit"],
    owner: "Bryant Thornton",
    authority: "seal proof",
  };
}

async function sealed(): Promise<{
  task: FactoryTask;
  base: string;
  built: string;
  writerSession: string;
  writerThread: string;
  candidate: FactoryRevision;
  deps: ReturnType<typeof local>;
  starts: { n: number };
}> {
  const { repo, sha } = initRepo();
  const deps = local();
  const starts = { n: 0 };
  const created = createFactoryTask(intake(repo, sha), deps).task;
  const launched = await launchFactoryTask(created.id, { start: () => {} });
  const built = commit(created.worktree!, "base\nsealed\n");
  const writerSession = launched.task.sessionId!;
  const writerThread = launched.task.ombThreadId!;
  const routed = await completion(writerThread, deps, starts);
  const task = routed.task!;
  const candidate = task.revisions?.find((item) => item.kind === "candidate");
  if (!candidate) throw new Error("candidate was not sealed");
  return { task, base: sha, built, writerSession, writerThread, candidate, deps, starts };
}

function mustRevision(revisions: FactoryRevision[] | undefined, id: string): FactoryRevision {
  const found = revisions?.find((item) => item.id === id);
  if (!found) throw new Error(`revision ${id} missing`);
  return found;
}

function snapshot(candidate: FactoryRevision) {
  return {
    id: candidate.id,
    sha: candidate.sha,
    tree: candidate.tree,
    worktree: candidate.worktree,
    sessionId: candidate.sessionId,
    generation: candidate.generation,
  };
}

beforeEach(() => {
  try { unlinkSync(join(DATA_DIR, "factory-tasks.json")); } catch { /* fresh */ }
  _resetFactoryDispatch();
});

describe("sealed implementation candidate", () => {
  it("seals the writer's SHA, tree, worktree, and session at the end of the writer session and starts no other session", async () => {
    const seated = await sealed();
    expect(seated.starts.n).toBe(0);
    expect(seated.deps.threads).toHaveLength(1);
    expect(seated.task.specialistId).toBe(IMPLEMENTER_ID);
    expect(seated.task.role).toBe("implementer");
    expect(seated.task.status).toBe("harvested");
    expect(seated.task.resultSha).toBe(seated.built);
    expect(seated.built).not.toBe(seated.base);
    expect(execSync(`git merge-base --is-ancestor ${seated.base} ${seated.built}`, { cwd: seated.task.worktree }).toString()).toBe("");
    const seal = snapshot(seated.candidate);
    expect(seal.sha).toBe(seated.built);
    expect(seal.tree).toBe(treeOf(seated.task.worktree!, seated.built));
    expect(seal.worktree).toBe(seated.task.worktree);
    expect(seal.sessionId).toBe(seated.writerSession);
    expect(seal.generation).toBe(1);
    expect(seated.candidate.evidence.some((item) => item.kind === "seal" && item.ref === seated.built)).toBe(true);
    expect(seated.candidate.evidence.some((item) => item.note?.includes(seated.writerSession))).toBe(true);

    const again = await completion(seated.writerThread, seated.deps, seated.starts);
    expect(again.duplicate).toBe(true);
    expect(seated.starts.n).toBe(0);
    expect(getFactoryTask(seated.task.id)?.revisions?.filter((item) => item.kind === "candidate" && item.sha === seated.built)).toHaveLength(1);
  });

  it("keeps a mismatched SHA as rejected evidence and does not rewrite the sealed candidate", async () => {
    const seated = await sealed();
    const rejected = harvestFactoryTask(seated.task.id, {
      sessionId: seated.writerSession,
      worktree: seated.task.worktree,
      resultSha: DEAD,
      evidence: [{ kind: "note", ref: DEAD, note: "disposable scratch mismatch" }],
    });
    expect(rejected.resultSha).toBe(seated.built);
    expect(rejected.headSha).toBe(seated.built);
    expect(rejected.qaDisposition).toBeUndefined();
    const rejection = rejected.revisions?.filter((item) => item.kind === "rejection" && item.sha === DEAD);
    expect(rejection).toHaveLength(1);
    expect(rejection?.[0]?.sessionId).toBe(seated.writerSession);
    expect(rejected.evidence.some((item) => item.kind === "rejection" && item.ref === DEAD)).toBe(true);
    expect(snapshot(mustRevision(rejected.revisions, seated.candidate.id))).toEqual(snapshot(seated.candidate));
    const duplicate = harvestFactoryTask(seated.task.id, {
      sessionId: seated.writerSession,
      worktree: seated.task.worktree,
      resultSha: DEAD,
      evidence: [{ kind: "note", ref: DEAD, note: "duplicate event" }],
    });
    expect(duplicate.revisions?.filter((item) => item.kind === "rejection" && item.sha === DEAD)).toHaveLength(1);
    expect(duplicate.handoffs ?? []).toEqual([]);
    expect(seated.starts.n).toBe(0);
  });

  it("does not adopt a HEAD that moved after the seal", async () => {
    const seated = await sealed();
    const rewritten = commit(seated.task.worktree!, "base\nsealed\nrewritten\n");
    expect(rewritten).not.toBe(seated.built);
    const drifted = harvestFactoryTask(seated.task.id, {
      sessionId: seated.writerSession,
      worktree: seated.task.worktree,
      resultSha: rewritten,
      evidence: [{ kind: "note", ref: rewritten, note: "worktree moved" }],
    });
    // The task is past implementation: the moved HEAD is evidence only and is not sealed.
    expect(drifted.resultSha).toBe(seated.built);
    expect(drifted.revisions?.some((item) => item.kind === "candidate" && item.sha === rewritten)).toBe(false);
    expect(drifted.revisions?.some((item) => item.kind === "implementation" && item.sha === rewritten)).toBe(false);
    expect(snapshot(mustRevision(drifted.revisions, seated.candidate.id))).toEqual(snapshot(seated.candidate));
    expect(execSync("git rev-parse HEAD", { cwd: seated.task.worktree }).toString().trim()).toBe(rewritten);
  });

  it("still fences the implementer to its worktree and keeps a read-only role fenced", () => {
    const worktree = "/workspace/factory-smoke/example";
    expect(enforceFactoryTool({ role: "implementer", worktree, tool: "Write", input: { file_path: "/tmp/outside.txt" } }).allow).toBe(false);
    expect(enforceFactoryTool({ role: "implementer", worktree, tool: "Bash", input: { command: "git push origin HEAD" } }).allow).toBe(false);
    expect(enforceFactoryTool({ role: "qa", worktree, tool: "Write", input: { file_path: join(worktree, "a.txt") } }).allow).toBe(false);
    expect(enforceFactoryTool({ role: "reviewer", worktree, tool: "Edit", input: { file_path: join(worktree, "a.txt") } }).allow).toBe(false);
  });

  it("restores a proven writer binding on restart and seals only after that session ends", async () => {
    const { repo, sha } = initRepo();
    const deps = local();
    const starts = { n: 0 };
    const created = createFactoryTask(intake(repo, sha), deps).task;
    const launched = await launchFactoryTask(created.id, { start: () => {} });
    noteFactorySession(launched.task.ombThreadId!, launched.task.sessionId!);
    const built = commit(created.worktree!, "base\nsealed\n");
    _resetFactoryDispatch();
    const recovered = recoverFactoryTasks();
    expect(recovered.restored).toEqual([created.id]);
    const desk = harvestFactoryTask(created.id, {
      sessionId: launched.task.sessionId,
      worktree: created.worktree,
      resultSha: built,
      evidence: [{ kind: "commit", ref: built }],
    });
    expect(desk.revisions?.some((item) => item.kind === "candidate")).toBe(false);
    const done = await completion(launched.task.ombThreadId!, deps, starts);
    expect(done.task?.revisions?.find((item) => item.kind === "candidate")?.sha).toBe(built);
    expect(done.task?.status).toBe("harvested");
    expect(starts.n).toBe(0);
    const onDisk = JSON.parse(readFileSync(join(DATA_DIR, "factory-tasks.json"), "utf8"));
    expect(onDisk.tasks[0].revisions.filter((item: { kind: string }) => item.kind === "candidate")).toHaveLength(1);
  });
});
