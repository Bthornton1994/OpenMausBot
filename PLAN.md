# Ambition Review read-only gate

## Outcome

Before strategic, ambiguous, repeated, or multi-step work in a Chief of Staff
thread, require the user to choose Altitude, Depth, or Range. Keep the thread on
a read-only provider surface until that choice is explicit, including when the
bot normally has Full access.

## Steps and proof

- [x] Inspect CoS dispatch, task persistence, internal tools, and provider paths.
- [x] Add deterministic eligibility and selection transitions; persist the hold
  privately on the task and block mutating internal capabilities.
- [x] Enforce read-only provider capabilities and fail closed for unsupported
  engines.
- [x] Run focused unit tests, typecheck, lint, and the isolated control-omb
  gate fixture; record exact outcomes.
- [x] Obtain an independent read-only review of the final working tree.

## Current state

Implementation and provider tests are present on
`codex/ambition-review-depth-2026-10-15`. Final verification: `pnpm typecheck`
passed; the ambition gate and store tests passed (39 passed); the dedicated
gate E2E passed; Oxlint and `git diff --check` passed. An independent reviewer
read the final implementation and regression tests and found no remaining
issues in the reviewed cases. The separate room-management fixture is blocked
here by `listen EPERM` on its temporary Unix permission socket; no pass is
claimed for it. The full `pnpm test` run also hit the environment's Unix socket
restriction: `server/index.test.ts` reported 42 failures and
`server/drivers/claude.test.ts` reported 116 failures with `listen EPERM`; the
run was interrupted before the rest of the suite completed. Repository-wide
`pnpm lint` passes. Do not merge or deploy as part of this task.
