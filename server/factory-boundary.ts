// Factory tool boundary. Prompt text is not enforcement: callers in the
// Claude spawn path, the permission broker, and the PreToolUse hook all use
// this decision. OMB dispatches only the implementer; QA and independent
// review are performed outside OMB. The read-only branch below stays as a
// fail-closed default so a stored reviewer or QA role can never be treated
// as a writer. It is not a QA isolation boundary.

import { isAbsolute, relative, resolve, sep } from "node:path";

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

/** True when `candidate` is the worktree or a path inside it. Missing,
 * relative escapes, and absolute paths outside fail closed. */
export function pathInsideWorktree(worktree: string, candidate: string): boolean {
  if (!worktree.trim() || !candidate.trim() || candidate.includes("\0")) return false;
  const root = resolve(worktree);
  const abs = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
  const rel = relative(root, abs);
  if (rel === "") return true;
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function bashDenied(role: FactoryRole, worktree: string, command: string): string | null {
  if (isReadOnlyFactoryRole(role)) return "read-only factory role cannot run a shell or submit changes";
  if (!command.trim()) return "shell command is missing; refusing";
  if (/[`$]/.test(command) || command.includes("~")) return "shell command uses expansion; refusing";
  if (/(^|[\s;&|])(\.\.|\.\/\.\.)(\/|$)/.test(command)) return "shell command leaves the worktree; refusing";
  if (/\bgit\s+push\b/i.test(command) || /\bgh\s+/i.test(command) || /\bgit\s+merge\b/i.test(command)) {
    return "factory implementer cannot push or merge";
  }
  const abs = command.match(/(?:^|[\s"'=])(\/[^\s"'`;|&<>]+)/g) ?? [];
  for (const raw of abs) {
    const path = raw.trim().replace(/^[\s"'=]+/, "");
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
    return { allow: true };
  }
  if (SHELL_TOOLS.has(tool)) {
    const command = typeof input.command === "string" ? input.command : "";
    if (!command) return { defer: true };
    const why = bashDenied(args.role, args.worktree, command);
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
