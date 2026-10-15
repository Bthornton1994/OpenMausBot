---
name: harness-cost-audit
description: "Audit an agent harness for lower price-weighted token cost per completed task without quality loss. Use for prompt, static context, tool schema, routing, or model-call efficiency work."
---

# Harness cost audit

Use this skill for a baseline-first, evidence-led audit. Do not tell the model to “save tokens.”

## 1. Read the project rules

Read the applicable AGENTS.md and CLAUDE.md files, the harness entry points, current tests/evaluations, and the current branch/SHA. Inspect working-tree changes before editing and preserve work you did not create. Follow project-specific safety and approval gates.

## 2. Survey before editing

Record each fact as Verified, Inferred, or Unknown, with evidence:

- Target harness, task classes, repo and base SHA.
- Source of actual usage per task, sample period, task completion definition, retries and failed work.
- Exact model and current primary-source rates for cached input, uncached input, and output.
- Existing representative quality evaluation, accepted success criteria, safety checks, and owner-approved no-regression threshold.
- Owner, allowed files/actions, spend limit, and required review.

If a required fact is Unknown, do a read-only inventory and return a collection plan. Do not edit prompts, tool schemas, routing, or static context. Do not make up pricing, quality thresholds, or permission. Do not issue new provider requests, enable a live flag, install a tool, or incur spend to establish a baseline. A new paid evaluation requires explicit owner approval with a cost ceiling and data-handling plan.

### Frame the outcome and evidence

Before proposing a savings change:

- State the bounded task outcome behind the request. Optimize cost per completion only within that outcome and the authorized scope.
- Identify the rawest approved evidence and real domain methods/tools a capable practitioner would use. Verify that data and tools are available and authorized; do not substitute persona role-play for method.
- Name the accepted independent evaluation or external signal that can reject a wrong or lower-quality result. A model or implementer self-score is not enough.
- Add another discipline only when it contributes a distinct method or check relevant to the outcome; do not add decorative roles or extra agents by default.

If the evidence, approved tools, or outside judge is Unknown, keep the work read-only. Do not obtain it through new provider requests, installs, access, or spend. Freeze the task set and evaluation before measuring.

## 3. Measure task cost and quality

Sum cached input, uncached input, and output tokens across all requests, retries, and rework for each task. Collect only minimal aggregate usage counters; do not persist raw prompts or task content. Include failed and abandoned task spend in the cohort total. Report total cohort spend divided by completed tasks, completion rate, and per-task distribution. Label estimates and proxies; never present them as invoice-verified.

Compare baseline and candidate on the same fixed task set and the project’s existing quality evaluation. Report correctness, completion rate, safety/authority regressions, and task-specific quality. If there is no valid evaluation or agreed quality bar, stop before changing anything.

## 4. Make one measured change

After every evidence and authority gate passes, rank changes by expected savings, quality risk, and reversibility. Change one variable at a time.

Prefer changes to what the harness sends: keep static context for common needs and move infrequent detail into an on-demand skill only when task-frequency evidence supports that split. Remove only demonstrably duplicated instructions. Preserve safety, privacy, security, and approval rules. A tool schema may replace prose only for constraints the runtime actually enforces. Never use a “save tokens” instruction as the optimization.

Capture the exact diff, baseline and candidate usage, pricing source, evaluation output, and candidate SHA. Revert or mark unsuccessful any change that does not save cost within the agreed quality bar.

## 5. Handoff

Return the evidence table, measurement method, cost and quality results, exact SHA, review status, and blockers. Do not merge or deploy unless the user separately authorized it and the repository gates permit it.

For OpenMausBot factory work, OMB dispatches implementation only. QA and independent review happen outside OMB. Prepare a read-only Cursor review request for the exact candidate SHA; do not treat the implementation session as independent review.
