// OS-level confinement for factory processes that run code the factory does not
// control: the implementer's shell and the base-pinned required-tests script.
//
// The implementer shell guard in factory-boundary.ts only pattern-matches
// command text. It cannot confine a program (`node -e`, `npm test`, a git hook)
// that builds a path at run time, so it is not a security boundary. Only an OS
// sandbox is. No sandbox has been demonstrated on any supported host, so
// detection returns null and everything that needs one fails closed.
//
// There is deliberately no setter, environment variable, or other way to install
// a sandbox from production code. A real one must be added here together with a
// test that proves the confined process cannot read or write host resources
// outside its workspace. Tests that need a stand-in replace this module with
// vi.mock; nothing here is reachable from the runtime to do the same.
// See docs/factory-lanes.md.

/** An OS-level confinement: the wrapped process must not be able to read or
 * write host resources outside its assigned workspace. `wrap` rewrites the
 * command so it runs inside that confinement. */
export interface FactorySandbox {
  name: string;
  wrap(command: string, args: string[], dirs: { workspace: string; scratch: string }): { command: string; args: string[] };
}

export function detectFactorySandbox(): FactorySandbox | null {
  return null;
}

export const NO_SANDBOX_REASON =
  "blocked: required-tests need an OS sandbox and none is available on this host; the script was not run";

export const NO_WRITER_SANDBOX_REASON =
  "blocked: implementation tasks need an OS sandbox for the writer's shell and none is available on this host; no writer was started";
