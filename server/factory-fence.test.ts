// Disposable regressions for the factory fence: the implementer boundary
// (Windows and POSIX path forms, links), the base-pinned bounded required-test
// runner, and the worktree recheck before a candidate is sealed. Every script
// here is written by the test into a temp directory; nothing runs a script a
// task writer controls.
import { execSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import { enforceFactoryTool, symlinkEscapeReason } from "./factory-boundary.ts";
import { checkEnvironment, runBounded, runRequiredTestsPinned } from "./factory-checks.ts";
import { NO_SANDBOX_REASON, NO_WRITER_SANDBOX_REASON, detectFactorySandbox, type FactorySandbox } from "./factory-sandbox.ts";
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

// Pass-through stand-in. It confines nothing; it only lets the tests below
// exercise the runner mechanics. Production code has no way to install one:
// this replaces the detection module for this test file only.
const sandbox = vi.hoisted(() => ({ current: null as FactorySandbox | null }));
vi.mock("./factory-sandbox.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./factory-sandbox.ts")>()),
  detectFactorySandbox: () => sandbox.current,
}));
// Test-only failure injection: while armed, the one `git ls-tree <sha> -- .omb/required-tests`
// definition lookup fails; every other git call passes through. No production hook exists.
const lookup = vi.hoisted(() => ({ fail: false, hits: 0 }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: ((command: string, args?: readonly string[], ...rest: unknown[]) => {
      if (lookup.fail && command === "git" && args?.includes("ls-tree") && !args.includes("-r") && args.at(-1) === ".omb/required-tests") {
        lookup.hits += 1;
        return { status: 128, stdout: "", stderr: "injected lookup failure", pid: 0, output: [], signal: null };
      }
      return (actual.spawnSync as (...a: unknown[]) => unknown)(command, args, ...rest);
    }) as typeof actual.spawnSync,
  };
});
const PASS_THROUGH: FactorySandbox = { name: "test-pass-through", wrap: (command, args) => ({ command, args }) };
const setSandbox = (value: FactorySandbox | null) => { sandbox.current = value; };

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
  // A junction (Windows) or directory symlink needs no privilege on a supported
  // host. If it cannot be made, the test has proved nothing, so it fails.
  function plant(wt: string, name: string, target: string): void {
    try {
      symlinkSync(target, join(wt, name), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      throw new Error(`could not create the test link ${name} -> ${target}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  it("refuses a write that goes through a link that leaves the worktree", () => {
    const wt = tempWorktree();
    const outside = mkdtempSync(join(tmpdir(), "omb-fence-out-"));
    plant(wt, "escape", outside);
    const decision = write(wt, join(wt, "escape", "x.txt"));
    expect(decision.allow).toBe(false);
    expect(symlinkEscapeReason(wt, join("escape", "x.txt"))).toMatch(/link/);
  });

  it("refuses any link component, even one that points back inside the worktree", () => {
    const wt = tempWorktree();
    mkdirSync(join(wt, "real"));
    plant(wt, "alias", join(wt, "real"));
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

  // A descendant that inherits the output pipes and outlives the check must not
  // stall the runner. The parent exits at once; the grandchild holds the pipes
  // for 15s. The runner has to return at its own timeout, not at EOF.
  it.skipIf(POSIX)("returns at the timeout when a descendant keeps the output handles open on Windows", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-fence-pipe-"));
    const grandchild = "setTimeout(() => {}, 15000)";
    const parent = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'inherit' });`;
    const started = Date.now();
    const run = runBounded(process.execPath, ["-e", parent], { cwd: dir, env: checkEnvironment(dir), timeoutMs: 1500 });
    expect(run.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
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

describe("required tests and writers fail closed without an OS sandbox", () => {
  beforeEach(() => {
    try { unlinkSync(join(DATA_DIR, "factory-tasks.json")); } catch { /* fresh */ }
    _resetFactoryDispatch();
    setSandbox(null);
  });

  it("has no sandbox in production code, because none has been demonstrated", async () => {
    const real = await vi.importActual<typeof import("./factory-sandbox.ts")>("./factory-sandbox.ts");
    expect(real.detectFactorySandbox()).toBeNull();
    expect(detectFactorySandbox()).toBeNull();
  });

  it("gives production code no way to install a sandbox, with or without VITEST", async () => {
    const real = await vi.importActual<Record<string, unknown>>("./factory-sandbox.ts");
    const checks = await vi.importActual<Record<string, unknown>>("./factory-checks.ts");
    for (const mod of [real, checks]) {
      for (const name of Object.keys(mod)) expect(name, name).not.toMatch(/^_?set.*sandbox|ForTests$/i);
    }
    const saved = process.env.VITEST;
    try {
      for (const value of [saved, undefined]) {
        if (value === undefined) delete process.env.VITEST; else process.env.VITEST = value;
        expect((real.detectFactorySandbox as () => unknown)()).toBeNull();
      }
    } finally {
      if (saved !== undefined) process.env.VITEST = saved;
    }
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

  it("treats a failed or malformed definition lookup as unreadable, not as no script", () => {
    setSandbox(PASS_THROUGH);
    try {
      const marker = join(mkdtempSync(join(tmpdir(), "omb-fence-marker-")), "ran").split(B).join("/");
      const { repo, base } = repoWithScript(`#!/bin/sh\ntouch "${marker}"\nexit 0\n`);
      const head = commitFile(repo, "README", "base\nmore\n");
      // Failed lookup: the recorded base does not exist, so ls-tree errors.
      expect(runRequiredTestsPinned(repo, "0".repeat(40), head)).toMatchObject({ state: "unreadable" });
      // Failed head lookup after a good base lookup.
      expect(runRequiredTestsPinned(repo, base, "1".repeat(40))).toMatchObject({ state: "unreadable" });
      // Malformed: the definition path is a directory, not a file entry.
      const dirRepo = repoWithScript(null);
      mkdirSync(join(dirRepo.repo, ".omb", "required-tests"), { recursive: true });
      writeFileSync(join(dirRepo.repo, ".omb", "required-tests", "inner"), "x\n");
      execSync("git add -A && git commit -m dir", { cwd: dirRepo.repo });
      const dirBase = execSync("git rev-parse HEAD", { cwd: dirRepo.repo }).toString().trim();
      expect(runRequiredTestsPinned(dirRepo.repo, dirBase, dirBase)).toMatchObject({ state: "unreadable" });
      expect(existsSync(marker)).toBe(false);
    } finally {
      setSandbox(null);
    }
  });

  it("starts no implementer writer when no sandbox is available", async () => {
    const { repo, base } = repoWithScript(null);
    const deps = local();
    // Intake itself refuses without a sandbox, so a stored bound task (as a
    // pre-gate store held one) is built under the stand-in first.
    setSandbox(PASS_THROUGH);
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
    setSandbox(null);
    let started = 0;
    await expect(launchFactoryTask(task.id, { start: () => { started += 1; } })).rejects.toThrow(NO_WRITER_SANDBOX_REASON);
    expect(started).toBe(0);
    const stored = getFactoryTask(task.id)!;
    expect(stored.status).toBe("blocked");
    expect(stored.sessionId).toBeUndefined();
  });
});

describe.skipIf(!HAS_SH)("base-pinned required tests (runner mechanics under a test stand-in)", () => {
  beforeEach(() => setSandbox(PASS_THROUGH));
  afterEach(() => setSandbox(null));

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

/** Commits a symlink entry with git plumbing, so it needs no filesystem
 * symlink privilege, then restores it in the working tree. */
function commitLink(repo: string, name: string, target: string): string {
  const blob = execSync("git hash-object -w --stdin", { cwd: repo, input: target }).toString().trim();
  execSync(`git update-index --add --cacheinfo 120000,${blob},${name}`, { cwd: repo });
  execSync("git commit -m link", { cwd: repo });
  execSync(`git checkout -- ${name}`, { cwd: repo });
  return execSync("git rev-parse HEAD", { cwd: repo }).toString().trim();
}

async function seatedWriter(script: string | null, inheritedLink?: { name: string; target: string }) {
  const repoBase = repoWithScript(script);
  const repo = repoBase.repo;
  const base = inheritedLink ? commitLink(repo, inheritedLink.name, inheritedLink.target) : repoBase.base;
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
    setSandbox(PASS_THROUGH);
  });
  afterEach(() => setSandbox(null));

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
    setSandbox(null);
    withLegacyReview(task.id, base, launched.task.sessionId);
    const done = await completion(launched.task.ombThreadId!, deps);
    expect(done.task?.status).toBe("blocked");
    expect(done.task?.blocker).toBe(NO_SANDBOX_REASON);
    expect(existsSync(marker)).toBe(false);
    expect(done.task?.revisions?.some((item) => item.kind === "implementation")).toBe(false);
  });

  // Ordinary completion has no older review revision. It is the common path, and
  // it must not seal past a base that defines required-tests with no sandbox.
  it("does not spawn the script or seal on ordinary completion when no sandbox exists", async () => {
    const marker = join(mkdtempSync(join(tmpdir(), "omb-fence-marker-")), "ran").split(B).join("/");
    const { deps, task, launched, built } = await seatedWriter(`#!/bin/sh\ntouch "${marker}"\nexit 0\n`);
    setSandbox(null);
    harvestFactoryTask(task.id, {
      sessionId: launched.task.sessionId,
      worktree: task.worktree,
      resultSha: built,
      evidence: [{ kind: "commit", ref: built }],
    });
    const done = await completion(launched.task.ombThreadId!, deps);
    expect(done.task?.status).toBe("blocked");
    expect(done.task?.blocker).toBe(NO_SANDBOX_REASON);
    expect(existsSync(marker)).toBe(false);
    expect(done.task?.resultSha).toBeUndefined();
    expect(done.task?.revisions?.some((item) => item.kind === "candidate" || item.kind === "implementation")).toBe(false);
  });

  // The base stays a valid ancestor and the worktree is clean, so completion
  // passes the ancestry and cleanliness checks and reaches the required-tests
  // check; only the definition lookup fails. No sandbox is installed.
  it("blocks ordinary completion without spawning the script when only the definition lookup fails", async () => {
    const marker = join(mkdtempSync(join(tmpdir(), "omb-fence-marker-")), "ran").split(B).join("/");
    const { deps, task, launched, built } = await seatedWriter(`#!/bin/sh\ntouch "${marker}"\nexit 0\n`);
    setSandbox(null);
    harvestFactoryTask(task.id, {
      sessionId: launched.task.sessionId,
      worktree: task.worktree,
      resultSha: built,
      evidence: [{ kind: "commit", ref: built }],
    });
    lookup.hits = 0;
    lookup.fail = true;
    try {
      const done = await completion(launched.task.ombThreadId!, deps);
      expect(lookup.hits).toBeGreaterThan(0);
      expect(done.task?.status).toBe("blocked");
      expect(done.task?.blocker).toMatch(/could not be looked up/);
      expect(done.task?.blocker).not.toBe(NO_SANDBOX_REASON);
      expect(existsSync(marker)).toBe(false);
      expect(done.task?.resultSha).toBeUndefined();
      expect(done.task?.revisions?.some((item) => item.kind === "candidate" || item.kind === "implementation")).toBe(false);
    } finally {
      lookup.fail = false;
    }
  });

  it("still seals on ordinary completion without a sandbox when the base defines no required-tests", async () => {
    const { deps, task, launched, built } = await seatedWriter(null);
    setSandbox(null);
    harvestFactoryTask(task.id, {
      sessionId: launched.task.sessionId,
      worktree: task.worktree,
      resultSha: built,
      evidence: [{ kind: "commit", ref: built }],
    });
    const done = await completion(launched.task.ombThreadId!, deps);
    expect(done.task?.blocker).toBeUndefined();
    expect(done.task?.resultSha).toBe(built);
    expect(done.task?.revisions?.some((item) => item.kind === "implementation")).toBe(true);
  });

  it("blocks stale-SHA adoption without spawning the script when no sandbox exists", async () => {
    const marker = join(mkdtempSync(join(tmpdir(), "omb-fence-marker-")), "ran").split(B).join("/");
    const { deps, task, launched, base } = await seatedWriter(`#!/bin/sh\ntouch "${marker}"\nexit 0\n`);
    setSandbox(null);
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

  // File symlinks need privilege on Windows, so this case is an explicit skip there.
  it.skipIf(!POSIX)("blocks sealing a HEAD whose committed symlink points outside the tree", async () => {
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

  // The link is already in the base and the writer never touches it, so a scan
  // of only the changed paths would not see it.
  async function sealWithInheritedLink(target: string) {
    const { deps, task, launched, built } = await seatedWriter("#!/bin/sh\nexit 0\n", { name: "inherited-link", target });
    harvestFactoryTask(task.id, {
      sessionId: launched.task.sessionId,
      worktree: task.worktree,
      resultSha: built,
      evidence: [{ kind: "commit", ref: built }],
    });
    return completion(launched.task.ombThreadId!, deps);
  }

  for (const target of ["../../etc", "/etc/passwd", "C:/outside/f.txt", "sub/../../up"]) {
    it(`blocks sealing a HEAD that inherits an escaping link to ${target} from the base`, async () => {
      const done = await sealWithInheritedLink(target);
      expect(done.task?.status).toBe("blocked");
      expect(done.task?.blocker).toMatch(/symlink points outside the worktree: inherited-link/);
      expect(done.task?.revisions?.some((item) => item.kind === "candidate")).toBe(false);
    });
  }

  it("does not block on an inherited link whose target stays inside the tree", async () => {
    const done = await sealWithInheritedLink("README");
    expect(done.task?.blocker ?? "").not.toMatch(/symlink/);
  });
});
