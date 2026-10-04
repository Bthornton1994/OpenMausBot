import { execSync } from "node:child_process";
import { unlinkSync } from "node:fs";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import {
  IMPLEMENTER_ID,
  RELEASE_ID,
  REVIEWER_ID,
  TESTER_ID,
  createFactoryTask,
  deliverHandoff,
  harvestFactoryTask,
  launchFactoryTask,
  recoverFactoryTasks,
  shipFactoryTask,
  _resetFactoryDispatch,
  type FactoryBot,
  type FactoryDeliverDeps,
  type FactoryTask,
} from "./factory-dispatch.ts";

function initRepo(): { repo: string; sha: string } {
  const repo = mkdtempSync(join(tmpdir(), "omb-pipe-"));
  execSync("git init -b main", { cwd: repo });
  execSync("git config user.email factory@example.com", { cwd: repo });
  execSync("git config user.name factory", { cwd: repo });
  writeFileSync(join(repo, "README"), "base\n");
  mkdirSync(join(repo, ".omb"));
  writeFileSync(join(repo, ".omb", "release-gate"), "#!/bin/sh\nhead=$(git rev-parse HEAD)\n[ \"$1\" = \"$head\" ] || exit 1\ngrep -q harmless README || exit 1\nprintf '%s\\n' \"$head\"\n");
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
    remediationLimit: 2,
    ...extra,
  };
}

function deliver(task: FactoryTask, local: ReturnType<typeof deps>, starts: { n: number }) {
  const deps: FactoryDeliverDeps = {
    bot: local.bot,
    createThread: local.createThread,
    pinCwd: local.pinCwd,
    start: () => { starts.n += 1; },
  };
  return deliverHandoff(task.id, deps);
}

beforeEach(() => {
  try { unlinkSync(join(DATA_DIR, "factory-tasks.json")); } catch { /* fresh home */ }
  _resetFactoryDispatch();
});

