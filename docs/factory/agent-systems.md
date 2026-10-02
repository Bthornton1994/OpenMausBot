# Factory agent-systems adapter (t1765u P1)

Vendored Cap1 (sanitize) + Cap2 (fail-closed budgets) from the portfolio
`standards/agent-systems/` pin (`server/agent-systems/VERSION`).

## Integration point

**File:** `server/room-handoffs.ts` — `RoomHandoffs.enqueue`

Before a new room handoff node is accepted:

1. Build Cap2 policy from `ROOM_HANDOFF_LIMITS.executions` → `{ maxSteps }` via
   `policyFromRoomLimits` (missing executions → `null` → **deny**).
2. Evaluate usage `{ steps: root.executions }` with `evaluateBudget`.
3. Run `sanitizeHandoff({ text })`; persist **sanitized** text only.
4. On any refuse → throw (fail closed). No forward of unsanitized / over-budget work.

## Non-goals

- No Temporal, Slack, Langfuse, new MCP server, or paid/model calls.
- Does not change protect SoT, tool allowlists, or enable production traffic.
- Cap3 traces / Cap4 trajectory fuzz stay in portfolio standards (not vendored here).
- Factory-lanes / bridge modules (draft PR tips) are **not** modified by this adapter.

## Tests

```bash
pnpm exec vitest run server/agent-systems/handoff-gate.test.ts server/room-handoffs.test.ts
```
