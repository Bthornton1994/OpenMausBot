// Required-check runner for the factory. The check definition is read from the
// recorded base commit, never from the writer's worktree, so a task writer
// cannot change what gets executed. The child gets a scrubbed environment, a
// hard timeout, and (on POSIX) its own process group that is killed when the
// run ends. Those are not a sandbox, so the script is spawned only through an
// OS sandbox; without one it fails closed and is never run.
// See docs/factory-lanes.md.

import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_SANDBOX_REASON, detectFactorySandbox } from "./factory-sandbox.ts";

export const REQUIRED_TESTS_PATH = ".omb/required-tests";
export const REQUIRED_TESTS_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

/** Names a check may see. Nothing that carries an OMB or provider credential. */
const ENV_ALLOWLIST = [
  "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "windir", "COMSPEC",
  "ProgramFiles", "ProgramFiles(x86)", "ProgramData", "LANG", "LC_ALL", "TZ",
];

export function checkEnvironment(scratch: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ENV_ALLOWLIST) {
    if (source[name] !== undefined) env[name] = source[name];
  }
  env.HOME = scratch;
  env.USERPROFILE = scratch;
  env.TMPDIR = scratch;
  env.TEMP = scratch;
  env.TMP = scratch;
  env.CI = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

export type BoundedRun = { status: number | null; stdout: string; timedOut: boolean; error?: string };

/** Runs a command to completion or kills it. On POSIX the child leads its own
 * process group and the whole group is killed afterwards, so a hung or
 * orphaned grandchild does not outlive the check. On Windows the direct child
 * is killed on timeout and a best-effort `taskkill /T` follows; a descendant
 * that already detached from it is not guaranteed to be reached. */
export function runBounded(
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): BoundedRun {
  const posix = process.platform !== "win32";
  const result = spawnSync(command, args, {
    cwd: opts.cwd,
    env: opts.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: opts.timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: MAX_OUTPUT_BYTES,
    windowsHide: true,
    // spawnSync honours `detached` at runtime (new process group) but its typings omit it.
    detached: posix,
  } as SpawnSyncOptionsWithStringEncoding);
  if (result.pid) {
    if (posix) {
      try { process.kill(-result.pid, "SIGKILL"); } catch { /* group already gone */ }
    } else {
      spawnSync("taskkill", ["/PID", String(result.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    }
  }
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  const timedOut = code === "ETIMEDOUT";
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    timedOut,
    ...(result.error ? { error: timedOut ? "timed out" : (code ?? result.error.message) } : {}),
  };
}

function gitText(worktree: string, args: string[]): { ok: boolean; stdout: string } {
  const result = spawnSync("git", ["-C", worktree, ...args], { encoding: "utf8", maxBuffer: 8 * MAX_OUTPUT_BYTES });
  return { ok: result.status === 0, stdout: result.stdout ?? "" };
}

type Definition =
  | { kind: "absent" }
  | { kind: "present"; entry: string }
  | { kind: "unreadable"; reason: string };

/** The definition at a commit as `mode blob`. Only a successful lookup that
 * lists nothing is "absent"; a failed, malformed or unexpected lookup is
 * "unreadable" and is never read as "no script". */
function definitionAt(worktree: string, sha: string): Definition {
  const listed = gitText(worktree, ["ls-tree", sha, "--", REQUIRED_TESTS_PATH]);
  if (!listed.ok) return { kind: "unreadable", reason: `required-tests could not be looked up at ${sha}` };
  const lines = listed.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return { kind: "absent" };
  const match = lines.length === 1 ? lines[0]!.match(/^(\d{6}) blob ([0-9a-f]{40})\t(.*)$/) : null;
  if (!match || match[3] !== REQUIRED_TESTS_PATH) {
    return { kind: "unreadable", reason: `required-tests at ${sha} is not a single file entry` };
  }
  return { kind: "present", entry: `${match[1]} ${match[2]}` };
}

export type RequiredTestsOutcome =
  | { state: "undefined" }
  | { state: "unreadable"; reason: string }
  | { state: "unsandboxed"; reason: string }
  | { state: "modified"; reason: string }
  | { state: "ran"; ok: boolean; reason?: string };

/** Runs the base-pinned required-tests for `headSha` inside an OS sandbox. With
 * no sandbox the script is never spawned and the result is `unsandboxed`. The
 * writer's copy is never executed: if it differs from the base copy the result
 * is `modified`, which callers treat as a failure that needs a human. */
export function runRequiredTestsPinned(
  worktree: string,
  baseSha: string,
  headSha: string,
  opts: { timeoutMs?: number } = {},
): RequiredTestsOutcome {
  const base = definitionAt(worktree, baseSha);
  if (base.kind === "unreadable") return { state: "unreadable", reason: base.reason };
  if (base.kind === "absent") return { state: "undefined" };
  const pinned = base.entry;
  const sandbox = detectFactorySandbox();
  if (!sandbox) return { state: "unsandboxed", reason: NO_SANDBOX_REASON };
  if (!/^100(644|755) /.test(pinned)) {
    return { state: "modified", reason: "required-tests at the recorded base is not a regular file" };
  }
  const head = definitionAt(worktree, headSha);
  if (head.kind === "unreadable") return { state: "unreadable", reason: head.reason };
  if (head.kind === "absent" || head.entry !== pinned) {
    return { state: "modified", reason: "required-tests differs from the recorded base; the base copy is the only one OMB runs" };
  }
  const blob = spawnSync("git", ["-C", worktree, "cat-file", "blob", pinned.split(" ")[1]!], { maxBuffer: MAX_OUTPUT_BYTES });
  if (blob.status !== 0 || !blob.stdout) return { state: "ran", ok: false, reason: "required-tests could not be read from the base" };
  const scratch = mkdtempSync(join(tmpdir(), "omb-required-tests-"));
  try {
    const script = join(scratch, "required-tests");
    writeFileSync(script, blob.stdout);
    chmodSync(script, 0o700);
    const env = checkEnvironment(scratch);
    const timeoutMs = opts.timeoutMs ?? REQUIRED_TESTS_TIMEOUT_MS;
    const wrapped = sandbox.wrap("sh", [script, headSha], { workspace: worktree, scratch });
    const run = runBounded(wrapped.command, wrapped.args, { cwd: worktree, env, timeoutMs });
    if (run.timedOut) return { state: "ran", ok: false, reason: `required-tests timed out after ${Math.round(timeoutMs / 1000)}s and was killed` };
    if (run.error) return { state: "ran", ok: false, reason: `required-tests could not run: ${run.error}` };
    return { state: "ran", ok: run.status === 0 };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
