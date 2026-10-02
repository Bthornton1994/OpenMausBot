# Factory agent-systems adapter (t1765u P1)

Vendored Cap1 (sanitize) + Cap2 (fail-closed budgets) from the portfolio
`standards/agent-systems/` pin (`server/agent-systems/VERSION`).

## Integration point

**File:** `server/room-handoffs.ts` — `RoomHandoffs.enqueue`

Before a new room handoff node is accepted:

1. Build Cap2 policy from `ROOM_HANDOFF_LIMITS.executions` → `{ maxSteps }` via
   `policyFromRoomLimits` (missing executions → `null` → **deny**).
2. Evaluate usage `{ steps: root.executions + 1 }` with `evaluateBudget`. The
   `+ 1` is the execution the new work needs, matching `tick()`'s
   `root.executions + executionCost > limit`.
3. Run `sanitizeHandoff({ text })` on the child handoff brief and persist the
   sanitized brief only.
4. On any refuse → throw (fail closed). No node is stored and nothing is saved.

## What Cap1 covers

Cap1 sanitizes the **child handoff brief** (`text`) only, and redacts only
these patterns (each match becomes `«redacted N chars»`):

- `Bearer` tokens: case-sensitive `Bearer` followed by 16 or more token
  characters, so prose like "the bearer of this note" is left alone
- `sk-ant-…` (Anthropic), `sk-proj-…` (OpenAI project) and other `sk-` keys
- `github_pat_…` and `gh[opsu]_…` (GitHub)
- `xox[abp]-…` (Slack)
- `AKIA` + 16 uppercase letters or digits (AWS access key ID)
- `xai-…` (xAI)
- PEM private key blocks

Anything else passes through, including `password=…` or `api_key: …` written
in the brief.

**Not sanitized:** the root's `sourceText` (the latest user message in the
sender's conversation, stored up to 12,000 characters) and teammate results
(`result`).

## What Cap2 covers

At enqueue, Cap2 guards against an exhausted or misconfigured execution
budget: it refuses new work when the root has no execution left
(`root.executions + 1 > executions`), or when `executions` is missing or
invalid. `tick()` remains the authority for the execution budget: it checks
every dispatch and resume, and fails work that would go over the limit with
"Room execution budget exhausted".

## Non-goals

- No Temporal, Slack, Langfuse, new MCP server, or paid/model calls.
- Does not change protect SoT, tool allowlists, or enable production traffic.
- Cap3 traces / Cap4 trajectory fuzz stay in portfolio standards (not vendored here).
- Factory-lanes / bridge modules (draft PR tips) are **not** modified by this adapter.

## Tests

```bash
pnpm exec vitest run server/agent-systems/handoff-gate.test.ts server/room-handoffs.test.ts
```
