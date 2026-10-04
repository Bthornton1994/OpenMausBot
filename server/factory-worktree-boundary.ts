// Review snapshots are not protected by clearing mode bits on a tree the
// reviewer owns. The owner of a mode-bit lock can chmod it back. Linux mounts
// the snapshot read-only over itself, so chmod fails with EROFS even for the
// owner, and an unprivileged reviewer cannot remount or unmount it. Windows
// denies the reviewer write, delete, and DACL changes, and replaces Owner
// Rights so the reviewer cannot grant those back. Neither path falls open to
// a mode-bit lock. A platform that cannot do this fails closed.
import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { applyWindowsAcl, holdWindowsAcl, restoreWindowsAcl } from "./factory-worktree-acl.ts";

export type SnapshotEntry = { path: string; dir: boolean; mode: number };

function commandFailure(result: { status: number | null; stdout?: string | null; stderr?: string | null; error?: Error }): string {
  return (result.stderr || result.stdout || result.error?.message || `exit ${result.status}`).trim();
}

function runPrivileged(command: string, args: string[]): void {
  const direct = spawnSync(command, args, { encoding: "utf8" });
  if (direct.status === 0) return;
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  if (process.platform === "linux" && uid !== 0) {
    const elevated = spawnSync("sudo", ["-n", command, ...args], { encoding: "utf8" });
    if (elevated.status === 0) return;
    throw new Error(commandFailure(elevated) || commandFailure(direct));
  }
  throw new Error(commandFailure(direct));
}

function decodeMountField(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_match, oct: string) => String.fromCharCode(Number.parseInt(oct, 8)));
}

function linuxMount(target: string): { mounted: boolean; readOnly: boolean } {
  let text = "";
  try {
    text = readFileSync("/proc/self/mountinfo", "utf8");
  } catch {
    return { mounted: false, readOnly: false };
  }
  for (const line of text.split("\n")) {
    if (!line) continue;
    const split = line.indexOf(" - ");
    const fields = (split === -1 ? line : line.slice(0, split)).split(" ");
    if (decodeMountField(fields[4] ?? "") !== target) continue;
    const options = fields[5] ?? "";
    return { mounted: true, readOnly: options.split(",").includes("ro") };
  }
  return { mounted: false, readOnly: false };
}

function lockLinux(root: string): void {
  const existing = linuxMount(root);
  if (!existing.mounted) {
    try {
      runPrivileged("mount", ["--bind", root, root]);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`could not mount the review snapshot read-only: ${detail}`);
    }
  }
  try {
    runPrivileged("mount", ["-o", "remount,bind,ro", root]);
  } catch (error) {
    try { runPrivileged("umount", [root]); } catch { /* the caller still fails closed */ }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`could not remount the review snapshot read-only: ${detail}`);
  }
  if (!linuxMount(root).readOnly) {
    try { runPrivileged("umount", [root]); } catch { /* the caller still fails closed */ }
    throw new Error("review snapshot mount is not read-only");
  }
}

function releaseLinux(root: string): void {
  if (!linuxMount(root).mounted) return;
  runPrivileged("umount", [root]);
  if (linuxMount(root).mounted) throw new Error("review snapshot stayed mounted after umount");
}

function grantUserWrite(root: string): void {
  const writable = (path: string): void => {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) return;
    chmodSync(path, (info.mode & 0o777) | 0o200);
  };
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory() && name !== ".git") visit(path);
      writable(path);
    }
  };
  writable(root);
  visit(root);
}

function clearWriteBits(entries: readonly SnapshotEntry[]): void {
  for (const entry of entries) chmodSync(entry.path, entry.mode & ~0o222);
}

/** Make `root` immutable to the reviewer. Throws instead of using a mode-bit lock. */
export function enforceSnapshotBoundary(root: string, entries: readonly SnapshotEntry[]): void {
  if (process.platform === "linux") {
    lockLinux(root);
    return;
  }
  if (process.platform === "win32") {
    holdWindowsAcl(root, entries.map(({ path, dir }) => ({ path, dir })));
    try {
      clearWriteBits(entries);
      applyWindowsAcl(root);
    } catch (error) {
      try { restoreWindowsAcl(root); } catch { /* the original error is the one that matters */ }
      try { grantUserWrite(root); } catch { /* the original error is the one that matters */ }
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`could not deny the reviewer write access: ${detail}`);
    }
    return;
  }
  throw new Error(`${process.platform} cannot enforce a reviewer-proof read-only snapshot`);
}

/** Undo enforceSnapshotBoundary. Windows can do this only through handles kept from the lock. */
export function releaseSnapshotBoundary(root: string): void {
  if (process.platform === "linux") {
    releaseLinux(root);
    return;
  }
  if (process.platform === "win32") {
    restoreWindowsAcl(root);
    grantUserWrite(root);
  }
}
