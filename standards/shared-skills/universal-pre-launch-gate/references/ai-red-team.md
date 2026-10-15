# AI red-team tooling (named options only)

Applies when the product calls a model, ships prompts, or runs agents (see the AI platform module). This skill **does not install, invoke, or spend on** these tools. Do not run them as part of the gate.

Candidate list from untrusted X post `2107504908027212198`. Names are options the owner may already have used.

| Option | Repo (as named) | Notes for this gate |
|---|---|---|
| promptfoo | `promptfoo/promptfoo` | MIT, not archived (GitHub API read 2026-10-15). |
| garak | `NVIDIA/garak` | Apache-2.0, not archived (same read). |
| PyRIT | Post named `Azure/PyRIT` | `Azure/PyRIT` is **archived** (GitHub: archived true, pushed 2026-03-25). README there says the project moved to `https://github.com/microsoft/PyRIT`. Active repo `microsoft/PyRIT` was not archived on the same read. If citing PyRIT, name `microsoft/PyRIT` and record that `Azure/PyRIT` is a legacy redirect. |
| Others on that post (Rebuff, LLM Guard, Vigil, NeMo Guardrails, Giskard, DeepTeam, FuzzyAI) | as named | Not required. Record only if the owner already produced a report. |

## Check

| ID | Check | Maps to | Evidence expected |
|---|---|---|---|
| A1 | Named red-team option | 6 (prompt-injection and untrusted content) | If the owner supplies an existing report from promptfoo, garak, PyRIT (`microsoft/PyRIT`), or another named tool: cite the report path, date, and findings. Absence of a run is **not** FAIL. Do not install or run the tool to obtain one. If no report exists, record UNKNOWN or remaining owner action. |
| A2 | Prompt-injection handling | 6 | Tests or code showing untrusted content is not executed as instructions; output validated before use. Independent of A1. |
| A3 | Spend cap per user or globally | 3, 7 | Hard provider cap if offered; otherwise application-level cap plus alerts (alerts are not a hard cap). |
| A4 | Fallback when the model provider is down | 9, 17 | Documented degraded behavior, tested if safe. |
| A5 | Eval for launch-critical model behavior | AI module | Existing eval output, if any. This skill does not add eval infrastructure. |

## OSS Scanner

Untrusted X post `2108690218639630658` describes Anthropic OSS Scanner (`anthropics/oss-scanner`). Eligibility, terms, and whether a given repo qualifies are **UNKNOWN**. Do not treat a social-media summary as program terms. Do not apply.
