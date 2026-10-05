// Factory tool boundary. Prompt text is not enforcement: callers in the
// Claude spawn path, the permission broker, and the PreToolUse hook all use
// this decision. OMB dispatches only the implementer; QA and independent
// review are performed outside OMB. The read-only branch below stays as a
// fail-closed default so a stored reviewer or QA role can never be treated
// as a writer. It is not a QA isolation boundary.

import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const FACTORY_ENGINE_MODEL = "claude-opus-5-5";

/** Registered specialist bots. Ids are exact; Finch is not a specialist. */
export const FACTORY_SPECIALISTS = {
  "07169dc6-72c2-4c7c-b3b3-62d9122aa46b": { key: "codebase-navigator", name: "Codebase Navigator", role: "reviewer" },
  "063c67ac-f8ca-4c05-b6b8-e3bbf2e102a7": { key: "software-implementer", name: "Software Implementer", role: "implementer" },
  "1872d149-0be3-42c6-9218-3ea7d56609a4": { key: "security-privacy", name: "Security and Privacy Reviewer", role: "reviewer" },
  "7c8f2e77-2ad9-4c40-a623-4825528eefcd": { key: "ui-accessibility", name: "UI and Accessibility Reviewer", role: "reviewer" },
  "a6677c84-0c2d-41fa-bd76-fbb4c12859f7": { key: "game-interaction", name: "Game and Interaction Reviewer", role: "reviewer" },
  "223e5e26-37e4-42e3-9026-5983b66a17aa": { key: "independent-qa", name: "Independent QA", role: "qa" },
  "bb034770-3b5a-44de-9ffe-1d851a093afe": { key: "release-readiness", name: "Release Readiness Reviewer", role: "reviewer" },
} as const;

export type FactorySpecialistId = keyof typeof FACTORY_SPECIALISTS;
export type FactoryRole = (typeof FACTORY_SPECIALISTS)[FactorySpecialistId]["role"];

/** Legacy stored value only. OMB does not record a QA disposition. */
export type QaEvidenceDisposition = "CLEAR" | "KEEP_DRAFT" | "NOT_CLEAR";

const READ_ONLY_TOOLS = new Set(["read", "grep", "glob", "ls", "websearch", "webfetch"]);
const WRITE_TOOLS = new Set(["edit", "write", "notebookedit", "multiedit", "strreplace"]);
const SHELL_TOOLS = new Set(["bash", "powershell", "shell"]);

/** Tools the CLI must not offer a read-only role. OMB does not dispatch one; this keeps a stored one fenced. */
export const REVIEWER_DISALLOWED_TOOLS = [
  "Edit", "Write", "NotebookEdit", "MultiEdit", "Bash", "PowerShell", "Task", "Agent",
] as const;

export function isFactorySpecialistId(value: unknown): value is FactorySpecialistId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(FACTORY_SPECIALISTS, value);
}

export function factoryRole(specialistId: FactorySpecialistId): FactoryRole {
  return FACTORY_SPECIALISTS[specialistId].role;
}

export function isReadOnlyFactoryRole(role: FactoryRole): boolean {
  return role === "reviewer" || role === "qa";
}

function toolBase(tool: string): string {
  return tool.replace(/^mcp__[^_]+__/, "").split("__").pop()!.toLowerCase();
}

