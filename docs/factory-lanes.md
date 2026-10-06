# Factory lanes

`server/factory-lanes.ts` is a durable record of factory work items ("lanes")
plus the one scheduling rule a manager loop needs: **while a lane waits on CI
or QA, start another lane only if it cannot touch the waiting lane's branch,
worktree, or files.**

It is a server module with no MCP tool or UI. Outside tests, its only caller
is the loopback bridge (`scripts/factory-bridge.ts`; see *Storage* and *QA
hold*). It changes no model routing, approvals, or engine behavior.

## Storage

- File: `DATA_DIR/factory-lanes.json` (`~/.openmausbot/factory-lanes.json`, or
  `OMB_DATA_DIR`). Shape: `{ "version": 1, "lanes": FactoryLane[] }`.
- Every change is an atomic replace (`writeFileAtomic`, mode `0600` where the
  platform honours it). The change is applied to a copy and only becomes
  current after the write succeeds, so a failed write never leaves a claim held
  in memory but missing on disk.
- One process at a time may write the file. Each process keeps the lanes in
  memory, and a change neither re-reads nor locks the file first, so two
  processes writing the same `DATA_DIR` lose each other's changes. While the
  bridge (`scripts/factory-bridge.ts`) runs, make every change through it, QA
  verdicts included; other processes read through it, or with
  `waitLane(…, { reload: true })`. The bridge has no route for
  `releaseOwnership`, `appendEvidence`, or updating a lane the way
  `upsertLane` does (title, `agentSession`, a repo/branch/worktree move,
  `pathClaims`; its register route only creates), so those are in-process
  calls: stop the bridge first, and restart it afterwards so it reloads the
  file.
- A same-phase `POST /factory/lanes/:id/transition` does update the fields
  that route accepts: `outcome`, `nextAction`, `blocker`, `prUrl`,
  `changedFiles`, and — where the QA hold allows — `fullSha` and
  `reviewerBotId`.
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
| `qaRecordedBy?` | the reviewer who recorded `qaDisposition`; set by `recordQaDisposition`, cleared with the verdict (see *QA hold*) |
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
  A lane in `qa_wait` leaves only as its recorded QA verdict allows (see
  *QA hold*).
- `releaseOwnership(laneId)` — drops the explicit claim. Refused for a lane in
  `qa_wait` until QA has recorded a verdict.
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
- A blank or whitespace-only `reviewerBotId` names no reviewer. Set through
  `upsertLane` or a transition patch in-process, it leaves the lane with none,
  clearing any it had — except on a held lane, whose reviewer is frozen (see
  *QA hold*). The bridge's `POST /factory/lanes/:id/transition` ignores a
  blank or `null` reviewer, so a bridge client cannot clear one.
- In-process calls, the bridge and loading all read a reviewer id the same
  way. It is trimmed, so a padded id names the same reviewer, and it is
  compared with the trimmed `ownerBotId`. An id that, once trimmed, still
  contains a character that does not print — a zero-width space, a control or
  format character, a space other than U+0020 — is refused with
  `code: "invalid"`; loading drops a stored one, as it drops a self-reviewer.
- `recordQaDisposition(id, { reviewerBotId, disposition, ref, note? })` only
  accepts the lane's assigned reviewer, never its owner or a blank id, and
  logs `qa` evidence that names the reviewer (`FAIL by qa-bot — missing
  test`). A finished lane keeps the verdict it finished on: a verdict on one is
  refused (`code: "terminal"`), so record late QA with `appendEvidence`.

### QA hold (`qa_wait`)

A lane in `qa_wait` is held by independent QA. Its tip is frozen, and it does
not move until its assigned reviewer has recorded a verdict with
`recordQaDisposition` — and then only where that verdict allows. Anything else
is refused with `code: "ineligible"` and writes nothing.

