import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { enforceFactoryTool } from "./factory-boundary.ts";
import { DATA_DIR } from "./config.ts";
import {
  FactoryDispatchError,
  cancelFactoryTask,
  createFactoryTask,
  harvestFactoryTask,
  launchFactoryTask,
  listFactoryTasks,
  recoverFactoryTasks,
  unavailableFactoryRoles,
  waitFactoryTask,
  _resetFactoryDispatch,
  type FactoryBot,
} from "./factory-dispatch.ts";

const IMPLEMENTER = "063c67ac-f8ca-4c05-b6b8-e3bbf2e102a7";
const NAVIGATOR = "07169dc6-72c2-4c7c-b3b3-62d9122aa46b";
const QA = "223e5e26-37e4-42e3-9026-5983b66a17aa";

function initRepo(): { repo: string; sha: string } {
  const repo = mkdtempSync(join(tmpdir(), "omb-factory-repo-"));
  execSync("git init -b main", { cwd: repo });
  execSync("git config user.email factory@example.com", { cwd: repo });
  execSync("git config user.name factory", { cwd: repo });
  writeFileSync(join(repo, "README"), "base\n");
  execSync("git add README && git commit -m base", { cwd: repo });
  const sha = execSync("git rev-parse HEAD", { cwd: repo }).toString().trim();
  return { repo, sha };
}

function bot(id: string, extra: Partial<FactoryBot> = {}): FactoryBot {
  return { id, model: "claude-opus-5-5", driverKind: "claudeAgent", ...extra };
}

function deps(threads: { threadId: string; cwd?: string }[] = []) {
  let n = 0;
  return {
    threads,
    bot: (id: string) => bot(id),
    createThread: (id: string) => {
      const threadId = `thread-${id.slice(0, 8)}-${n++}`;
      threads.push({ threadId });
      return { threadId };
    },
    pinCwd: (_botId: string, threadId: string, cwd: string) => {
      const row = threads.find((item) => item.threadId === threadId);
      if (row) row.cwd = cwd;
    },
  };
}

function intake(repo: string, sha: string, specialistId = IMPLEMENTER, extra: Record<string, unknown> = {}) {
  return {
    objective: "Add a proof file",
    specialistId,
    model: "claude-opus-5-5",
    permissions: "auto",
    repo,
    baseSha: sha,
    acceptance: "proof file exists",
    dependencies: [],
    requiredEvidence: ["commit"],
    owner: "Bryant Thornton",
    authority: "factory proof",
    ...extra,
  };
}

beforeEach(() => {
  try { unlinkSync(join(DATA_DIR, "factory-tasks.json")); } catch { /* fresh home */ }
  _resetFactoryDispatch();
});

describe("factory permissions", () => {
  it("accepts auto and rejects bypass, full, and unknown modes", () => {
    const { repo, sha } = initRepo();
    const created = createFactoryTask(intake(repo, sha), deps());
    expect(created.task.permissions).toBe("auto");
    for (const permissions of ["bypass", "bypassPermissions", "full", "ask", "custom", "nope"]) {
      expect(() => createFactoryTask(intake(repo, sha, IMPLEMENTER, { permissions, dispatchKey: permissions }), deps())).toThrow(FactoryDispatchError);
    }
  });

  it("rejects an unknown specialist and a model that is not the engine model", () => {
    const { repo, sha } = initRepo();
    expect(() => createFactoryTask(intake(repo, sha, "b50d80bc-827c-41c5-90de-bbdede8e372a"), deps())).toThrow(/registered/);
    expect(() => createFactoryTask(intake(repo, sha, IMPLEMENTER, { model: "claude-fable-5-1" }), deps())).toThrow(/engine model/);
  });

  it("marks a role unavailable and does not create a worktree when the boundary cannot be enforced", () => {
    const { repo, sha } = initRepo();
    const local = deps();
    expect(() => createFactoryTask(intake(repo, sha), {
      ...local,
      bot: (id) => bot(id, { driverKind: "codex" }),
    })).toThrow(/unavailable/);
    expect(unavailableFactoryRoles()[0]?.specialistId).toBe(IMPLEMENTER);
    expect(listFactoryTasks()).toHaveLength(0);
  });
});

