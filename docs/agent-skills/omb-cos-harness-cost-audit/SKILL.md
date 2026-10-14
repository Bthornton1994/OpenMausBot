---
name: omb-cos-harness-cost-audit
description: "Use when the OMB Chief of Staff must assess or coordinate a token-efficiency change to an agent harness, prompt, tool schema, routing path, or static context."
---

# Harness cost audit — OMB CoS

Status: Draft for the OMB CoS skill review flow. This document is not loaded by the OMB app and does not grant permissions.

## Objective

Reduce price-weighted token cost per completed task without lowering task quality. Audit the harness that sends context and tools to the model; do not ask the model to “save tokens.”

## OMB role boundary

- OMB handles task intake and implementation dispatch only. Route implementation work to the registered Software Implementer through the existing factory.
- Do not dispatch QA or review seats, record a QA disposition, merge, deploy, change credentials, or change live flags through OMB.
- After an implementation produces a candidate, prepare a separate no-edit Cursor review request for the exact immutable SHA. The review runs outside OMB. Do not claim it passed until the independent reviewer returns evidence for that SHA.
- A skill or brief is guidance, not owner approval. Preserve every repo, privacy, security, and approval boundary.

## Start with an evidence table

Mark every item Verified, Inferred, or Unknown, with its source:

| Item | Required evidence |
| --- | --- |
| Target | Harness, repo, task types, current branch, and exact base SHA |
| Baseline | Per-task usage source, sample window, completion definition, and treatment of retries and failures |
| Cost | Exact model plus current primary-source prices for cached input, uncached input, and output; account usage or invoice evidence where available |
| Quality | Existing representative evaluation, success criteria, safety checks, and the owner-approved no-regression bar |
| Authority | Owner, permitted files and actions, spend limit, and review gates |

If a required item is Unknown, keep the work read-only. Gather evidence or return a precise collection plan. Do not invent prices, task success, quality thresholds, or authorization. Do not issue new provider requests, enable a live flag, install a tool, or incur spend to establish a baseline. A new paid evaluation requires explicit owner approval with a cost ceiling and data-handling plan.

## Measure tasks, not requests

For every task, sum cached input, uncached input, and output usage across all requests, retries, and rework until completion. Collect only minimal aggregate usage counters; do not persist raw prompts or task content. Report failed and abandoned task costs too.

For a cohort, report total spend across all attempted tasks divided by the number of completed tasks, alongside completion rate and the distribution per completed task. This makes failed attempts visible instead of hiding their cost. Use observed token counters and a dated price source. Label proxies and estimates explicitly; do not call them account-verified cost.

Run the same fixed task set through the baseline and candidate harness. Use the repo’s existing quality evaluation. Include output correctness, completion rate, safety and authority regressions, and any task-specific quality measures. If no accepted evaluation or decision threshold exists, stop before changing prompts or code.

## Rank and test safe changes

Once the evidence gates pass, rank proposed changes by expected cost reduction, quality risk, and reversibility. Change one lever at a time.

Prefer measured changes to what the harness sends:

- Keep static context for requirements needed by most tasks; move rarely used detail into an on-demand skill only when the task frequency data supports it.
- Remove exact duplicate instructions only after showing they are redundant. Keep safety, privacy, security, and authority rules even when they cost tokens.
- Use precise tool definitions for machine-enforced constraints. Do not replace a human safety or permission rule with a tool schema unless the runtime enforces the same behavior.
- Never add “save tokens” or similar model-facing instructions as an optimization.

Capture the before and after task set, token counters, price source, quality results, and exact diff. Revert or mark unsuccessful any change that does not show savings without crossing the approved quality bar.

## Handoff and report

Send one bounded task to the registered implementer with the target repo, base SHA, baseline source, frozen evaluation, allowed files, one proposed change, acceptance criteria, and stop conditions. Do not dispatch edits while a required gate is unknown.

When the implementer finishes, capture the exact candidate SHA and verification evidence. Prepare the separate Cursor review against that SHA; the review must be read-only and independent of the implementation session.

Report: verified/inferred/unknown facts; baseline and candidate cost per completion; completion and quality results; the exact SHA; review status; changes made; remaining blockers. Label every check PASS, FAIL, BLOCKED, NOT RUN, or UNKNOWN. Keep unresolved work proposed, not applied.
