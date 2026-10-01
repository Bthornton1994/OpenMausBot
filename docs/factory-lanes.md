# Factory lanes

`server/factory-lanes.ts` is a durable record of factory work items ("lanes")
plus the one scheduling rule a manager loop needs: **while a lane waits on CI
or QA, start another lane only if it cannot touch the waiting lane's branch,
worktree, or files.**

It is a pure server module. No HTTP route, MCP tool, or UI calls it yet, and
it changes no model routing, approvals, or engine behavior.

## Storage

- File: `DATA_DIR/factory-lanes.json` (`~/.openmausbot/factory-lanes.json`, or
  `OMB_DATA_DIR`). Shape: `{ "version": 1, "lanes": FactoryLane[] }`.
- Every change is an atomic replace (`writeFileAtomic`, mode `0600` where the
  platform honours it). The change is applied to a copy and only becomes
  current after the write succeeds, so a failed write never leaves a claim held
  in memory but missing on disk.
- Missing file → empty. Unparseable file → empty, and the bad file is first
  copied to `factory-lanes.json.corrupt-<epoch ms>` so the next save cannot
  destroy it. Individual invalid lanes are dropped on load.
- Evidence is capped at 200 entries per lane (oldest dropped); text fields at
  4,000 characters.

## Schema (`FactoryLane`)

| Field | Notes |
| --- | --- |
| `id`, `title` | `id` defaults to a UUID |
| `ownerBotId` | the single writer; not reassigned by upsert |
| `reviewerBotId?` | independent QA; must differ from `ownerBotId` |
| `role?` | `"qa"` marks review work the implementer claim APIs refuse; absent = implementer; set at creation only |
| `repo`, `branch`, `worktreePath`, `pathClaims?` | what the lane writes |
| `ownershipKey` | derived: `repo#branch#normalized worktreePath` (lower-cased) |
| `fullSha?` | full 40-hex tip SHA; short SHAs are rejected |
| `agentSession?` | Claude/agent session id or URL |
| `phase` | `ready` `running` `ci_wait` `qa_wait` `owner_gate` `done` `failed` `cancelled` |
| `evidence[]` | `{ at, kind, ref, note? }` — commit, ci, qa, pr, claim, phase, … |
| `blocker?`, `nextAction?`, `prUrl?`, `changedFiles?`, `outcome?` | `outcome` is free text (e.g. `KEEP_DRAFT`, `CLEAR`, `merged`) |
| `qaDisposition?` | `PASS` `FAIL` `BLOCKED` `NOT RUN` `UNKNOWN` |
| `claimedAt?` | set while the lane holds an explicit claim |
| `createdAt`, `updatedAt` | epoch ms |

Phase changes are logged automatically as `phase` evidence (`ready->running`).

## Claim rules

A lane **holds ownership** when it is not terminal and either has an explicit
claim (`claimedAt`) or is in a frozen phase: `running`, `ci_wait`, `qa_wait`,
`owner_gate`. Releasing a claim never unfreezes a lane in a frozen phase — a
tip under review keeps blocking until it moves on.

Two ownerships **overlap** (fail-closed) when any of these holds:

- same repo and same branch;
- worktree paths are equal or nested (backslashes, trailing slashes and letter
  case are normalized away — paths that differ only by case count as the same);
- same repo and any `pathClaims` entries are equal or nested.

Entry points:

- `claimWorktree({ laneId, ownerBotId, repo, branch, worktreePath, pathClaims? })`
  — exclusive; only the lane's own `ownerBotId` may claim; any overlap with
  another holder throws `FactoryLaneError` with `code: "conflict"`. Re-claiming
  the same lane is idempotent.
- `transition(id, phase, patch?)` — entering a frozen phase without a claim
  runs the same overlap check and takes the claim. Entering `done`/`failed`/
  `cancelled` releases it. Terminal lanes never transition again (`"terminal"`).
- `releaseOwnership(laneId)` — drops the explicit claim.
- `upsertLane(input)` — creates (initial phase `ready`, `ci_wait`, `qa_wait` or
  `owner_gate`; never `running` or terminal) or updates descriptive fields.
  Moving a lane that holds ownership to another repo/branch/worktree is refused;
  release first. Omitted `pathClaims` means unchanged.
- `appendEvidence(id, evidence)` — also allowed on terminal lanes, so a late CI
  result or QA DIGEST still lands in the audit trail.

## Manager loop: `claimNextEligible`

```ts
claimNextEligible({ waitingPhases?: ["ci_wait", "qa_wait"], preferOwnerBotId?, forceParallel? })
```

1. If no lane is in a waiting phase and `forceParallel` is not set → `null`.
2. Candidates: `ready` lanes without a `blocker`, the preferred owner's first,
   then oldest first.
3. The first candidate that overlaps no ownership holder moves to `running`,
   takes a claim, and gets a `claim` evidence entry naming the lanes it was
   dispatched alongside. It is returned.
4. No safe candidate → `null`. It never starts a second writer on overlapping
   ownership.

`waitLane(id, { timeoutMs, pollMs, reload })` polls until the lane is
`done`/`failed`/`cancelled` or the timeout passes and returns a
`FactoryLaneReport` (`finished`, phase, SHA, PR, QA disposition, outcome,
changed files, last evidence). `laneReport(lane)` builds the same report
without waiting. Pass `reload: true` when another process writes the file.

## QA independence

- `reviewerBotId === ownerBotId` is rejected everywhere it can be set
  (`upsertLane`, transition patches) with `code: "qa_independence"`; a stored
  self-reviewer is dropped on load.