describe("factory pipeline", () => {
  it("hands off on the same task, refuses a duplicate worker, and loops remediation until the limit", async () => {
    const { repo, sha } = initRepo();
    const local = deps();
    const task = createFactoryTask(intake(repo, sha, { remediationLimit: 1 }), local).task;
    const launched = await launchFactoryTask(task.id, { start: () => {} });
    const built = commit(task.worktree!, "base\nharmless\n");
    const harvested = harvestFactoryTask(task.id, {
      sessionId: launched.task.sessionId,
      worktree: task.worktree,
      resultSha: built,
      evidence: [{ kind: "commit", ref: built }],
    });
    expect(harvested.id).toBe(task.id);
    expect(harvested.handoffs?.[0]?.toSpecialistId).toBe(REVIEWER_ID);
    expect(harvested.handoffs?.[0]?.resultSha).toBe(built);
    expect(harvested.handoffs?.[0]?.deliveredAt).toBeUndefined();
    const onDisk = readFileSync(join(DATA_DIR, "factory-tasks.json"), "utf8");
    expect(onDisk).toContain(REVIEWER_ID);

    const starts = { n: 0 };
    const review = await deliver(harvested, local, starts);
    expect(starts.n).toBe(1);
    expect(review.task.specialistId).toBe(REVIEWER_ID);
    expect(review.task.ombThreadId).not.toBe(task.threads?.[0]?.threadId);
    const again = await deliver(review.task, local, starts);
    expect(again.duplicate).toBe(true);
    expect(starts.n).toBe(1);

    const found = harvestFactoryTask(task.id, {
      sessionId: review.task.sessionId,
      worktree: task.worktree,
      resultSha: built,
      evidence: [{ kind: "review", ref: built }],
      findings: ["line is in the wrong place"],
      qaDisposition: "NOT_CLEAR",
      reviewedSha: built,
    });
    expect(found.writerLock).toBe("implementer");
    expect(found.phase).toBe("remediate");
    expect(found.remediationCount).toBe(1);
    const reviewSession = review.task.sessionId;
    const reviewThread = review.task.ombThreadId;
    const fix = await deliver(found, local, starts);
    expect(fix.task.specialistId).toBe(IMPLEMENTER_ID);
    expect(fix.task.sessionId).not.toBe(reviewSession);
    expect(fix.task.ombThreadId).not.toBe(reviewThread);
    expect(starts.n).toBe(2);

    const fixed = commit(task.worktree!, "base\nharmless\nfixed\n");
    const afterFix = harvestFactoryTask(task.id, {
      sessionId: fix.task.sessionId,
      worktree: task.worktree,
      resultSha: fixed,
      evidence: [{ kind: "commit", ref: fixed }],
    });
    expect(afterFix.reviewSha).toBeUndefined();
    expect(afterFix.testSha).toBeUndefined();
    expect(afterFix.phase).toBe("review");
    expect(afterFix.handoffs?.some((item) => item.stage === "review" && item.resultSha === fixed)).toBe(true);

    const secondReview = await deliver(afterFix, local, starts);
    const limited = harvestFactoryTask(task.id, {
      sessionId: secondReview.task.sessionId,
      worktree: task.worktree,
      resultSha: fixed,
      evidence: [{ kind: "review", ref: fixed }],
      findings: ["still wrong"],
      qaDisposition: "NOT_CLEAR",
      reviewedSha: fixed,
    });
    expect(limited.status).toBe("blocked");
    expect(limited.nextAction).toMatch(/CoS decision needed/);
    expect(limited.evidence.length).toBeGreaterThan(0);
    expect(starts.n).toBe(3);
    const retry = await deliver(limited, local, starts);
    expect(retry.duplicate).toBe(true);
    expect(starts.n).toBe(3);
  });

  it("separates roles, rejects missing evidence, and blocks a release gate that does not authorize the SHA", async () => {
    const { repo, sha } = initRepo();
    const local = deps();
    const task = createFactoryTask(intake(repo, sha), local).task;
    const launched = await launchFactoryTask(task.id, { start: () => {} });
    expect(() => harvestFactoryTask(task.id, {
      sessionId: launched.task.sessionId,
      worktree: task.worktree,
      resultSha: sha,
      evidence: [],
    })).toThrow(/evidence/);
    expect(() => harvestFactoryTask(task.id, {
      sessionId: launched.task.sessionId,
      worktree: task.worktree,
      resultSha: sha,
      evidence: [{ kind: "commit", ref: sha }],
      qaDisposition: "CLEAR",
      reviewedSha: sha,
    })).toThrow(/cannot clear/);

    const built = commit(task.worktree!, "base\nharmless\n");
    harvestFactoryTask(task.id, {
      sessionId: launched.task.sessionId,
      worktree: task.worktree,
      resultSha: built,
      evidence: [{ kind: "commit", ref: built }],
    });
    const starts = { n: 0 };
    const review = await deliver(task, local, starts);
    harvestFactoryTask(task.id, {
      sessionId: review.task.sessionId,
      worktree: task.worktree,
      resultSha: built,
      evidence: [{ kind: "review", ref: built }],
      qaDisposition: "KEEP_DRAFT",
      reviewedSha: built,
    });
    const tester = await deliver(task, local, starts);
    expect(tester.task.specialistId).toBe(TESTER_ID);
    expect(tester.task.role).toBe("reviewer");
    expect(() => harvestFactoryTask(task.id, {
      sessionId: tester.task.sessionId,
      worktree: task.worktree,
      resultSha: built,
      evidence: [{ kind: "test", ref: built }],
      qaDisposition: "CLEAR",
      reviewedSha: built,
    })).toThrow(/assigned independent reviewer/);
    const tested = harvestFactoryTask(task.id, {
      sessionId: tester.task.sessionId,
      worktree: task.worktree,
      resultSha: built,
      evidence: [{ kind: "test", ref: built }],
      checkResults: [{ name: "unit", result: "pass", sha: built }],
    });
    expect(tested.testSha).toBe(built);
    const release = await deliver(tested, local, starts);
    expect(release.task.specialistId).toBe(RELEASE_ID);
    const recorded = harvestFactoryTask(task.id, {
      sessionId: release.task.sessionId,
      worktree: task.worktree,
      resultSha: built,
      evidence: [{ kind: "release", ref: built, note: "outcome recorded" }],
    });
    expect(recorded.releaseSha).toBe(built);
    expect(recorded.phase).not.toBe("shipped");
    expect(() => shipFactoryTask(task.id, { message: "ship it" })).toThrow(/not authorization/);
    expect(() => shipFactoryTask(task.id, { admin: true })).toThrow(/not authorization/);
    const shipped = shipFactoryTask(task.id, {});
    expect(shipped.phase).toBe("shipped");
    expect(shipped.resultSha).toBe(built);

    const other = initRepo();
    const blocked = createFactoryTask(intake(other.repo, other.sha, { dispatchKey: "no-gate" }), deps()).task;
    await launchFactoryTask(blocked.id, { start: () => {} });
    const bare = commit(blocked.worktree!, "base\nharmless\n");
    // remove the gate after the commit so the checked-out SHA has no authorizer
    execSync("git rm -r .omb && git commit -m drop-gate", { cwd: blocked.worktree });
    const ungated = execSync("git rev-parse HEAD", { cwd: blocked.worktree }).toString().trim();
    expect(ungated).not.toBe(bare);
    harvestFactoryTask(blocked.id, {
      sessionId: blocked.sessionId,
      worktree: blocked.worktree,
      resultSha: ungated,
      evidence: [{ kind: "commit", ref: ungated }],
    });
    const starts2 = { n: 0 };
    const local2 = deps();
    // reuse the task's own threads via the same local? deliver needs bot. Use a fresh deps.
    const review2 = await deliver(blocked, local2, starts2);
    harvestFactoryTask(blocked.id, {
      sessionId: review2.task.sessionId,
      worktree: blocked.worktree,
      resultSha: ungated,
      evidence: [{ kind: "review", ref: ungated }],
      qaDisposition: "KEEP_DRAFT",
      reviewedSha: ungated,
    });
    const test2 = await deliver(blocked, local2, starts2);
    harvestFactoryTask(blocked.id, {
      sessionId: test2.task.sessionId,
      worktree: blocked.worktree,
      resultSha: ungated,
      evidence: [{ kind: "test", ref: ungated }],
      checkResults: [{ name: "unit", result: "pass", sha: ungated }],
    });
    const rel2 = await deliver(blocked, local2, starts2);
    harvestFactoryTask(blocked.id, {
      sessionId: rel2.task.sessionId,
      worktree: blocked.worktree,
      resultSha: ungated,
      evidence: [{ kind: "release", ref: ungated }],
    });
    expect(() => shipFactoryTask(blocked.id, {})).toThrow(/release gate did not authorize/);
  });

  it("does not launch a second worker when restart recovery runs", async () => {
    const { repo, sha } = initRepo();
    const local = deps();
    const task = createFactoryTask(intake(repo, sha), local).task;
    await launchFactoryTask(task.id, { start: () => {} });
    const built = commit(task.worktree!, "base\nharmless\n");
    harvestFactoryTask(task.id, {
      sessionId: task.sessionId,
      worktree: task.worktree,
      resultSha: built,
      evidence: [{ kind: "commit", ref: built }],
    });
    const starts = { n: 0 };
    await deliver(task, local, starts);
    _resetFactoryDispatch();
    recoverFactoryTasks();
    const after = JSON.parse(readFileSync(join(DATA_DIR, "factory-tasks.json"), "utf8"));
    const row = after.tasks.find((item: { id: string }) => item.id === task.id);
    expect(row.handoffs.filter((item: { deliveredAt?: number }) => item.deliveredAt).length).toBe(1);
    const retry = await deliver(task, local, starts);
    expect(retry.duplicate).toBe(true);
    expect(starts.n).toBe(1);
  });

  it("blocks a tester when the SHA no longer matches the review", async () => {
    const { repo, sha } = initRepo();
    const local = deps();
    const task = createFactoryTask(intake(repo, sha), local).task;
    const launched = await launchFactoryTask(task.id, { start: () => {} });
    const built = commit(task.worktree!, "base\nharmless\n");
    harvestFactoryTask(task.id, {
      sessionId: launched.task.sessionId,
      worktree: task.worktree,
      resultSha: built,
      evidence: [{ kind: "commit", ref: built }],
    });
    const starts = { n: 0 };
    const review = await deliver(task, local, starts);
    harvestFactoryTask(task.id, {
      sessionId: review.task.sessionId,
      worktree: task.worktree,
      resultSha: built,
      evidence: [{ kind: "review", ref: built }],
      qaDisposition: "KEEP_DRAFT",
      reviewedSha: built,
    });
    const tester = await deliver(task, local, starts);
    const moved = commit(task.worktree!, "base\nharmless\nmoved\n");
    const stale = harvestFactoryTask(task.id, {
      sessionId: tester.task.sessionId,
      worktree: task.worktree,
      resultSha: moved,
      evidence: [{ kind: "test", ref: moved }],
      checkResults: [{ name: "unit", result: "pass", sha: moved }],
    });
    expect(stale.status).toBe("blocked");
    expect(stale.blocker).toMatch(/stale SHA/);
    expect(stale.reviewSha).toBeUndefined();
    expect(stale.testSha).toBeUndefined();
    expect(stale.releaseSha).toBeUndefined();
  });


});
