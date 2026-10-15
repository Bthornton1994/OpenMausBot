# Ship process

How this gate is run. It never deploys, merges, or grants release permission. The only allowed outcomes remain **READY FOR OWNER RELEASE DECISION**, **NOT READY**, and **BLOCKED**.

## One merged go / no-go

Paraphrase of `addyosmani/agent-skills` `/ship` at `aeac41d4d005999432bb7312f7ff06383a91d59d` (`.claude/commands/ship.md`): three specialist personas (code, security, tests) may run in parallel against the candidate, then the main auditor merges their reports into **one** go / no-go. The command does not deploy.

In this skill:

- Optional parallel pass: code correctness, security, and tests. Independent contexts; do not let one persona delegate to another.
- Merge in the main report: one status per core and extension check, then exactly one of the three gate outcomes.
- A critical finding from any persona is FAIL on the matching check. SKILL.md outcomes win: an owner-accepted FAIL stays **NOT READY**. Record owner acceptance only as an owner release-decision note. Acceptance does not change FAIL into PASS and does not produce READY FOR OWNER RELEASE DECISION.
- A rollback plan is required before READY FOR OWNER RELEASE DECISION (core check 20).
- This skill never deploys.

Skip the fan-out only when all of the following are true: the change touches 2 files or fewer, the diff is under 50 lines, and it does not touch auth, payments, data access, or config/env. Otherwise default to fan-out. Production-bound candidates default to the parallel pass when the host can run it. If the host cannot fan out, run the three views sequentially and still merge to one outcome.

## Shipping-and-launch extras (same pin)

Paraphrase of `addyosmani/agent-skills` `skills/shipping-and-launch/SKILL.md` @ `aeac41d4d005999432bb7312f7ff06383a91d59d`. Map onto existing checks; do not treat the source checklist as a second gate.

- Tests, lint, and typecheck: record commands and exit codes under end-to-end / verification (17 and the required suite).
- Dependency audit with no critical/high findings, or an owner-accepted residual list: security module S9 (not core 1).
- Feature flags decouple deploy from release when the project uses them (check 20 and remaining risks). This skill still does not deploy.
- Staged rollout thresholds and monitoring belong in remaining risks unless the project already requires them as launch-critical.
- Accessibility (keyboard, screen reader, contrast): record under platform evidence or remaining risks unless the project or contract requires it as launch-critical.

## Default away from ready

Paraphrase of `msitarzewski/agency-agents` `testing/testing-reality-checker.md` @ `652b2692f8d8ec2b1f1a38e559073e287dfdc469`: default verdict is NEEDS WORK until evidence proves otherwise.

In this skill that default is **not** a fourth outcome. It means:

- Start from NOT READY or BLOCKED, never from READY FOR OWNER RELEASE DECISION.
- Never turn UNKNOWN into PASS.
- Prior "zero issues" or a green CI run is not evidence.
- READY FOR OWNER RELEASE DECISION requires cited evidence on every applicable launch-critical check.

## Model judgment is advisory

Paraphrase of `jkudish/jev-mcp` @ `435d5d4db2f2b7185cef0254716b2cd57d12de0d` (`skills/jev/SKILL.md`: "The tools advise. You enforce policy." / "Judgments are signals, not proof"; `examples/hook-gate.md`: `--skip` regexes match obviously safe shapes and oversized inputs defer — print nothing and exit 0, so the harness permission flow applies at zero cost. `deny` requires `block` selected with probability at or above `--block-threshold` (default 0.85). Provider errors, timeouts, `invalid_response`, and escapes to `investigate`/`none` all defer. A Jev outage never blocks the agent, and the gate never fabricates an allow; `proceed` always defers to the harness).

In this skill:

- A model only judges. Code-owned thresholds, exit codes, configuration readbacks, and file:line citations decide auto / review / escalate.
- Any Jev or LLM judgment is an advisory flag. Pass and fail stay an exit code or cited evidence.
- Do not call Jev or TypeSafe from this skill (no API keys). If the owner later supplies a Jev report, treat it as advisory and still require independent evidence.
