// Not the factory dispatch boundary. Dispatch does not call this, and an ACL
// on the host is not a read-only boundary: it does not cover a token that can
// take ownership. Windows factory dispatch fails closed as unsupported until a
// separate VM proves a read-only boundary for the actual QA identity. The
// readonly attribute is also not a lock: a directory owner can create, delete,
// rename, and clear it. These helpers remain only so that history is not
// relabeled as a passed lock.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

export type AclEntry = { path: string; dir: boolean };

type HelperReply = { id?: number; ok?: boolean; error?: string };

let worker: Worker | null = null;
let seq = 0;

function helperScript(): string {
  const beside = fileURLToPath(new URL("./factory-worktree-acl.ps1", import.meta.url));
  if (existsSync(beside)) return beside;
  const fromCwd = join(process.cwd(), "server", "factory-worktree-acl.ps1");
  if (existsSync(fromCwd)) return fromCwd;
  throw new Error("missing factory worktree acl helper");
}

const workerSource = `
const { parentPort, workerData } = require("node:worker_threads");
const { spawn } = require("node:child_process");
const readline = require("node:readline");

let child = null;
let rl = null;

function fail(sab, message) {
  const flag = new Int32Array(sab);
  const bytes = Buffer.from(JSON.stringify({ ok: false, error: message }));
  writeBytes(sab, bytes);
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
}

function writeBytes(sab, bytes) {
  const flag = new Int32Array(sab);
  const raw = new Uint8Array(sab);
  const capped = bytes.subarray(0, sab.byteLength - 8);
  raw.set(capped, 8);
  Atomics.store(flag, 1, capped.length);
}

function ensure() {
  if (child && child.exitCode === null && !child.killed) return;
  child = spawn("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    workerData.scriptPath,
  ], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  rl = readline.createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-2000);
    child.stderrText = stderr;
  });
}

function roundTrip(msg) {
  ensure();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      rl.off("line", onLine);
      child.off("exit", onExit);
      reject(new Error("worktree acl helper timed out"));
    }, 300000);
    const onExit = (code) => {
      clearTimeout(timer);
      rl.off("line", onLine);
      reject(new Error("worktree acl helper exited " + code + " " + (child.stderrText || "")));
    };
    const onLine = (line) => {
      let parsed;
      try { parsed = JSON.parse(line); } catch { return; }
      if (parsed.id !== msg.id) return;
      clearTimeout(timer);
      rl.off("line", onLine);
      child.off("exit", onExit);
      resolve(parsed);
    };
    rl.on("line", onLine);
    child.once("exit", onExit);
    child.stdin.write(JSON.stringify(msg) + "\\n");
  });
}

parentPort.on("message", async (packet) => {
  try {
    const parsed = await roundTrip(packet.msg);
    const flag = new Int32Array(packet.sab);
    writeBytes(packet.sab, Buffer.from(JSON.stringify(parsed)));
    Atomics.store(flag, 0, 1);
    Atomics.notify(flag, 0);
  } catch (error) {
    fail(packet.sab, error && error.message ? error.message : String(error));
  }
});
`;

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(workerSource, { eval: true, workerData: { scriptPath: helperScript() } });
  worker.unref();
  return worker;
}

function callHelper(op: string, root: string, entries?: readonly AclEntry[]): void {
  const id = ++seq;
  const sab = new SharedArrayBuffer(1_048_576);
  const flag = new Int32Array(sab);
  Atomics.store(flag, 0, 0);
  Atomics.store(flag, 1, 0);
  ensureWorker().postMessage({ sab, msg: { id, op, root, ...(entries ? { entries } : {}) } });
  const waited = Atomics.wait(flag, 0, 0, 300_000);
  if (Atomics.load(flag, 0) !== 1) {
    throw new Error(`worktree acl helper ${op} did not finish (${String(waited)})`);
  }
  const len = Atomics.load(flag, 1);
  const body = Buffer.from(new Uint8Array(sab, 8, len)).toString("utf8");
  let parsed: HelperReply;
  try {
    parsed = JSON.parse(body) as HelperReply;
  } catch {
    throw new Error(`worktree acl helper ${op} returned ${body.slice(0, 200)}`);
  }
  if (!parsed.ok) throw new Error(parsed.error || `worktree acl helper ${op} failed`);
}

export function holdWindowsAcl(root: string, entries: readonly AclEntry[]): void {
  callHelper("hold", root, entries);
}

export function applyWindowsAcl(root: string): void {
  callHelper("lock", root);
}

export function restoreWindowsAcl(root: string): void {
  if (!worker) return;
  callHelper("restore", root);
}