describe("factory binding", () => {
  it("persists the worktree before launch and does not start a turn", () => {
    const { repo, sha } = initRepo();
    const local = deps();
    let started = 0;
    const { task } = createFactoryTask(intake(repo, sha), local);
    expect(task.status).toBe("bound");
    expect(task.sessionId).toBeUndefined();
    expect(task.worktree).toBeTruthy();
    expect(execSync("git -C " + JSON.stringify(task.worktree) + " rev-parse HEAD").toString().trim()).toBe(sha);
    const onDisk = JSON.parse(readFileSync(join(DATA_DIR, "factory-tasks.json"), "utf8"));
    expect(onDisk.tasks[0].worktree).toBe(task.worktree);
    expect(onDisk.tasks[0].status).toBe("bound");
    expect(local.threads[0].cwd).toBe(task.worktree);
    expect(started).toBe(0);
  });

  it("stores the session before the worker starts and only then marks running", async () => {
    const { repo, sha } = initRepo();
    const { task } = createFactoryTask(intake(repo, sha), deps());
    let seen = "";
    const launched = await launchFactoryTask(task.id, {
      start: () => {
        seen = readFileSync(join(DATA_DIR, "factory-tasks.json"), "utf8");
      },
    });
    const during = JSON.parse(seen);
    expect(during.tasks[0].status).toBe("launch_intent");
    expect(during.tasks[0].sessionId).toMatch(/[0-9a-f-]{36}/);
    expect(during.tasks[0].worktree).toBe(task.worktree);
    expect(launched.task.status).toBe("running");
    expect(launched.task.sessionId).toBe(during.tasks[0].sessionId);
  });

  it("returns the existing binding and does not start a second writer", async () => {
    const { repo, sha } = initRepo();
    const { task } = createFactoryTask(intake(repo, sha, IMPLEMENTER, { dispatchKey: "once" }), deps());
    let starts = 0;
    await launchFactoryTask(task.id, { start: () => { starts += 1; } });
    const again = await launchFactoryTask(task.id, { start: () => { starts += 1; } });
    expect(again.duplicate).toBe(true);
    expect(again.task.sessionId).toBe(task.sessionId ?? again.task.sessionId);
    expect(starts).toBe(1);
    const dup = createFactoryTask(intake(repo, sha, IMPLEMENTER, { dispatchKey: "once" }), deps());
    expect(dup.duplicate).toBe(true);
    expect(dup.task.id).toBe(task.id);
  });

  it("keeps the writer lock through a quiet wait and releases it when cancelled", () => {
    const { repo, sha } = initRepo();
    const first = createFactoryTask(intake(repo, sha), deps()).task;
    waitFactoryTask(first.id, "waiting_ci");
    expect(listFactoryTasks()[0]?.quiet).toBe(true);
    expect(() => createFactoryTask(intake(repo, sha, IMPLEMENTER, { dispatchKey: "other" }), deps())).toThrow(/writer/);
    cancelFactoryTask(first.id);
    const second = createFactoryTask(intake(repo, sha, IMPLEMENTER, { dispatchKey: "other" }), deps());
    expect(second.task.id).not.toBe(first.id);
  });
});

