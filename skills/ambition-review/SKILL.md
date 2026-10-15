---
name: ambition-review
description: "Turn strategic, ambiguous, repeated, or multi-step project work into three evidence-based Altitude, Depth, and Range options. Use before editing or dispatch; wait for the user's selection."
---

# Ambition Review

Use this review before editing or dispatching strategic, ambiguous, repeated, or multi-step project work. Skip it for a clear, narrow fix unless the user asks. The approach is adapted from [How to be more ambitious](https://felixrieseberg.com/how-to-be-more-ambitious-a-tutorial-for-humans-with-models/).

## Ground the options

Use read-only inspection of the project files, README, recent commits, TODOs, logs, and raw data that are actually available. Do not invent repository history, access, metrics, or owner decisions. Mark material claims **Verified**, **Inferred**, or **Unknown**. If the project is unavailable, use the conversation evidence and say what you could not inspect.

Do not edit files, dispatch teammates, start implementation threads, install software, or make external changes before the user selects an option. Read-only inspection and preparing the options are allowed.

## Build three goals

Return all three options, grounded in what the project is trying to achieve:

1. **Altitude** — Infer the durable outcome behind the repeated one-off tasks. Phrase it as a long-term goal the user could hand to you, with a clear result to maintain or improve.
2. **Depth** — Choose the one thing that most needs to be done well. Identify what a leading practitioner in the relevant field would do, the rawest useful material to start from, and the specific tools and methods. Set a measurable stretch target that looks unreasonable but is still testable. Name an independent test, script, benchmark, or evaluator; do not ask the model that produced the work to grade itself.
3. **Range** — Describe what the project is trying to accomplish using verbs. Identify the useful fields and, for each, one concrete practice people in that field use and how it applies here. Describe what people do; do not role-play experts.

For each option, state:

- **Why it matters**
- **What it needs** — data, access, tools, evidence, or an owner decision; label unknowns
- **First step** — one concrete action that can begin after selection

Keep options distinct and bolder than simply doing the current task faster. Do not inflate scope just to sound ambitious. If available evidence supports only a modest goal, explain the limit.

## Present and wait

Show the three options first, in this format:

### Altitude — [short goal]
- **Why:** …
- **Needs:** …
- **First step:** …

Repeat for **Depth** and **Range**. Keep facts, inferences, and unknowns clear. Cite project sources when useful.

Then stop and wait for the user's selection. Do not begin implementation in the same turn. If asked which is best, recommend one and explain why, but still wait. Treat a clear selection by name, number, or an unambiguous reference to your recommendation as approval to proceed; ask one focused question if the choice is unclear.

## After selection

Proceed only with the selected goal. Start from its stated first step, use the named raw material and methods, and verify the result with the independent check. Report what was verified and what remains unknown. The selection does not grant authority for unrelated changes, deployments, merges, purchases, messages, credential changes, or production actions; follow the user's existing approval boundaries.

## Source

Felix Rieseberg, “How to be more ambitious: A tutorial for humans with models,” 13 October 2026. The framework used here is Altitude, Depth, and Range; Speed is omitted because this skill returns the three goal options requested by the user.
