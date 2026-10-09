---
name: universal-pre-launch-gate
description: "Use near a launch or release decision for any product (web, native iOS or Android, desktop, game, API or backend, AI product, other) to audit a specific release candidate against a 20-check evidence-based gate and return READY FOR OWNER RELEASE DECISION, NOT READY, or BLOCKED. Not for routine reviews, mid-development checks, or deployment: it never grants permission to merge, deploy, spend, or launch."
---

# Universal Pre-Launch Gate

Decide whether one exact release candidate is ready for the owner's release decision. The skill audits and closes routine, authorized gaps. It never launches, merges, or deploys, and it is guidance only: the host and repository enforce permissions and release authority.

## 1. Establish the facts first

- Identify the project, repository and owner, release-candidate branch and exact SHA, target platforms, current environment (local, preview, staging, production), and launch requirements. If a field is blank and cannot be found in project records, ask the owner. Do not guess a repository or SHA.
- Read the project's current instructions (`AGENTS.md`, `CLAUDE.md`, vision, specs, security and privacy decisions, deployment docs, existing release gates). These are project-specific requirements and win over this skill's defaults. Do not weaken a stricter project gate.
- Confirm the checked-out commit equals the candidate SHA. Check for active writers, other worktrees on the branch, and uncommitted changes before editing anything. Preserve work you did not create.
- Detect platforms from the repository and instructions (see `references/platform-modules.md`). If a platform is not established, mark dependent checks UNKNOWN. Do not assume a web check applies to a native app, or the reverse.

## 2. Authority limits (always)

Without separate, project-specific authority, never: buy domains, create accounts, incur costs, expose or change production credentials, alter live services, send real customer email, charge real payments, delete user data, rewrite Git history or force-push, merge, or deploy. Use sandbox accounts, test inboxes, test payment modes, and test data for end-to-end, email, payment, and restore checks. Stop only for a real owner decision, unavailable access, or an action outside authority; continue independent, safe work.

Never print secret values. Report a credential's location and type only. A verified committed credential is an incident: deleting it in a new commit is not remediation; it needs revocation or rotation through an authorized process.

## 3. Audit, then fix

1. Audit all applicable checks before proposing changes (`references/core-checklist.md`, 20 checks).
2. Fix only routine, reversible, repository-contained gaps, on an isolated branch, within the project's rules and existing authority. Keep changes in scope.
3. Run focused tests per fix, then the project's required verification suite. Record commands, exit codes, counts, final lines, CI run IDs and links.
4. Re-check the final diff and exact SHA. Do not enable a production integration or deploy.
5. Minimize hosted CI use: do one local verification pass first; do not rerun failed Actions automatically; push or trigger CI only when the owner authorized it.

## 4. Status rules

Every check gets exactly one status:

- **PASS**: evidence supports it (test result, command output, configuration readback, or exact file and line).
- **FAIL**: evidence shows a defect.
- **BLOCKED**: an owner action, missing access, or decision prevents completion.
- **NOT APPLICABLE**: only with a project-specific reason and evidence that the feature or risk does not exist.
- **UNKNOWN**: evidence is missing, inconclusive, or the platform or behavior is not established.

Never turn UNKNOWN into PASS. Never mark a check NOT APPLICABLE because it was not inspected. A CI pass does not prove live credentials, production settings, email delivery, backups, analytics, or deployment behavior. Provider alerts are not hard spending caps. Email delivery is never guaranteed. Do not invent legal assurances: mark required legal review BLOCKED until it has happened.

## 5. Outcome

Start the report with exactly one of:

- **READY FOR OWNER RELEASE DECISION**: every applicable launch-critical check is PASS or has a valid NOT APPLICABLE, with no unresolved blocker.
- **NOT READY**: at least one applicable launch-critical check is FAIL.
- **BLOCKED**: no FAIL, but an applicable launch-critical check is BLOCKED or UNKNOWN pending owner action or access.

Never say "production-ready" while an applicable launch-critical check is FAIL, BLOCKED, or UNKNOWN. Report format: `references/report-template.md`.

## References

- `references/core-checklist.md`: the 20 core checks, what counts as evidence, and which are universal vs feature- or platform-dependent.
- `references/platform-modules.md`: platform-specific evidence for web, iOS, Android, desktop, games, API and backend, AI products, and how to add a new platform module without forking the core gate.
- `references/report-template.md`: the final report structure.
- `references/host-adapters.md`: how a host discovers this skill, and which hosts are verified (currently none).

There is one canonical checklist. Project integrations point to it or are generated from it; do not keep divergent copies.
