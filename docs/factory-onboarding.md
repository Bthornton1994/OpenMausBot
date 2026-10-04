# Software factory onboarding

The store is the OpenMausBot app (\`DATA_DIR/factory-tasks.json\`, loopback API \`/api/factory\`). A directory outside the app is not a second source of truth.

## Seats

Seven specialist ids are registered in the app. Coding seats use catalog Claude Opus 5.5 (\`claude-opus-5-5\`). That is not another product name. Fable (\`claude-fable-5-1\`) is advisor-only and is not an implementer. Finch stays and is not a specialist.

Permissions are Auto only. \`bypassPermissions\` and Full are rejected. Read-only seats (navigator, security, UI, game, QA, release) cannot edit files or submit implementation changes: the Claude spawn disallows those tools and a PreToolUse hook fails closed. The implementer writes only inside the task worktree. If that fence cannot be applied, the role is marked unavailable and dispatch is blocked.

## How a task starts

1. Intake: objective, specialist id, model, permissions, repo, base SHA, acceptance, dependencies, required evidence, owner, authority.
2. Missing owner, unclear authority, a protected session, a frozen tip, or a blocked dependency does not create a worktree.
3. The app creates an isolated git worktree and stores the task-to-worktree binding before any worker turn. It does not use the bot's global folder as the pin.
4. Launch stores the Claude session id on that same task, then starts the turn. Status becomes running only after both are stored. A second launch returns the binding and does not start another writer.
5. Quiet waits (\`waiting_ci\`, \`waiting_qa\`, \`waiting_owner\`, \`waiting_external\`) keep the worktree reserved.
6. Harvest writes the result SHA, evidence, checks, blocker, and next action on the same task. A session or worktree mismatch, or missing evidence, is rejected. CLEAR, KEEP_DRAFT, and NOT_CLEAR are evidence only. The implementer cannot record them. QA is a different specialist and reviews the exact SHA. Nothing is merged.
7. Restart resumes only when the stored session id was proven and the worktree still matches. Otherwise the task stays blocked.

## Out of scope

Markout C2/C3/C5, Media Lens live URL, and Release Rescue host work stay ineligible. Do not open a non-loopback listener.