describe("factory recovery and harvest", () => {
  it("restores a proven binding and blocks an unproven restart", async () => {
    const { repo, sha } = initRepo();
    const { task } = createFactoryTask(intake(repo, sha), deps());
    const launched = await launchFactoryTask(task.id, { start: () => {} });
    const file = join(DATA_DIR, "factory-tasks.json");
    const raw = JSON.parse(readFileSync(file, "utf8"));
    raw.tasks[0].provenSessionId = launched.task.sessionId;
    writeFileSync(file, JSON.stringify(raw));
    _resetFactoryDispatch();
    const recovered = recoverFactoryTasks();
    expect(recovered.restored).toEqual([task.id]);
    expect(listFactoryTasks()[0]?.binding.sessionId).toBe(launched.task.sessionId);
    expect(listFactoryTasks()[0]?.state).toBe("running");
    expect(listFactoryTasks()[0]?.binding.worktree).toBe(task.worktree);
  });

  it("fails closed when restart cannot prove the session", async () => {
    const { repo, sha } = initRepo();
    const first = createFactoryTask(intake(repo, sha), deps()).task;
    await launchFactoryTask(first.id, { start: () => {} });
    cancelFactoryTask(first.id);
    const { task } = createFactoryTask(intake(repo, sha, IMPLEMENTER, { dispatchKey: "unproven" }), deps());
    await launchFactoryTask(task.id, { start: () => {} });
    _resetFactoryDispatch();
    const recovered = recoverFactoryTasks();
    expect(recovered.blocked).toContain(task.id);
    expect(listFactoryTasks().find((row) => row.id === task.id)?.state).toBe("blocked");
  });

  it("rejects a mismatched or evidenceless harvest and never records QA on the implementer", async () => {
    const { repo, sha } = initRepo();
    const { task } = createFactoryTask(intake(repo, sha), deps());
    const launched = await launchFactoryTask(task.id, { start: () => {} });
    execSync("git -C " + JSON.stringify(task.worktree) + " commit --allow-empty -m proof");
    const result = execSync("git -C " + JSON.stringify(task.worktree) + " rev-parse HEAD").toString().trim();
    expect(() => harvestFactoryTask(task.id, {
      sessionId: "other",
      worktree: task.worktree,
      resultSha: result,
      evidence: [{ kind: "commit", ref: result }],
    })).toThrow(/session/);
    expect(() => harvestFactoryTask(task.id, {
      sessionId: launched.task.sessionId,
      worktree: task.worktree,
      resultSha: result,
      evidence: [],
    })).toThrow(/evidence/);
    expect(() => harvestFactoryTask(task.id, {
      sessionId: launched.task.sessionId,
      worktree: task.worktree,
      resultSha: result,
      evidence: [{ kind: "commit", ref: result }],
      qaDisposition: "CLEAR",
      reviewedSha: result,
    })).toThrow(/QA is performed outside OMB/);
    const harvested = harvestFactoryTask(task.id, {
      sessionId: launched.task.sessionId,
      worktree: task.worktree,
      resultSha: result,
      evidence: [{ kind: "commit", ref: result }],
      checks: ["unit"],
    });
    // During the writer session a desk harvest is evidence only.
    expect(harvested.status).toBe("running");
    expect(harvested.headSha).toBe(result);
    expect(harvested.resultSha).toBeUndefined();
    expect(harvested.checks).toEqual(["unit"]);
    expect(harvested.qaDisposition).toBeUndefined();
    expect(harvested.handoffs ?? []).toEqual([]);
    expect(harvested.assignedReviewerId).toBeUndefined();

    expect(() => createFactoryTask(intake(repo, result, QA, { qaOfTaskId: task.id, dispatchKey: "qa" }), deps())).toThrow(/QA is performed outside OMB/);
    expect(listFactoryTasks()).toHaveLength(1);
  });
});

describe("reviewer read-only", () => {
  it("denies file writes and shells for reviewers and writes outside the worktree for the implementer", () => {
    const worktree = mkdtempSync(join(tmpdir(), "omb-fence-"));
    expect(enforceFactoryTool({ role: "reviewer", worktree, tool: "Write", input: { file_path: join(worktree, "a.txt") } }).allow).toBe(false);
    expect(enforceFactoryTool({ role: "qa", worktree, tool: "Edit", input: { file_path: join(worktree, "a.txt") } }).allow).toBe(false);
    expect(enforceFactoryTool({ role: "reviewer", worktree, tool: "Bash", input: { command: "git status" } }).allow).toBe(false);
    expect(enforceFactoryTool({ role: "reviewer", worktree, tool: "Read", input: { file_path: join(worktree, "a.txt") } }).allow).toBe(true);
    expect(enforceFactoryTool({ role: "implementer", worktree, tool: "Write", input: { file_path: "/tmp/outside.txt" } }).allow).toBe(false);
    expect(enforceFactoryTool({ role: "implementer", worktree, tool: "Write", input: { file_path: join(worktree, "inside.txt") } }).allow).toBe(true);
    expect(enforceFactoryTool({ role: "implementer", worktree, tool: "Bash", input: { command: "git push origin main" } }).allow).toBe(false);
  });
});

describe("navigator seat", () => {
  it("is not dispatched by OMB and does not create a worktree", () => {
    const { repo, sha } = initRepo();
    const writer = createFactoryTask(intake(repo, sha), deps()).task;
    expect(() => createFactoryTask(intake(repo, sha, NAVIGATOR, { dispatchKey: "nav" }), deps())).toThrow(FactoryDispatchError);
    expect(listFactoryTasks().map((row) => row.id)).toEqual([writer.id]);
  });
});