| Leaving `qa_wait` for | Needs the recorded verdict |
| --- | --- |
| `running` or `ready` — the **rework handoff** | `FAIL` |
| `failed` | `FAIL` |
| `done` | `PASS` |
| `cancelled` | any (`PASS`, `FAIL`, `BLOCKED`, `NOT RUN`, `UNKNOWN`) |
| `ci_wait`, `owner_gate` | never — from either, `running` is one ungated transition away |

- No verdict means QA is pending: the lane cannot resume implementation,
  finish, or be released. `PASS`, `BLOCKED`, `NOT RUN` and `UNKNOWN` never
  hand it back for rework.
- The rework handoff logs `rework` evidence — the reviewer who recorded the
  FAIL (never one the same transition assigns), and the `ref` of the FAIL's
  `qa` evidence — just before the `qa_wait->running` (or
  `qa_wait->ready`) phase entry. Rework still passes the protect gate — on the
  transition to `running`, or when the manager loop dispatches the `ready`
  lane — so a FAIL never opens a frozen tip or a protected session.
- Entering `qa_wait` clears any earlier verdict: one recorded in another
  phase, or in an earlier round, does not release a new hold.
- While the lane is in `qa_wait`, neither a transition patch nor `upsertLane`
  may set or change `fullSha`; record the tip when entering `qa_wait`.
- Nor may either change or clear an assigned `reviewerBotId`, so the verdict
  that releases the lane comes from the reviewer who held it. Restating it is
  fine, and a held lane with no reviewer may be given one — without one, no
  verdict, and so no exit, is possible.
- A held lane with no valid reviewer carries no verdict, so none releases it
  — not even in the transition that gives it a reviewer. Loading drops one
  stored on such a lane (by an older tool, or next to a self-reviewer or blank
  id that loading drops), and giving a held lane the reviewer it lacked clears
  any verdict in the same change — so the lane leaves only on a verdict that
  reviewer recorded.
- A valid reviewer is not enough on its own. Loading keeps a held verdict
  only if the lane's latest `qa` evidence since it last entered `qa_wait` is
  that verdict by the lane's reviewer, as `recordQaDisposition` writes it:
  `PASS by qa-bot`, or `PASS by qa-bot — <note>`. Otherwise it drops the
  verdict and QA is pending again. This fails closed on a store an older tool
  wrote: its `qa` notes name no reviewer (`FAIL — missing test`), it let a
  held lane's reviewer change, and it kept a verdict on entering `qa_wait`.
- `recordQaDisposition` also stores who recorded the verdict, as
  `qaRecordedBy`; entering `qa_wait` clears it with the verdict. Where it is
  stored, a held verdict counts only while it names the lane's assigned
  reviewer: loading drops a verdict whose stored `qaRecordedBy` names anyone
  else (or no one), even beside that reviewer's note, and a lane never leaves
  `qa_wait` on one.
- A verdict stored before `qaRecordedBy` existed has only its note. Loading
  keeps it on the note rule above without adding the field. To leave
  `qa_wait` on it, the note must still pass that rule. The field is set the
  next time the reviewer records a verdict.
- So after pointing this code at a `DATA_DIR` an older tool wrote, a held
  lane whose verdict was dropped stays in `qa_wait`. No OMB route records a
  new verdict, so nothing in OMB releases it. If a `qa` entry that is not the
  reviewer's verdict is added to a held lane with `appendEvidence`, the same
  happens at the next load — and at once for a verdict from before
  `qaRecordedBy`, which only its note attributes.
- `releaseOwnership` is refused until a verdict is recorded (the phase keeps
  blocking other writers either way).
- The implementer claim APIs keep refusing a `qa_wait` lane even after `FAIL`
  (rule `qa_phase`); the handoff goes through `transition`.
- The loopback bridge (`scripts/factory-bridge.ts`) records no QA verdict.
  QA is performed outside OMB, so the old `POST /factory/lanes/:id/qa` route is
  gone and answers `404 unauthorized_op`; no other bridge route accepts a
  `qaDisposition`. A verdict already stored on a lane is still returned by
  `GET /factory/lanes/:id` and its `/report`.

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
| `qa_phase` | `claimWorktree` on a lane in `qa_wait` — its tip belongs to QA until it moves on (moving it on by `transition` is the *QA hold* above, checked before this gate) |
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

