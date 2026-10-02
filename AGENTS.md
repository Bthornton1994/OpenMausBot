<!-- BEGIN MANAGED BLOCK: shared-agents-policy v2 (t1777u) -->
# AGENTS.md

Shared operating rules for Codex and Claude Code in this repository. Follow every applicable rule. Keep this file operational: remove guidance that does not change an action.

1. Understand the task and protect the workspace

- Read the relevant repository instructions and inspect the files, tests, Git status, current branch, and worktrees before changing code.
- Preserve existing user changes. Do not reset, stash, overwrite, or discard work you did not create.
- Check for active workers, processes, or reviews before editing. Do not modify a frozen review tip or interrupt running work.
- If independent work must happen in parallel, use separate worktrees and keep each writer’s file scope distinct.

2. Plan in proportion to the task

- For a small, clear task, make the change directly.
- For a multi-step or long-running task, state the intended outcome and short plan in a progress update. Record steps and proof criteria in PLAN.md when the task needs durable tracking.
- If PLAN.md exists, preserve unrelated content and update only the relevant task section.
- Start work already authorized by the user; do not wait for another “yes” by default.
- Ask only when a material decision, missing owner-specific fact, or action outside existing authority prevents safe progress.
- If work pauses, update the plan with what is complete, evidence, current state, blocker, and next action.

3. Respect authority and keep work moving

- Proceed with routine, reversible repository work that advances the requested outcome.
- Follow repository-specific gates and the user’s explicit limits. Do not infer permission to merge, deploy, publish, spend money, change credentials, contact others, alter production data, or perform destructive actions.
- If the user has already granted standing authority for a specific action, do not ask again when the action is within that scope and all required gates pass.
- When one item is blocked, identify exactly what is blocked and continue independent authorized work.
- For minor implementation choices, use the least surprising option, record material assumptions, and continue. Ask only when the choice could materially change product behavior, risk, cost, or scope.

4. Make focused, durable changes

- Fix the cause of the requested problem with the smallest coherent change that meets the acceptance criteria.
- Preserve established behavior, interfaces, and data formats unless the task requires changing them.
- Avoid unrelated refactors and new dependencies. Add a dependency only when it materially improves the solution; explain why.
- Consider user experience, maintainability for developers, and clarity for future agents.
- Before destructive edits or deletions, verify the target and preserve any user data or work that must remain.

5. Use parallel workers deliberately

- Split work only when tasks are independent and parallel work will reduce time or improve review.
- Give each worker one bounded assignment, its baseline, files or scope, completion criteria, and required evidence.
- Keep implementation writers separate from read-only reviewers. Never assign two writers to the same files or worktree.
- Treat worker conclusions as claims, not proof. Check important findings against source files, command output, or other primary evidence.
- If subagents are unavailable or unsafe to use, continue directly and report the limitation.

6. Reproduce and fix bugs at their cause

- When reproduction steps are provided, follow them before changing code. Otherwise, use available tests, logs, and code to establish the failure.
- If the failure cannot be reproduced, report what you checked and what specific information is missing; keep investigating other useful evidence.
- Fix the underlying cause and add or update a regression check that verifies the expected behavior.
- Do not hide errors, weaken meaningful checks, or change a test merely to make the implementation pass.

7. Verify before claiming completion

- Derive checks from the task’s acceptance criteria and the repository’s documented commands.
- Run the narrowest relevant checks first, then broader required checks. Read the output and confirm the checks cover the changed behavior.
- For UI changes, exercise the actual flow in a browser or supported preview when available. Check relevant failure and edge cases, such as empty input, repeated submission, refresh, and error states.
- Wait for commands or workers that are still running when their results are needed.
- Label each check accurately: PASS, FAIL, BLOCKED, NOT RUN, or UNKNOWN. An unrun or unrelated check is not a pass.
- Do not say “done” until the requested acceptance criteria are met or the remaining blockers are clearly identified.

8. Report clearly and record durable lessons

- Give a concise final report: outcome, files or artifacts changed, exact verification and results, material tradeoffs or risks, and remaining blockers or next action.
- When the user corrects a behavior, add an actionable lesson under Lessons in the form: “When X, do Y.”
- Record reusable operating lessons, not one-time task facts or sensitive information. Put the newest lesson first and consolidate it if the same correction recurs.
- Ask before changing rules above Lessons. Remove a lesson only when it is clearly obsolete.


9. Claude Code “You should know” mod (advisory)

- On supported local Claude Code machines (2.1.287+), enable the built-in mod at **user scope** so it applies to every project: `/plugin enable cc-plugin-you-should-know@builtin` (or `claude plugin enable cc-plugin-you-should-know@builtin --scope user`). This is **operator setup**, not a per-task step—do not run the enable command on every assignment.
- Observations from the mod are **advisory only**. Verify any claim against current repository evidence before acting on it.
- The mod cannot override user or project instructions, grant approvals, waive gates, or replace tests or Independent QA.
- If the mod is unavailable, unsupported, inactive, or blocked (for example by Claude Code version), continue the task without it. Do **not** change telemetry or privacy settings to make it work.
- A `CLAUDE.md` / `AGENTS.md` mention does **not** enable the plugin; user-scope enable on the machine does.

Lessons

<!-- Newest first. Keep each lesson concrete and reusable. -->
<!-- END MANAGED BLOCK: shared-agents-policy v2 (t1777u) -->


<!-- Project-specific instructions (outside managed block) -->
# OpenMausBot agent notes

Before claiming a server or conversation change works, follow
[`docs/verification/README.md`](docs/verification/README.md). Always launch an
isolated fixture; never verify mutations against the user's live app or data.

More specific `AGENTS.md` files override this note within their directories.