- `recordQaDisposition(id, { reviewerBotId, disposition, ref, note? })` only
  accepts the lane's assigned reviewer, never its owner, and logs `qa`
  evidence.

## Protect gate (`server/factory-protect-gate.ts`)

Every writer claim — `claimWorktree`, `claimNextEligible`, and
`transition(id, "running")` — also passes a protect gate. On DENY it throws
`FactoryLaneError` with `code: "ineligible"` (ownership overlap inside this
store stays `"conflict"`), and the denial is persisted as `protect` evidence on
the lane even though the claim itself is not written.

### Configuration

The CoS protect directory holds `PROTECTED_SESSIONS.json` and
`FROZEN_TIPS.json`. It is resolved per call, first match wins:

1. a `protectDir` option on the call (`claimWorktree({ …, protectDir })`,
   `claimNextEligible({ protectDir })`, `transition(id, phase, patch, { protectDir })`);
2. env `COS_FACTORY_PROTECT_DIR`;
3. env `COS_FACTORY_ROOT` + `/protect`.

**None set → ownership-only mode.** The SoT is not consulted; only the QA rules
below apply. This keeps the lane store usable without a CoS box, and it means
an unconfigured process does **not** know about protected sessions. Anything
that dispatches real factory work must set `COS_FACTORY_PROTECT_DIR`.

The files are re-read on every claim (the box edits them live); a UTF-8 BOM is
tolerated. Accepted shapes — a bare array or an object wrapping one:

```jsonc
// PROTECTED_SESSIONS.json — { "sessions": [...] } (or "protected"), or [...]
{ "sessionId": "session_…", "repo?": "owner/name", "branch?": "…", "worktreePath?": "…", "reason?": "…" }
// a bare string entry is a session id
// FROZEN_TIPS.json — { "tips": [...] } (or "frozen" / "frozenTips"), or [...]
{ "repo": "owner/name", "branch": "…", "tipSha": "<40 hex>", "worktreePath?": "…", "reason?": "…" }
```

(`id`/`session`/`writerTarget`, `sha`/`fullSha` and `worktree`/`cwd` are read
as aliases.) Fixtures: `server/fixtures/t1734u-protect/`.

### Fail closed

With a protect directory configured, the gate DENIES (`rule: "config"`) when:
the directory or either file is missing or unreadable; a file is not JSON; a
file has no recognizable list; or **any** entry is invalid (session without an
id, tip without repo+branch, tip SHA not full 40-hex). A broken protect list is
never read as "nothing is protected". `claimNextEligible` throws `ineligible`
before choosing any lane in that case.

### Rules (mirrors CoS `eligibility.mjs` `decide()`)

Evaluated in order against the ownership being claimed; first DENY wins:

| Rule | DENY when |
| --- | --- |
| `qa_role` | the lane has `role: "qa"` — review work is never claimed through implementer claim APIs (also via `transition → running`) |
| `qa_phase` | `claimWorktree` on a lane in `qa_wait` — its tip belongs to QA until it moves on |
| `frozen_tip` | same repo+branch as a frozen tip, nested worktree with the tip's `worktreePath`, or the lane's `fullSha` equals the tip SHA |
| `protected_session` | the lane's `agentSession` (writer target) is a protected session id, or same repo+branch / nested worktree as a protected session |
| `allow` | none of the above — e.g. disjoint scratch while other lanes sit in `ci_wait`/`qa_wait` |

`qa_role` and `qa_phase` need no SoT, so they apply in ownership-only mode too.
A QA reviewer records verdicts with `recordQaDisposition`, which never claims
or moves the lane.

In `claimNextEligible`, gate-denied candidates are skipped (with `protect`
evidence) and the next safe candidate is tried; an ALLOW is noted on the
chosen lane's `claim` evidence. Identical consecutive `protect` entries are
not repeated, so a loop re-asking every tick does not flood the trail. Only a
`ready` lane is ever dispatched, so a claimed/running lane is never started
twice, including after a reload.

### Relationship to CoS harvest

On the CoS box, `harvest-dispatch.mjs` applies the same SoT through
`eligibility.mjs`. This module enforces that SoT for the in-repo lane store
when `COS_FACTORY_PROTECT_DIR` (or `COS_FACTORY_ROOT`) is set. The TypeScript
port was written from the brief's description of `decide()`; the box script
itself was not available when it was written, so recheck that the file shapes
and rule order match before relying on both together.

## What this does not do

- It does not bypass any owner or product gate. `owner_gate` is a frozen phase;
  nothing in this module moves a lane out of it — only an explicit
  `transition` call by whoever holds that authority.
- It does not create git worktrees, run CI, message bots, merge, or push.
- It does not write the protect list. With no protect directory configured it
  does not know about protected sessions (see *Protect gate*).

## Calling it later (not wired yet)

The intended next steps, each a separate, reviewable change:

1. A read-only MCP tool (`list_factory_lanes`, `get_factory_lane`) following
   the bounded-read pattern in `docs/mcp-server.md`.
2. Guarded write tools (`upsert_factory_lane`, `claim_next_factory_lane`) or a
   loopback HTTP route, so a CoS routine can run one manager-loop step per
   wake: harvest CI/QA evidence → `appendEvidence`/`transition` →
   `claimNextEligible` → hand the returned lane's `worktreePath` to the owner
   bot as its task `cwd`.
3. Until then, server-side code can import the module directly; tests do so in
   `server/factory-lanes.test.ts` and `server/factory-lanes.harvest.test.ts`.
