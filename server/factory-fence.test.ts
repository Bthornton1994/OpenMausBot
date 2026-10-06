// Disposable regressions for the factory fence: the implementer boundary
// (Windows and POSIX path forms, links), the base-pinned bounded required-test
// runner, and the worktree recheck before a candidate is sealed. Every script
// here is written by the test into a temp directory; nothing runs a script a
// task writer controls.
import { execSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { enforceFactoryTool, symlinkEscapeReason } from "./factory-boundary.ts";
import {
  NO_SANDBOX_REASON,
  _setRequiredTestsSandboxForTests,
  checkEnvironment,
  detectRequiredTestsSandbox,
  runBounded,
  runRequiredTestsPinned,
  type RequiredTestsSandbox,
} from "./factory-checks.ts";
import {
  IMPLEMENTER_ID,
  completeFactoryTurn,
  createFactoryTask,
  getFactoryTask,
  harvestFactoryTask,
  launchFactoryTask,
  _resetFactoryDispatch,
  type FactoryBot,
  type FactoryCompletionDeps,
} from "./factory-dispatch.ts";

const B = "\\";
const HAS_SH = spawnSync("sh", ["-c", "exit 0"]).status === 0;
const POSIX = process.platform !== "win32";

function tempWorktree(): string {
  return mkdtempSync(join(tmpdir(), "omb-fence-wt-"));
}

function shell(worktree: string, command: string, tool = "Bash") {
  return enforceFactoryTool({ role: "implementer", worktree, tool, input: { command } });
}

function write(worktree: string, file_path: string) {
  return enforceFactoryTool({ role: "implementer", worktree, tool: "Write", input: { file_path } });
}

describe("boundary: Windows and POSIX path forms", () => {
  it("refuses drive, UNC, rooted and backslash-traversal shell paths on every platform", () => {
    const wt = tempWorktree();
    const refused = [
      ["PowerShell", `Set-Content C:${B}outside${B}f.txt hi`],
      ["PowerShell", `Set-Content C:/outside/f.txt hi`],
      ["PowerShell", `Set-Content ${B}${B}srv${B}share${B}f hi`],
      ["PowerShell", `Set-Content ..${B}f.txt hi`],
      ["PowerShell", `Set-Content ${B}Windows${B}f.txt hi`],
      ["Bash", `cp a //srv/share/f`],
      ["Bash", `cp a /outside/f.txt`],
      ["Bash", `cd .. && ls`],
      ["Bash", `cat a/../../b`],
      ["Bash", `cp a ..${B}b`],
      ["Bash", `echo %USERPROFILE%`],
    ] as const;
    for (const [tool, command] of refused) {
      expect(shell(wt, command, tool).allow, `${tool}: ${command}`).toBe(false);
    }
  });

  it("still allows ordinary in-worktree commands", () => {
    const wt = tempWorktree();
    for (const command of ["git status", "ls src", "npm test", "git diff main..topic", "git log main...topic"]) {
      expect(shell(wt, command).allow, command).toBe(true);
    }
  });

  it("refuses link-creating commands, so a link cannot be planted through the shell", () => {
    const wt = tempWorktree();
    for (const command of ["ln -s / link", "ln -s x y", "cmd /c mklink l t", "New-Item -ItemType SymbolicLink -Path l -Target t", "New-Item -ItemType Junction -Path l -Target t"]) {
      expect(shell(wt, command, command.startsWith("New-Item") ? "PowerShell" : "Bash").allow, command).toBe(false);
    }
  });

  it("refuses drive, UNC and backslash-traversal file-tool paths on every platform", () => {
    const wt = tempWorktree();
    for (const path of [`C:${B}outside${B}f.txt`, "C:/outside/f.txt", `${B}${B}srv${B}share${B}f`, "//srv/share/f", `..${B}f.txt`, "../f.txt", `sub${B}..${B}..${B}f.txt`]) {
      expect(write(wt, path).allow, path).toBe(false);
    }
    expect(write(wt, "inside.txt").allow).toBe(true);
    expect(write(wt, join(wt, "sub", "inside.txt")).allow).toBe(true);
  });
});

describe("boundary: links", () => {
  function plant(wt: string, name: string, target: string): boolean {
    try {
      symlinkSync(target, join(wt, name), process.platform === "win32" ? "junction" : "dir");
      return true;
    } catch {
      return false;
    }
  }

  it("refuses a write that goes through a link that leaves the worktree", () => {
    const wt = tempWorktree();
    const outside = mkdtempSync(join(tmpdir(), "omb-fence-out-"));
    if (!plant(wt, "escape", outside)) return;
    const decision = write(wt, join(wt, "escape", "x.txt"));
    expect(decision.allow).toBe(false);
    expect(symlinkEscapeReason(wt, join("escape", "x.txt"))).toMatch(/link/);
  });

  it("refuses any link component, even one that points back inside the worktree", () => {
    const wt = tempWorktree();
    mkdirSync(join(wt, "real"));
    if (!plant(wt, "alias", join(wt, "real"))) return;
    expect(write(wt, join(wt, "alias", "x.txt")).allow).toBe(false);
    expect(write(wt, join(wt, "real", "x.txt")).allow).toBe(true);
  });

  it("fails closed when the worktree does not exist on disk", () => {
    expect(symlinkEscapeReason(join(tmpdir(), "omb-fence-missing-" + Date.now()), "a.txt")).toMatch(/cannot be resolved/);
  });
});

describe("bounded runner", () => {
  it("kills a command that outlives its timeout", () => {
    const started = Date.now();
    const run = runBounded(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { cwd: tmpdir(), env: checkEnvironment(tmpdir()), timeoutMs: 500 });
    expect(run.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it.skipIf(!POSIX || !HAS_SH)("kills the whole process group, not just the direct child", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-fence-grp-"));
    const pidFile = join(dir, "pid");
    const run = runBounded("sh", ["-c", `sleep 60 & echo $! > "${pidFile}"; wait`], { cwd: dir, env: checkEnvironment(dir), timeoutMs: 700 });
    expect(run.timedOut).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(pid).toBeGreaterThan(1);
    let alive = true;
    for (let i = 0; i < 40 && alive; i++) {
      try { process.kill(pid, 0); await new Promise((resolve) => setTimeout(resolve, 100)); } catch { alive = false; }
    }
    expect(alive).toBe(false);
  });

  async function grandchildSurvivesTimeout(detached: boolean): Promise<boolean> {
    const dir = mkdtempSync(join(tmpdir(), "omb-fence-win-"));
    const pidFile = join(dir, "pid");
    const grandchild = "setTimeout(() => {}, 60000)";
    const parent = `const c = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore', detached: ${detached} });` +
      `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setTimeout(() => {}, 60000);`;
    const run = runBounded(process.execPath, ["-e", parent], { cwd: dir, env: checkEnvironment(dir), timeoutMs: 1500 });
    expect(run.timedOut).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(pid).toBeGreaterThan(1);
    let alive = true;
    for (let i = 0; i < 40 && alive; i++) {
      try { process.kill(pid, 0); await new Promise((resolve) => setTimeout(resolve, 100)); } catch { alive = false; }
    }
    if (alive) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
    return alive;
  }

  it.skipIf(POSIX)("kills an ordinary grandchild on Windows, not just the direct child", async () => {
    expect(await grandchildSurvivesTimeout(false)).toBe(false);
  });

  // KNOWN GAP, not a guarantee: measured on Windows, a descendant that detaches
  // from the check survives the timeout, with or without the taskkill fallback.
  // This asserts the observed survival, so a setup or pid-read error fails the
  // test (the helper asserts the timeout and pid first), and so does fixing the
  // gap; whoever fixes it should flip this to expect cleanup. Nothing spawns
  // without an OS sandbox, so the gap is not reachable today.
  it.skipIf(POSIX)("KNOWN GAP: a detached grandchild survives the timeout on Windows", async () => {
    expect(await grandchildSurvivesTimeout(true)).toBe(true);
  });

  it("hands a check only an allowlisted environment", () => {
    const env = checkEnvironment("/scratch", { PATH: "/bin", OMB_AUTH_TOKEN: "secret", ANTHROPIC_API_KEY: "secret", HOME: "/home/real" });
    expect(env.PATH).toBe("/bin");
    expect(env.OMB_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.HOME).toBe("/scratch");
  });
});

function repoWithScript(script: string | null): { repo: string; base: string } {
  const repo = mkdtempSync(join(tmpdir(), "omb-fence-repo-"));
  execSync("git init -b main", { cwd: repo });
  execSync("git config user.email factory@example.com", { cwd: repo });
  execSync("git config user.name factory", { cwd: repo });
  writeFileSync(join(repo, "README"), "base\n");
  if (script !== null) {
    mkdirSync(join(repo, ".omb"));
    writeFileSync(join(repo, ".omb", "required-tests"), script);
    chmodSync(join(repo, ".omb", "required-tests"), 0o755);
  }
  execSync("git add -A && git commit -m base", { cwd: repo });
  return { repo, base: execSync("git rev-parse HEAD", { cwd: repo }).toString().trim() };
}

function commitFile(repo: string, name: string, body: string): string {
  mkdirSync(join(repo, ...name.split("/").slice(0, -1)), { recursive: true });
  writeFileSync(join(repo, name), body);
  execSync(`git add -A && git commit -m change`, { cwd: repo });
  return execSync("git rev-parse HEAD", { cwd: repo }).toString().trim();
}

// Pass-through stand-in. It confines nothing; it only lets the tests below
// exercise the runner mechanics. It is never a real sandbox and is refused
// outside vitest.
const PASS_THROUGH: RequiredTestsSandbox = { name: "test-pass-through", wrap: (command, args) => ({ command, args }) };

describe("required tests fail closed without an OS sandbox", () => {
  it("has no sandbox by default, because none has been demonstrated", () => {
    expect(detectRequiredTestsSandbox()).toBeNull();
  });

  it("never spawns the base script when no sandbox is available", () => {
    const marker = join(mkdtempSync(join(tmpdir(), "omb-fence-marker-")), "ran").split(B).join("/");
    const { repo, base } = repoWithScript(`#!/bin/sh\ntouch "${marker}"\nexit 0\n`);
    const head = commitFile(repo, "README", "base\nmore\n");
    expect(runRequiredTestsPinned(repo, base, head)).toEqual({ state: "unsandboxed", reason: NO_SANDBOX_REASON });
    expect(existsSync(marker)).toBe(false);
  });

  it("still reports no definition at the base as undefined, with nothing to run", () => {
    const { repo, base } = repoWithScript(null);
    const head = commitFile(repo, "README", "base\nmore\n");
    expect(runRequiredTestsPinned(repo, base, head)).toEqual({ state: "undefined" });
  });

  it("refuses to install a test sandbox outside vitest", () => {
    const saved = process.env.VITEST;
    delete process.env.VITEST;
    try {
      expect(() => _setRequiredTestsSandboxForTests(PASS_THROUGH)).toThrow(/test-only/);
    } finally {
      process.env.VITEST = saved;
    }
    expect(detectRequiredTestsSandbox()).toBeNull();
  });
});

describe.skipIf(!HAS_SH)("base-pinned required tests (runner mechanics under a test stand-in)", () => {
  beforeEach(() => _setRequiredTestsSandboxForTests(PASS_THROUGH));
  afterEach(() => _setRequiredTestsSandboxForTests(null));

  it("runs the base copy and passes it the head SHA", () => {
    const { repo, base } = repoWithScript("#!/bin/sh\n[ \"$1\" = \"$(git rev-parse HEAD)\" ] || exit 1\ngrep -q fixed README || exit 1\nexit 0\n");
    const head = commitFile(repo, "README", "base\nfixed\n");
    expect(runRequiredTestsPinned(repo, base, head)).toEqual({ state: "ran", ok: true });
  });

  it("does not execute a script the writer changed", () => {
    const { repo, base } = repoWithScript("#!/bin/sh\nexit 1\n");
    const head = commitFile(repo, ".omb/required-tests", `#!/bin/sh\ntouch "${join(repo, "ran-marker").split(B).join("/")}"\nexit 0\n`);
    const outcome = runRequiredTestsPinned(repo, base, head);
    expect(outcome.state).toBe("modified");
    expect(existsSync(join(repo, "ran-marker"))).toBe(false);
  });

  it("does not execute a script the writer added when the base has none", () => {
    const { repo, base } = repoWithScript(null);
    const head = commitFile(repo, ".omb/required-tests", "#!/bin/sh\nexit 0\n");
    expect(runRequiredTestsPinned(repo, base, head)).toEqual({ state: "undefined" });
  });

  it("times out a hung check and reports it as a failure", () => {
    const { repo, base } = repoWithScript("#!/bin/sh\nsleep 30\n");
    const head = commitFile(repo, "README", "base\nmore\n");
    const outcome = runRequiredTestsPinned(repo, base, head, { timeoutMs: 1000 });
    expect(outcome).toMatchObject({ state: "ran", ok: false });
    expect((outcome as { reason?: string }).reason).toMatch(/timed out/);
  });

  it("does not hand the check the server's credentials", () => {
    const { repo, base } = repoWithScript("#!/bin/sh\n[ -z \"$OMB_FENCE_PROBE\" ] || exit 1\nexit 0\n");
    const head = commitFile(repo, "README", "base\nmore\n");
    process.env.OMB_FENCE_PROBE = "secret";
    try {
      expect(runRequiredTestsPinned(repo, base, head)).toEqual({ state: "ran", ok: true });
    } finally {
      delete process.env.OMB_FENCE_PROBE;
    }
  });
});

function local() {
  let n = 0;
  const bot = (id: string): FactoryBot => ({ id, model: "claude-opus-5-5", driverKind: "claudeAgent" });
  const createThread = (id: string) => ({ threadId: `fence-${id.slice(0, 8)}-${n++}` });
  const pinCwd = () => {};
  return { bot, createThread, pinCwd };
}

function completion(threadId: string, deps: ReturnType<typeof local>) {
  const host: FactoryCompletionDeps = { ok: true, bot: deps.bot, createThread: deps.createThread, pinCwd: deps.pinCwd, start: () => {} };
  return completeFactoryTurn(threadId, host);
}

async function seatedWriter(script: string) {
  const { repo, base } = repoWithScript(script);
  const deps = local();
  const task = createFactoryTask({
    objective: "Add a harmless line",
    specialistId: IMPLEMENTER_ID,
    model: "claude-opus-5-5",
    permissions: "auto",
    repo,
    baseSha: base,
    acceptance: "README contains fixed",
    dependencies: [],
    requiredEvidence: ["commit"],
    owner: "Bryant Thornton",
    authority: "fence proof",
  }, deps).task;
  const launched = await launchFactoryTask(task.id, { start: () => {} });
  const built = commitFile(task.worktree!, "README", "base\nfixed\n");
  return { deps, task, launched, base, built };
}

describe.skipIf(!HAS_SH)("recheck after required tests", () => {
  beforeEach(() => {
    try { unlinkSync(join(DATA_DIR, "factory-tasks.json")); } catch { /* fresh */ }
    _resetFactoryDispatch();
    _setRequiredTestsSandboxForTests(PASS_THROUGH);
  });
  afterEach(() => _setRequiredTestsSandboxForTests(null));

  const drifts: [string, string, RegExp][] = [
    ["dirties the worktree", "#!/bin/sh\necho stray > stray.txt\nexit 0\n", /not clean/],
    ["moves HEAD", "#!/bin/sh\ngit -c user.email=a@b.c -c user.name=n commit --allow-empty -q -m drift\nexit 0\n", /HEAD changed/],
  ];

  // A legacy row can carry a review of an older SHA. That is the only seal
  // path that runs the required tests, so it is the one that needs a recheck.
  function withLegacyReview(taskId: string, sha: string, sessionId: string | undefined) {
    getFactoryTask(taskId)!.revisions!.push({
      id: "legacy-review", kind: "review", sessionId: sessionId ?? "legacy", specialistId: IMPLEMENTER_ID,
      generation: 1, sha, evidence: [], findings: [], nextAction: "legacy", createdAt: Date.now(),
    } as never);
  }

  for (const [label, script, expected] of drifts) {
    it(`blocks the legacy hadOtherReview seal when the required tests leave a worktree that ${label}`, async () => {
      const { deps, task, launched, base } = await seatedWriter(script);
      withLegacyReview(task.id, base, launched.task.sessionId);
      const done = await completion(launched.task.ombThreadId!, deps);
      expect(done.task?.status).toBe("blocked");
      expect(done.task?.blocker).toMatch(expected);
      expect(done.task?.blocker).toMatch(/after required checks ran; not sealed/);
      expect(done.task?.resultSha).toBeUndefined();
      expect(done.task?.revisions?.some((item) => item.kind === "implementation")).toBe(false);
    });
  }

  it("blocks the legacy hadOtherReview seal without spawning the script when no sandbox exists", async () => {
    const marker = join(mkdtempSync(join(tmpdir(), "omb-fence-marker-")), "ran").split(B).join("/");
    const { deps, task, launched, base } = await seatedWriter(`#!/bin/sh\ntouch "${marker}"\nexit 0\n`);
    _setRequiredTestsSandboxForTests(null);
    withLegacyReview(task.id, base, launched.task.sessionId);
    const done = await completion(launched.task.ombThreadId!, deps);
    expect(done.task?.status).toBe("blocked");
    expect(done.task?.blocker).toBe(NO_SANDBOX_REASON);
    expect(existsSync(marker)).toBe(false);
    expect(done.task?.revisions?.some((item) => item.kind === "implementation")).toBe(false);
  });

  it("blocks stale-SHA adoption without spawning the script when no sandbox exists", async () => {
    const marker = join(mkdtempSync(join(tmpdir(), "omb-fence-marker-")), "ran").split(B).join("/");
    const { deps, task, launched, base } = await seatedWriter(`#!/bin/sh\ntouch "${marker}"\nexit 0\n`);
    _setRequiredTestsSandboxForTests(null);
    harvestFactoryTask(task.id, {
      sessionId: launched.task.sessionId,
      worktree: task.worktree,
      resultSha: base,
      evidence: [{ kind: "commit", ref: base, note: "agent named the base" }],
    });
    const done = await completion(launched.task.ombThreadId!, deps);
    expect(done.task?.status).toBe("blocked");
    expect(done.task?.blocker).toBe(NO_SANDBOX_REASON);
    expect(existsSync(marker)).toBe(false);
    expect(done.task?.revisions?.some((item) => item.kind === "candidate")).toBe(false);
  });

  for (const [label, script, expected] of drifts) {
    it(`does not adopt after a stale-SHA rejection when the required tests leave a worktree that ${label}`, async () => {
      const { deps, task, launched, base } = await seatedWriter(script);
      harvestFactoryTask(task.id, {
        sessionId: launched.task.sessionId,
        worktree: task.worktree,
        resultSha: base,
        evidence: [{ kind: "commit", ref: base, note: "agent named the base" }],
      });
      const done = await completion(launched.task.ombThreadId!, deps);
      expect(done.task?.status).toBe("blocked");
      expect(done.task?.blocker).toMatch(expected);
      expect(done.task?.resultSha).toBeUndefined();
      expect(done.task?.writerLock).toBe("implementer");
      expect(done.task?.revisions?.some((item) => item.kind === "candidate")).toBe(false);
    });
  }

  it("blocks sealing a HEAD whose committed symlink points outside the tree", async () => {
    if (!POSIX) return;
    const { deps, task, launched } = await seatedWriter("#!/bin/sh\nexit 0\n");
    symlinkSync("../../etc", join(task.worktree!, "leak"));
    execSync("git add -A && git commit -m link", { cwd: task.worktree });
    const head = execSync("git rev-parse HEAD", { cwd: task.worktree }).toString().trim();
    harvestFactoryTask(task.id, {
      sessionId: launched.task.sessionId,
      worktree: task.worktree,
      resultSha: head,
      evidence: [{ kind: "commit", ref: head }],
    });
    const done = await completion(launched.task.ombThreadId!, deps);
    expect(done.task?.status).toBe("blocked");
    expect(done.task?.blocker).toMatch(/symlink points outside/);
    expect(done.task?.revisions?.some((item) => item.kind === "candidate")).toBe(false);
  });
});
