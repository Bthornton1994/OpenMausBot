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

## What this does not do

- It does not bypass any owner or product gate. `owner_gate` is a frozen phase;
  nothing in this module moves a lane out of it — only an explicit
  `transition` call by whoever holds that authority.
- It does not create git worktrees, run CI, message bots, merge, or push.
- It does not know about protected sessions; callers must still honour the
  factory's protect list before dispatching.

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
   `server/factory-lanes.test.ts`.
