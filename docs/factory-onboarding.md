# Software factory onboarding

The store is the OpenMausBot app (`DATA_DIR/factory-tasks.json`, loopback API `/api/factory`). A directory outside the app is not a second source of truth.

## Scope

OMB handles task intake and implementation dispatch only. QA and independent review are performed outside OMB. OMB does not launch QA, assign a QA or review specialist, record a QA disposition (CLEAR, KEEP_DRAFT, NOT_CLEAR), or mark a task release_ready. OMB does not provide a QA worktree, a read-only review snapshot, or QA isolation.

Every QA entry point that is still routed rejects with the error code `qa_outside_omb` (HTTP 410) and starts nothing: a QA, review, test, or release specialist at intake, a QA intake field (`qaOfTaskId`, `headSha`, `prUrl`, `qaDisposition`, `reviewedSha`, `reviewerId`, `testerId`, `releaseId`, `remediationLimit`), a harvest that carries a QA disposition or reviewed SHA, a launch, harvest, or turn on a stored QA or review task, a delivery of a stored review, test, or release handoff, a wait into `waiting_qa`, and the ship gate.

A stored task in `waiting_qa` or another QA state still loads. It keeps its worktree reservation and nothing starts QA from it. Cancel it to release the repository.

## Seats

Seven specialist ids are registered in the app. Only the Software Implementer is dispatched. Coding seats use catalog Claude Opus 5.5 (`claude-opus-5-5`). That is not another product name. Fable (`claude-fable-5-1`) is advisor-only and is not an implementer. Finch stays and is not a specialist.

Permissions are Auto only. `bypassPermissions` and Full are rejected. The implementer writes only inside the task worktree: the Claude spawn and a PreToolUse hook fail closed outside it, and the implementer cannot push or merge. If that fence cannot be applied, the role is marked unavailable and dispatch is blocked.

## How a task starts

1. Intake: objective, implementer specialist id, model, permissions, repo, base SHA, acceptance, dependencies, required evidence, owner, authority.
2. Missing owner, unclear authority, a protected session, a frozen tip, or a blocked dependency does not create a worktree. A repository that already has a writer is refused.
3. The app creates an isolated git worktree and stores the task-to-worktree binding before any worker turn. It does not use the bot's global folder as the pin.
4. Launch stores the Claude session id on that same task, then starts the turn. Status becomes running only after both are stored. A second launch returns the binding and does not start another writer.
5. Quiet waits (`waiting_ci`, `waiting_owner`, `waiting_external`) keep the worktree reserved.
6. On worker completion the server reads the task, specialist, session, generation, canonical worktree, repository, branch, and git HEAD. An agent SHA or a done message is not the result. A mismatched SHA is stored as a rejected revision and is never adopted. When the implementer session ends and still holds the exclusive writer lock, the server verifies that binding, a clean worktree, actual HEAD, and ancestry from the recorded base and from the writer's starting SHA, then stores an immutable candidate (generation, writer session, SHA, tree, worktree, and the verification evidence). That sealed SHA is the task result and the task is harvested. A desk harvest during the writer session records evidence only. If the worktree is dirty, HEAD does not descend, or provenance cannot be proved, the task stays blocked and keeps its writer lock.
7. Restart resumes only when the stored session id was proven and the worktree still matches. Otherwise the task stays blocked. A stored QA or review session is not resumed.

## Same-task handoffs

A stored implementation handoff (stage `remediate`, to the implementer) is still delivered on the same task id after the previous turn ends and the writer lock is held by the implementer. It is stored before the next session starts, a retry does not start a second worker, a failed start leaves it undelivered, and a session that submitted a rejected SHA is not reused.

## Out of scope

Markout C2/C3/C5, Media Lens live URL, and Release Rescue host work stay ineligible. Do not open a non-loopback listener.
