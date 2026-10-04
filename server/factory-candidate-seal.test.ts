// Regression for the sealed-candidate handoff.
// Facts, not fixtures to edit: task ebb317f0-6cfe-4502-aa49-c988a68338c3
// blocked after implementer d7271658-1fad-45e3-bb3e-ce5055f1c673 sealed
// 6efe16bab64f3b38ae01dc8ccca715cf4d9ae284 (base
// d7fe06380c5d93284d3db17653900963ed154f91), QA
// d37cc504-cefd-4da9-9c49-a37530babbe3 submitted
// deadbeefdeadbeefdeadbeefdeadbeefdeadbeef, and harvest stayed blocked on
// "writer session has not ended" after the lease had already moved.
// Task e4436b75-4188-402e-b04a-bcd1034ecbaf is only a reminder that a later
// shipped record must not be rewritten by this path.
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { enforceFactoryTool } from "./factory-boundary.ts";
import {
  IMPLEMENTER_ID,
  REVIEWER_ID,
  completeFactoryTurn,
  createFactoryTask,
  factorySpecialistPrompt,
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

async function sealAndHandOff(): Promise<{
  task: FactoryTask;
  base: string;
  built: string;
  writerSession: string;
  writerThread: string;
  qaSession: string;
  qaThread: string;
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
  return {
    task,
    base: sha,
    built,
    writerSession,
    writerThread,
    qaSession: task.sessionId!,
    qaThread: task.ombThreadId!,
    candidate,
    deps,
    starts,
  };
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

describe("sealed candidate before QA harvest", () => {
  it("seals the implementer candidate, rejects deadbeef, and reschedules QA against that SHA", async () => {
    const seated = await sealAndHandOff();
    expect(seated.starts.n).toBe(1);
    expect(seated.task.specialistId).toBe(REVIEWER_ID);
    expect(seated.task.role).toBe("qa");
    expect(seated.task.writerLock).toBe("review");
    expect(seated.task.sessionId).not.toBe(seated.writerSession);
    expect(seated.built).not.toBe(seated.base);
    expect(execSync(`git merge-base --is-ancestor ${seated.base} ${seated.built}`, { cwd: seated.task.worktree }).toString()).toBe("");
    const sealed = snapshot(seated.candidate);
    expect(sealed.sha).toBe(seated.built);
    expect(sealed.tree).toBe(treeOf(seated.task.worktree!, seated.built));
    expect(sealed.worktree).toBe(seated.task.worktree);
    expect(sealed.sessionId).toBe(seated.writerSession);
    expect(sealed.generation).toBe(1);
    expect(seated.candidate.evidence.some((item) => item.kind === "seal" && item.ref === seated.built)).toBe(true);
    expect(seated.candidate.evidence.some((item) => item.note?.includes(seated.writerSession))).toBe(true);

    const again = await completion(seated.writerThread, seated.deps, seated.starts);
    expect(again.duplicate).toBe(true);
    expect(seated.starts.n).toBe(1);

    const rejected = harvestFactoryTask(seated.task.id, {
      sessionId: seated.qaSession,
      worktree: seated.task.worktree,
      resultSha: DEAD,
      reviewedSha: DEAD,
      qaDisposition: "CLEAR",
      evidence: [{ kind: "note", ref: DEAD, note: "disposable scratch mismatch" }],
    });
    expect(rejected.blocker ?? "").not.toMatch(/writer session has not ended/);
    expect(rejected.qaDisposition).toBeUndefined();
    expect(rejected.reviewedSha).toBeUndefined();
    expect(rejected.status).toBe("waiting_qa");
    expect(rejected.phase).toBe("review");
    expect(rejected.writerLock).toBe("review");
    expect(rejected.resultSha).toBe(seated.built);
    expect(rejected.headSha).toBe(seated.built);
    expect(rejected.nextAction).toBe(`fresh independent QA of sealed candidate ${seated.built}`);
    const rejection = rejected.revisions?.filter((item) => item.kind === "rejection" && item.sha === DEAD);
    expect(rejection).toHaveLength(1);
    expect(rejection?.[0]?.sessionId).toBe(seated.qaSession);
    expect(rejected.evidence.some((item) => item.kind === "rejection" && item.ref === DEAD)).toBe(true);
    expect(rejected.revisions?.some((item) => item.disposition === "CLEAR")).toBe(false);
    expect(snapshot(mustRevision(rejected.revisions, sealed.id))).toEqual(sealed);
    const scheduled = rejected.handoffs?.filter((item) => !item.deliveredAt && item.stage === "review" && item.toSpecialistId === REVIEWER_ID);
    expect(scheduled).toHaveLength(1);
    expect(scheduled?.[0]?.resultSha).toBe(seated.built);
    expect(scheduled?.[0]?.inputSha).toBe(seated.built);
    expect(scheduled?.[0]?.nextAction).toContain(seated.built);

    const duplicateQa = harvestFactoryTask(seated.task.id, {
      sessionId: seated.qaSession,
      worktree: seated.task.worktree,
      resultSha: DEAD,
      reviewedSha: DEAD,
      qaDisposition: "CLEAR",
      evidence: [{ kind: "note", ref: DEAD, note: "duplicate QA event" }],
    });
    expect(duplicateQa.revisions?.filter((item) => item.kind === "rejection" && item.sha === DEAD)).toHaveLength(1);
    expect(duplicateQa.handoffs?.filter((item) => !item.deliveredAt && item.resultSha === seated.built)).toHaveLength(1);
    expect(duplicateQa.qaDisposition).toBeUndefined();
    expect(snapshot(mustRevision(duplicateQa.revisions, sealed.id))).toEqual(sealed);

    const fresh = await completion(seated.qaThread, seated.deps, seated.starts);
    expect(seated.starts.n).toBe(2);
    expect(fresh.task?.specialistId).toBe(REVIEWER_ID);
    expect(fresh.task?.sessionId).not.toBe(seated.qaSession);
    expect(fresh.task?.ombThreadId).not.toBe(seated.qaThread);
    if (!fresh.task) throw new Error("fresh QA was not seated");
    expect(factorySpecialistPrompt(fresh.task)).toContain(seated.built);
    expect(fresh.task?.handoffs?.some((item) => item.deliveredAt && item.resultSha === seated.built && item.nextAction.includes(seated.built))).toBe(true);
    expect(fresh.task?.revisions?.some((item) => item.kind === "rejection" && item.sha === DEAD && item.sessionId === seated.qaSession)).toBe(true);
    expect(snapshot(mustRevision(fresh.task?.revisions, sealed.id))).toEqual(sealed);
    const duplicateTurn = await completion(seated.qaThread, seated.deps, seated.starts);
    expect(duplicateTurn.duplicate).toBe(true);
    expect(seated.starts.n).toBe(2);
    expect(getFactoryTask(seated.task.id)?.revisions?.filter((item) => item.kind === "candidate" && item.sha === seated.built)).toHaveLength(1);
  });

  it("blocks a dirty or changed worktree after sealing and does not adopt the new HEAD", async () => {
    const dirty = await sealAndHandOff();
    writeFileSync(join(dirty.task.worktree!, "untracked.txt"), "concurrent\n");
    const held = harvestFactoryTask(dirty.task.id, {
      sessionId: dirty.qaSession,
      worktree: dirty.task.worktree,
      resultSha: dirty.built,
      reviewedSha: dirty.built,
      qaDisposition: "CLEAR",
      evidence: [{ kind: "review", ref: dirty.built }],
    });
    expect(held.status).toBe("blocked");
    expect(held.blocker).toMatch(/not clean after the candidate was sealed/);
    expect(held.qaDisposition).toBeUndefined();
    expect(held.resultSha).toBe(dirty.built);
    expect(held.revisions?.some((item) => item.kind === "review")).toBe(false);
    expect(snapshot(mustRevision(held.revisions, dirty.candidate.id))).toEqual(snapshot(dirty.candidate));

    const moved = await sealAndHandOff();
    const rewritten = commit(moved.task.worktree!, "base\nsealed\nrewritten\n");
    expect(rewritten).not.toBe(moved.built);
    const drifted = harvestFactoryTask(moved.task.id, {
      sessionId: moved.qaSession,
      worktree: moved.task.worktree,
      resultSha: rewritten,
      evidence: [{ kind: "note", ref: rewritten, note: "worktree moved" }],
    });
    expect(drifted.status).toBe("blocked");
    expect(drifted.blocker).toMatch(/worktree changed after the candidate was sealed/);
    expect(drifted.resultSha).toBe(moved.built);
    expect(drifted.headSha).toBe(moved.built);
    expect(drifted.revisions?.some((item) => item.kind === "candidate" && item.sha === rewritten)).toBe(false);
    expect(drifted.revisions?.some((item) => item.kind === "rejection" && item.sha === rewritten)).toBe(true);
    expect(snapshot(mustRevision(drifted.revisions, moved.candidate.id))).toEqual(snapshot(moved.candidate));
    expect(drifted.revisions?.find((item) => item.kind === "review")).toBeUndefined();
    expect(execSync("git rev-parse HEAD", { cwd: moved.task.worktree }).toString().trim()).toBe(rewritten);
  });

  it("rejects reviewer writes and does not treat them as a new candidate", () => {
    const worktree = "/workspace/factory-smoke/example";
    expect(enforceFactoryTool({ role: "qa", worktree, tool: "Write", input: { file_path: join(worktree, "a.txt") } }).allow).toBe(false);
    expect(enforceFactoryTool({ role: "reviewer", worktree, tool: "Edit", input: { file_path: join(worktree, "a.txt") } }).allow).toBe(false);
    expect(enforceFactoryTool({ role: "qa", worktree, tool: "Bash", input: { command: "git commit -am x" } }).allow).toBe(false);
  });

  it("keeps the sealed candidate across a proven restart and still rejects a mismatched QA SHA", async () => {
    const seated = await sealAndHandOff();
    noteFactorySession(seated.qaThread, seated.qaSession);
    _resetFactoryDispatch();
    const recovered = recoverFactoryTasks();
    expect(recovered.restored).toEqual([seated.task.id]);
    expect(recovered.blocked).toEqual([]);
    const restored = getFactoryTask(seated.task.id)!;
    expect(restored.status).toBe("running");
    expect(snapshot(mustRevision(restored.revisions, seated.candidate.id))).toEqual(snapshot(seated.candidate));

    const rejected = harvestFactoryTask(seated.task.id, {
      sessionId: seated.qaSession,
      worktree: seated.task.worktree,
      resultSha: DEAD,
      evidence: [{ kind: "note", ref: DEAD, note: "after restart" }],
    });
    expect(rejected.blocker ?? "").not.toMatch(/writer session has not ended/);
    expect(rejected.status).toBe("waiting_qa");
    expect(rejected.nextAction).toContain(seated.built);
    expect(rejected.revisions?.some((item) => item.kind === "rejection" && item.sha === DEAD)).toBe(true);
    const next = rejected.handoffs?.find((item) => !item.deliveredAt);
    expect(next?.resultSha).toBe(seated.built);
    expect(next?.toSpecialistId).toBe(REVIEWER_ID);
    expect(snapshot(mustRevision(rejected.revisions, seated.candidate.id))).toEqual(snapshot(seated.candidate));
  });

  it("does not clear a restart that cannot prove the QA session", async () => {
    const seated = await sealAndHandOff();
    _resetFactoryDispatch();
    const recovered = recoverFactoryTasks();
    expect(recovered.blocked).toEqual([seated.task.id]);
    const harvested = harvestFactoryTask(seated.task.id, {
      sessionId: seated.qaSession,
      worktree: seated.task.worktree,
      resultSha: DEAD,
      evidence: [{ kind: "note", ref: DEAD, note: "unproven restart" }],
    });
    expect(harvested.status).toBe("blocked");
    expect(harvested.blocker).toMatch(/restart recovery failed closed/);
    expect(harvested.qaDisposition).toBeUndefined();
    expect(harvested.handoffs?.some((item) => !item.deliveredAt)).toBe(false);
    expect(snapshot(mustRevision(harvested.revisions, seated.candidate.id))).toEqual(snapshot(seated.candidate));
    expect(harvested.revisions?.some((item) => item.kind === "rejection" && item.sha === DEAD)).toBe(true);
  });
});
