// PreToolUse fence for a factory turn. Fail closed: a missing binding, a
// bad payload, or a denied tool exits 2 so Claude Code does not run it.
// This process does not read credentials and does not speak to the network.
import { readFileSync } from "node:fs";

import { enforceFactoryTool, type FactoryRole } from "../factory-boundary.ts";

const ROLES = new Set<FactoryRole>(["implementer", "reviewer", "qa"]);

function deny(reason: string): never {
  process.stderr.write(`OpenMausBot factory: ${reason}\n`);
  process.exit(2);
}

function allow(): never {
  process.exit(0);
}

async function readStdin(): Promise<string> {
  return await new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
      if (data.length > 1_000_000) deny("tool payload is too large");
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => deny("could not read the tool payload"));
  });
}

const raw = await readStdin();
let payload: Record<string, unknown>;
try {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) deny("tool payload is not an object");
  payload = parsed as Record<string, unknown>;
} catch {
  deny("tool payload is not JSON");
}

const event = typeof payload.hook_event_name === "string" ? payload.hook_event_name : "";
if (event && event !== "PreToolUse") allow();

const bindingPath = process.env.OMB_FACTORY_BINDING ?? "";
if (!bindingPath) deny("factory binding is missing");
let binding: Record<string, unknown>;
try {
  const parsed = JSON.parse(readFileSync(bindingPath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) deny("factory binding is unreadable");
  binding = parsed as Record<string, unknown>;
} catch {
  deny("factory binding is unreadable");
}

const role = binding.role;
const worktree = binding.worktree;
if (typeof role !== "string" || !ROLES.has(role as FactoryRole) || typeof worktree !== "string") {
  deny("factory binding is incomplete");
}
const tool = typeof payload.tool_name === "string" ? payload.tool_name
  : typeof payload.tool === "string" ? payload.tool : "";
if (!tool) deny("tool name is missing");
const input = payload.tool_input && typeof payload.tool_input === "object" && !Array.isArray(payload.tool_input)
  ? payload.tool_input as Record<string, unknown>
  : {};
const decision = enforceFactoryTool({ role: role as FactoryRole, worktree, tool, input });
if (!decision.allow) deny(decision.reason);
allow();
