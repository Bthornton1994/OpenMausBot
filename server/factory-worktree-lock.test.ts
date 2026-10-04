// Read-only review worktrees. Symlinks are resolved with lstat and readlink
// only: an outside target is not opened, stated, or chmod'd, and a cycle
// fails closed before any permission change. Tracked executable bits stay.
import { execFileSync, execSync } from "node:child_process";
import { accessSync, chmodSync, constants, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { enforceFactoryTool } from "./factory-boundary.ts";
import {
  FactoryDispatchError,
  REVIEWER_ID,
  createFactoryTask,
  _resetFactoryDispatch,
  type FactoryBot,
} from "./factory-dispatch.ts";

function initRepo(): { repo: string; sha: string } {
  const repo = mkdtempSync(join(tmpdir(), "omb-lock-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "factory@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "factory"], { cwd: repo });
  execFileSync("git", ["config", "core.symlinks", "true"], { cwd: repo });
  writeFileSync(join(repo, "README"), "base\n");
  execFileSync("git", ["add", "README"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "base"], { cwd: repo });
  return { repo, sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim() };
}

function headOf(repo: string): string {
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "change"], { cwd: repo });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
}

function local() {
  let n = 0;
  const threads: { threadId: string; cwd?: string }[] = [];
  const scope = Math.random().toString(16).slice(2);
  const bot = (id: string): FactoryBot => ({ id, model: "claude-opus-5-5", driverKind: "claudeAgent" });
  const createThread = (id: string) => {
    const threadId = `lock-${scope}-${id.slice(0, 8)}-${n++}`;
    threads.push({ threadId });
    return { threadId };
  };
  const pinCwd = (_id: string, threadId: string, cwd: string) => {
    const row = threads.find((item) => item.threadId === threadId);
    if (row) row.cwd = cwd;
  };
  return { threads, bot, createThread, pinCwd };
}

function review(repo: string, baseSha: string, headSha: string) {
  return createFactoryTask({
    objective: "Review only",
    specialistId: REVIEWER_ID,
    model: "claude-opus-5-5",
    permissions: "auto",
    repo,
    baseSha,
    headSha,
    acceptance: "read the diff",
    dependencies: [],
    requiredEvidence: ["review"],
    owner: "Bryant Thornton",
    authority: "qa only",
  }, local()).task;
}

function worktreeDirs(): string[] {
  const root = join(DATA_DIR, "factory-worktrees");
  try {
    return readdirSync(root).map((name) => join(root, name));
  } catch {
    return [];
  }
}

function stamp(path: string): { mode: number; mtimeNs: bigint } {
  const info = lstatSync(path, { bigint: true });
  return { mode: Number(info.mode), mtimeNs: info.mtimeNs };
}

function expectLockRejected(run: () => void, pattern: RegExp): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(FactoryDispatchError);
  expect((thrown as Error).message).toMatch(pattern);
}

function assertUntouchedTree(dir: string): void {
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) continue;
      expect(info.mode & 0o200, path).not.toBe(0);
      if (info.isDirectory() && name !== ".git") walk(path);
    }
  };
  expect(lstatSync(dir).mode & 0o200).not.toBe(0);
  walk(dir);
}

function unlock(dir: string | undefined): void {
  if (!dir) return;
  try { execSync(`chmod -R u+w ${JSON.stringify(dir)}`); } catch { /* cleanup */ }
}

beforeEach(() => {
  try { execFileSync("rm", ["-f", join(DATA_DIR, "factory-tasks.json")], { stdio: "ignore" }); } catch { /* fresh */ }
  _resetFactoryDispatch();
});

