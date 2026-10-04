// Debian/Linux is the only supported factory execution host. It mounts the
// snapshot read-only over itself, so chmod fails with EROFS even for the
// owner. That mount is not a QA read-only proof: the QA process is the same
// server user, and a host where that user can `sudo -n` remount or umount the
// snapshot does not hold the boundary. Windows factory dispatch is unsupported
// and fails closed. It does not apply an ACL lock or clear write bits. An ACL
// on the host is not a read-only boundary: it does not cover a token that can
// take ownership. A separate VM is required before Windows is supported.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

export type SnapshotEntry = { path: string; dir: boolean; mode: number };

const WINDOWS_FACTORY_UNSUPPORTED = "Windows factory dispatch is unsupported. Debian/Linux is the only supported factory execution host. Dispatch fails closed and does not apply an ACL lock or clear write bits. An ACL on the host is not a read-only boundary: it does not cover a token that can take ownership. A separate VM is required before Windows is supported.";

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

function windowsUnsupported(): never {
  throw new Error(WINDOWS_FACTORY_UNSUPPORTED);
}

/** Make `root` immutable to the reviewer. Throws instead of using a mode-bit lock. */
export function enforceSnapshotBoundary(root: string, _entries: readonly SnapshotEntry[]): void {
  if (process.platform === "linux") {
    lockLinux(root);
    return;
  }
  if (process.platform === "win32") windowsUnsupported();
  throw new Error(`${process.platform} cannot enforce a reviewer-proof read-only snapshot`);
}

/** Undo enforceSnapshotBoundary. Windows dispatch never locked, so it cannot restore an ACL. */
export function releaseSnapshotBoundary(root: string): void {
  if (process.platform === "linux") {
    releaseLinux(root);
    return;
  }
  if (process.platform === "win32") windowsUnsupported();
}
