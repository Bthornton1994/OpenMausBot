---
name: harness-cost-audit
description: "Audit an agent harness for lower price-weighted token cost per completed task without quality loss. Use for prompt, static context, tool schema, routing, or model-call efficiency work."
---

# Harness cost audit

Run this as a read-only survey first. The goal is lower price-weighted token cost per completed task with no drop against the project’s accepted quality bar. Do not tell the model to “save tokens.”

## Inspect the repo and gates

Read AGENTS.md and applicable project instructions. Inspect the target harness, task classes, tests/evaluations, branch, exact base SHA, and existing working-tree changes. Preserve user work.

Build an evidence table with Verified, Inferred, or Unknown for:

- Target harness and repo.
- Actual per-task usage source, sample period, completion definition, retries, failures, and abandoned tasks.
- Exact model and current primary-source rates for cached input, uncached input, and output.
- Representative quality evaluation, success criteria, safety checks, and owner-approved no-regression threshold.
- Owner, allowed files/actions, spend limit, and review gates.

If any required evidence or gate is Unknown, do not edit. Return a read-only findings report and the smallest evidence-gathering plan. Do not invent rates, quality thresholds, or permissions.

## Compute task-level cost

Sum cached input, uncached input, and output tokens over all requests, retries, and rework for each task. Include every attempted task’s cost in cohort spend, including failed or abandoned work. Report cohort spend divided by completed tasks, completion rate, and per-task cost distribution. Mark estimated or proxy figures clearly; use no fabricated invoice certainty.

Compare baseline and candidate using the same fixed task set and the existing quality evaluation. Include correctness, completion rate, safety and authority regressions, and task-specific quality. Without a valid evaluation and agreed quality bar, stop before any change.

## Change one lever

Once all gates pass, rank options by expected savings, quality risk, and reversibility. Change one lever at a time.

Prefer measured changes to harness-sent context and tool definitions. Keep static context for requirements most tasks need. Move rare details into an on-demand skill only if task-frequency evidence supports it. Remove only proven duplication. Preserve safety, privacy, security, and authority instructions. Replace prose with a tool schema only when the runtime enforces the same constraint. Never add “save tokens” instructions.

Save the exact diff, before/after usage, price source, quality results, and tested SHA. Revert or mark unsuccessful a change that fails to save cost within the agreed quality bar.

## Report and review

Report the evidence table, formula and usage source, cost and quality results, exact SHA, checks, and blockers. Label checks PASS, FAIL, BLOCKED, NOT RUN, or UNKNOWN. Do not merge or deploy unless explicitly authorized and allowed by repo policy.

For OpenMausBot factory changes, OMB is limited to implementation dispatch. QA and independent review happen outside OMB. A separate no-edit Cursor review must inspect the exact candidate SHA; the implementation agent cannot review its own work.