describe("review worktree read-only lock", () => {
  it("rejects an external file symlink without reading or modifying the sentinel", () => {
    const { repo, sha } = initRepo();
    const outside = mkdtempSync(join(tmpdir(), "omb-sentinel-file-"));
    const sentinel = join(outside, "sentinel");
    writeFileSync(sentinel, "secret-sentinel\n");
    const before = stamp(sentinel);
    const outsideMode = lstatSync(outside).mode & 0o777;
    symlinkSync(sentinel, join(repo, "zzz-escape"));
    const head = headOf(repo);
    const existing = new Set(worktreeDirs());
    chmodSync(outside, 0o000);
    const outsideBeforeReview = stamp(outside);
    try {
      expectLockRejected(() => review(repo, sha, head), /symlink escapes the worktree/);
      const outsideAfterReview = stamp(outside);
      expect(outsideAfterReview.mode).toBe(outsideBeforeReview.mode);
      expect(outsideAfterReview.mtimeNs).toBe(outsideBeforeReview.mtimeNs);
    } finally {
      chmodSync(outside, outsideMode);
    }
    const after = stamp(sentinel);
    expect(after.mode).toBe(before.mode);
    expect(after.mtimeNs).toBe(before.mtimeNs);
    expect(readFileSync(sentinel, "utf8")).toBe("secret-sentinel\n");
    const created = worktreeDirs().filter((dir) => !existing.has(dir));
    expect(created.length).toBe(1);
    assertUntouchedTree(created[0]!);
  });

  it("rejects an external directory symlink without entering it", () => {
    const { repo, sha } = initRepo();
    const outside = mkdtempSync(join(tmpdir(), "omb-sentinel-dir-"));
    const sentinel = join(outside, "sentinel");
    writeFileSync(sentinel, "dir-secret\n");
    const before = stamp(sentinel);
    const outsideMode = lstatSync(outside).mode & 0o777;
    symlinkSync(outside, join(repo, "door"));
    symlinkSync("door/sentinel", join(repo, "through"));
    const head = headOf(repo);
    const existing = new Set(worktreeDirs());
    chmodSync(outside, 0o000);
    const outsideBeforeReview = stamp(outside);
    try {
      expectLockRejected(() => review(repo, sha, head), /symlink escapes the worktree/);
      const outsideAfterReview = stamp(outside);
      expect(outsideAfterReview.mode).toBe(outsideBeforeReview.mode);
      expect(outsideAfterReview.mtimeNs).toBe(outsideBeforeReview.mtimeNs);
    } finally {
      chmodSync(outside, outsideMode);
    }
    const after = stamp(sentinel);
    expect(after.mode).toBe(before.mode);
    expect(after.mtimeNs).toBe(before.mtimeNs);
    expect(readFileSync(sentinel, "utf8")).toBe("dir-secret\n");
    const created = worktreeDirs().filter((dir) => !existing.has(dir));
    expect(created.length).toBe(1);
    assertUntouchedTree(created[0]!);
    expect(lstatSync(join(created[0]!, "door")).isSymbolicLink()).toBe(true);
  });

  it("rejects a symlink cycle without locking anything", () => {
    const { repo, sha } = initRepo();
    symlinkSync("b", join(repo, "a"));
    symlinkSync("a", join(repo, "b"));
    const head = headOf(repo);
    const existing = new Set(worktreeDirs());
    expectLockRejected(() => review(repo, sha, head), /symlink cycle/);
    const created = worktreeDirs().filter((dir) => !existing.has(dir));
    expect(created.length).toBe(1);
    assertUntouchedTree(created[0]!);
  });

  it("locks in-worktree file and directory symlinks, keeps 100755, and denies reviewer writes", () => {
    const { repo, sha } = initRepo();
    mkdirSync(join(repo, "nested"));
    writeFileSync(join(repo, "nested", "file"), "nested\n");
    writeFileSync(join(repo, "realfile"), "inside\n");
    writeFileSync(join(repo, "gradlew"), "#!/bin/sh\necho ok\n");
    chmodSync(join(repo, "gradlew"), 0o755);
    symlinkSync("realfile", join(repo, "alias"));
    symlinkSync("alias", join(repo, "alias2"));
    symlinkSync("nested", join(repo, "dirlink"));
    symlinkSync("..", join(repo, "nested", "up"));
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["update-index", "--chmod=+x", "gradlew"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "links"], { cwd: repo });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    expect(execFileSync("git", ["ls-files", "-s", "gradlew"], { cwd: repo, encoding: "utf8" })).toMatch(/^100755 /);

    const task = review(repo, sha, head);
    const worktree = task.worktree!;
    try {
      expect(task.readOnlyWorktree).toBe(true);
      expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" }).trim()).toBe(head);
      expect(execFileSync("git", ["status", "--porcelain"], { cwd: worktree, encoding: "utf8" })).toBe("");
      expect(execFileSync("git", ["diff", "--summary"], { cwd: worktree, encoding: "utf8" })).toBe("");
      expect(execFileSync("git", ["diff"], { cwd: worktree, encoding: "utf8" })).toBe("");
      expect(execFileSync("git", ["ls-files", "-s", "gradlew"], { cwd: worktree, encoding: "utf8" })).toMatch(/^100755 /);
      expect(execFileSync("git", ["ls-files", "-s", "README"], { cwd: worktree, encoding: "utf8" })).toMatch(/^100644 /);
      const gradlewMode = lstatSync(join(worktree, "gradlew")).mode;
      if (process.platform !== "win32") {
        expect(gradlewMode & 0o111).not.toBe(0);
      }
      expect(gradlewMode & 0o222).toBe(0);
      expect(lstatSync(join(worktree, "alias")).isSymbolicLink()).toBe(true);
      expect(lstatSync(join(worktree, "dirlink")).isSymbolicLink()).toBe(true);
      expect(lstatSync(join(worktree, "nested", "up")).isSymbolicLink()).toBe(true);
      expect(readFileSync(join(worktree, "README"), "utf8")).toBe("base\n");
      expect(readFileSync(join(worktree, "gradlew"), "utf8")).toBe("#!/bin/sh\necho ok\n");
      expect(readFileSync(join(worktree, "realfile"), "utf8")).toBe("inside\n");
      expect(readFileSync(join(worktree, "nested", "file"), "utf8")).toBe("nested\n");
      expect(() => accessSync(join(worktree, "README"), constants.W_OK)).toThrow();
      expect(() => writeFileSync(join(worktree, "README"), "changed\n")).toThrow();
      expect(() => writeFileSync(join(worktree, "brand-new"), "x\n")).toThrow();
      expect(() => writeFileSync(join(worktree, "gradlew"), "nope\n")).toThrow();
      expect(() => writeFileSync(join(worktree, "nested", "file"), "nope\n")).toThrow();
      expect(() => writeFileSync(join(worktree, "nested", "new-file"), "x\n")).toThrow();
      expect(readFileSync(join(worktree, "README"), "utf8")).toBe("base\n");
      expect(enforceFactoryTool({
        role: task.role,
        worktree,
        tool: "Edit",
        input: { file_path: join(worktree, "README") },
      }).allow).toBe(false);
      expect(enforceFactoryTool({
        role: task.role,
        worktree,
        tool: "Write",
        input: { file_path: join(worktree, "brand-new") },
      }).allow).toBe(false);
      expect(execFileSync("git", ["status", "--porcelain"], { cwd: worktree, encoding: "utf8" })).toBe("");
      expect(execFileSync("git", ["diff", "--summary"], { cwd: worktree, encoding: "utf8" })).toBe("");
    } finally {
      unlock(worktree);
    }
  });
});