## Not wired yet

The loopback bridge is the only caller so far. The intended next steps, each a
separate, reviewable change:

1. A read-only MCP tool (`list_factory_lanes`, `get_factory_lane`) following
   the bounded-read pattern in `docs/mcp-server.md`.
2. Guarded write tools (`upsert_factory_lane`, `claim_next_factory_lane`), or
   bridge routes for what it lacks (`appendEvidence`, `releaseOwnership`, lane
   updates), so a CoS routine can run one manager-loop step per wake: harvest
   CI/QA evidence → `appendEvidence`/`transition` → `claimNextEligible` → hand
   the returned lane's `worktreePath` to the owner bot as its task `cwd`.
3. Until then, server-side code can import the module directly, one writer at
   a time (see *Storage*); tests do so in `server/factory-lanes.test.ts` and
   `server/factory-lanes.harvest.test.ts`.

## Required checks and the implementer fence

- `.omb/required-tests` is read from the recorded base commit, never from the task worktree. If the head copy differs, OMB does not run it and the task is blocked. A base with no definition is "uncertain", not a pass.
- **Fail closed.** The script runs only through an OS sandbox (`detectFactorySandbox` in `server/factory-sandbox.ts`) that keeps it from reading or writing host resources outside its workspace. No sandbox has been demonstrated on any supported host, so none is returned: with a definition at the base, OMB does not spawn the script and blocks the task with "required-tests need an OS sandbox and none is available". There is no setter, environment variable or other way to install a sandbox from production code (tests replace the module with `vi.mock`, and a test asserts no installer is exported). A sandbox may be added there only together with a test that proves that confinement.
- When a sandbox exists, the check runs from a scratch copy with an allowlisted environment (no OMB or provider credentials; HOME and TEMP point at the scratch dir), a 10 minute timeout, and on POSIX its own process group, which is killed afterwards. On Windows the direct child is killed and `taskkill /T` is attempted; an ordinary grandchild is cleaned up, but a descendant that detaches from the check survives the timeout (measured; a test asserts the survival, so fixing it must update that test). A descendant that keeps the output pipes open after the check exits does not stall the runner on Windows: it returns at its own timeout (measured; a test asserts it). These are defense in depth, not the sandbox.
- HEAD and a clean worktree are rechecked after the checks and before sealing; a drifted worktree blocks without sealing, and a committed symlink that leaves the tree blocks the seal.
- The shell and file-tool boundary refuses drive, UNC, rooted and `..` paths in both separator styles on every platform, link-creating commands, and writes through any symlink or junction. The link check is a point-in-time check, and a missing worktree fails closed. Drive-relative `C:foo` in shell text is not parsed.
- **The shell boundary is not a sandbox.** It only pattern-matches command text, so it cannot confine a program that builds a path at run time: `node -e` with a char-code path or `process.chdir("..")`, `npm test`, a git hook and the like are all allowed by it (shown by calling the decision function; nothing was executed). More path patterns would not change that. It stays as defense in depth for honest mistakes. The fix is containment, not matching: with no `detectFactorySandbox()` result, no writer is created, launched, or resumed. `createFactoryTask` and `deliverHandoff` refuse before any worktree, task record, thread, or pin is created; `launchFactoryTask` refuses before a session is stored; `factoryTurnGuard` (every Claude turn on a factory thread passes through it in `startTurn`) refuses a stored `launch_intent` or `running` task without changing it; and `recoverFactoryTasks` marks such a task `blocked` instead of restoring it to `running`, keeping its session, binding, and writer lock as stored. The refusal reads "implementation tasks need an OS sandbox ... no writer was started". None exists, so writer dispatch is disabled and required-tests stay blocked until a real Windows sandbox is demonstrated. This does not stop a session already running in a live process; it only prevents a new turn or a restore.