function pathFrom(input: Record<string, unknown>): string | null {
  for (const key of ["file_path", "path", "notebook_path", "target_file", "filePath"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/** Drive paths ("C:\x", "C:/x", "C:x") and UNC or device paths ("\\host", "//host"). */
const FOREIGN_ABSOLUTE = /^(?:[A-Za-z]:|[\\/]{2})/;

/** True when `candidate` is the worktree or a path inside it. Missing,
 * relative escapes, and absolute paths outside fail closed. A backslash is a
 * separator on every platform, and drive and UNC paths are refused outright
 * off Windows, where they would otherwise read as odd relative names. */
export function pathInsideWorktree(worktree: string, candidate: string): boolean {
  if (!worktree.trim() || !candidate.trim() || candidate.includes("\0")) return false;
  const windows = process.platform === "win32";
  if (!windows && FOREIGN_ABSOLUTE.test(candidate)) return false;
  const normal = windows ? candidate : candidate.replace(/\\/g, "/");
  const root = resolve(worktree);
  const abs = isAbsolute(normal) ? resolve(normal) : resolve(root, normal);
  const rel = relative(root, abs);
  if (rel === "") return true;
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Why a file-tool path cannot be trusted to stay in the worktree, or null.
 * Every existing component under the root must not be a symlink or junction,
 * and the deepest existing ancestor must resolve inside the real worktree.
 * Anything it cannot examine is refused. This is a check at one moment: a
 * link planted after it is not seen, which is why link-creating shell
 * commands are refused and the seal rechecks the committed tree. */
export function symlinkEscapeReason(worktree: string, candidate: string): string | null {
  let realRoot: string;
  try {
    realRoot = realpathSync.native(resolve(worktree));
  } catch {
    return "worktree cannot be resolved on disk; refusing";
  }
  const normal = process.platform === "win32" ? candidate : candidate.replace(/\\/g, "/");
  const root = resolve(worktree);
  const abs = isAbsolute(normal) ? resolve(normal) : resolve(root, normal);
  const rel = relative(root, abs);
  const parts = rel === "" ? [] : rel.split(sep);
  let current = root;
  let deepest = root;
  for (const part of parts) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) return `path goes through a link: ${current}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      return "path could not be examined; refusing";
    }
    deepest = current;
  }
  try {
    const back = relative(realRoot, realpathSync.native(deepest));
    if (back === "") return null;
    if (back === ".." || back.startsWith(`..${sep}`) || isAbsolute(back)) return `path resolves outside the worktree: ${deepest}`;
  } catch {
    return "path could not be resolved; refusing";
  }
  return null;
}

const DRIVE_PATH = /(?:^|[\s"'=(])([A-Za-z]:[\\/][^\s"'`;|&<>]*)/g;
const UNC_PATH = /(?:^|[\s"'=(])((?:\\\\|\/\/)[^\s"'`;|&<>]+)/;
const ROOTED_PATH = /(?:^|[\s"'=(])(\/[^\s"'`;|&<>]*)/g;
const ROOTED_BACKSLASH_PATH = /(?:^|[\s"'=(])(\\[^\s"'`;|&<>]*)/g;
/** `..` as a whole path segment, with either separator, anywhere in the command. */
const PARENT_SEGMENT = /(?:^|[\s;&|"'=(\\/])\.\.(?=$|[\s;&|"')\\/])/;
const LINK_COMMAND = /(?:^|[\s;&|(])(?:ln|mklink|junction)(?:\.exe)?(?=\s|$)|\bSymbolicLink\b|\bJunction\b|\bHardLink\b/i;

function pathsIn(pattern: RegExp, command: string): string[] {
  return [...command.matchAll(pattern)].map((match) => match[1]!);
}

function bashDenied(role: FactoryRole, worktree: string, command: string, windowsStyle: boolean): string | null {
  if (isReadOnlyFactoryRole(role)) return "read-only factory role cannot run a shell or submit changes";
  if (!command.trim()) return "shell command is missing; refusing";
  if (/[`$]/.test(command) || command.includes("~") || /%[A-Za-z_][A-Za-z0-9_]*%/.test(command)) return "shell command uses expansion; refusing";
  if (PARENT_SEGMENT.test(command)) return "shell command leaves the worktree; refusing";
  if (/\bgit\s+push\b/i.test(command) || /\bgh\s+/i.test(command) || /\bgit\s+merge\b/i.test(command)) {
    return "factory implementer cannot push or merge";
  }
  if (LINK_COMMAND.test(command)) return "shell command creates links, which could point outside the worktree; refusing";
  const unc = command.match(UNC_PATH);
  if (unc) return `shell path is outside the worktree: ${unc[1]}`;
  const candidates = [
    ...pathsIn(ROOTED_PATH, command),
    ...pathsIn(DRIVE_PATH, command),
    ...(windowsStyle ? pathsIn(ROOTED_BACKSLASH_PATH, command) : []),
  ];
  for (const path of candidates) {
    if (!pathInsideWorktree(worktree, path)) return `shell path is outside the worktree: ${path}`;
  }
  if (/[<>]/.test(command)) {
    return "shell redirection is refused; write through the editor inside the worktree";
  }
  return null;
}

export type FactoryToolDecision = { allow: true } | { allow: false; reason: string } | { defer: true };

/** Broker-facing decision. `defer` means the path is not on this ask, so the
 * PreToolUse hook (which sees the real input) is the enforcer. An explicit
 * deny is always a deny. */
export function evaluateFactoryTool(args: {
  role: FactoryRole;
  worktree: string;
  tool: string;
  input?: Record<string, unknown>;
}): FactoryToolDecision {
  const tool = toolBase(args.tool);
  const input = args.input ?? {};
  if (!args.worktree.trim()) return { allow: false, reason: "factory task has no worktree binding" };
  if (isReadOnlyFactoryRole(args.role)) {
    if (READ_ONLY_TOOLS.has(tool)) return { allow: true };
    return { allow: false, reason: `read-only factory role cannot use ${args.tool}` };
  }
  if (WRITE_TOOLS.has(tool)) {
    const path = pathFrom(input);
    if (!path) return { defer: true };
    if (!pathInsideWorktree(args.worktree, path)) {
      return { allow: false, reason: `implementer write is outside its worktree: ${path}` };
    }
    const linked = symlinkEscapeReason(args.worktree, path);
    if (linked) return { allow: false, reason: `implementer write is refused: ${linked}` };
    return { allow: true };
  }
  if (SHELL_TOOLS.has(tool)) {
    const command = typeof input.command === "string" ? input.command : "";
    if (!command) return { defer: true };
    const why = bashDenied(args.role, args.worktree, command, tool === "powershell" || process.platform === "win32");
    return why ? { allow: false, reason: why } : { allow: true };
  }
  if (READ_ONLY_TOOLS.has(tool)) return { allow: true };
  // Unknown tools can edit or submit. Fail closed for every factory role.
  return { allow: false, reason: `factory role cannot use unreviewed tool ${args.tool}` };
}

/** Hook-facing decision. Missing input on a write or shell is a deny, not a defer. */
export function enforceFactoryTool(args: {
  role: FactoryRole;
  worktree: string;
  tool: string;
  input?: Record<string, unknown>;
}): { allow: true } | { allow: false; reason: string } {
  const decision = evaluateFactoryTool(args);
  if ("defer" in decision) {
    return { allow: false, reason: "factory tool input was missing; refusing" };
  }
  return decision;
}

export function factoryHookCommand(helperPath: string): string {
  return process.platform === "win32"
    ? `"%OMB_HOOK_NODE%" "${helperPath}"`
    : [process.execPath, helperPath].map((path) => `'${path.replace(/'/g, `'\\''`)}'`).join(" ");
}

export function factoryPreToolSettings(helperPath: string): Record<string, unknown> {
  const entry = [{ matcher: "", hooks: [{ type: "command", command: factoryHookCommand(helperPath), timeout: 10 }] }];
  return { PreToolUse: entry };
}
