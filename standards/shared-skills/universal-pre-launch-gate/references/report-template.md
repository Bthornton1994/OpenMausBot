# Final report template

Start with exactly one of: **READY FOR OWNER RELEASE DECISION**, **NOT READY**, **BLOCKED**.

1. **Audited**: repository, branch, exact SHA, environment, platforms (with how they were established), instructions read, extension modules applied.
2. **20-row core table**: `# | Check | Status | Evidence (command, output, readback, file:line, environment) | Finding`. One status per row.
3. **Extension table**: `ID | Check | Status | Evidence | Finding` for every applicable extension check (security S*, payments P*, launch/SEO W*, AI A*, legal L*, empty states E*). Omit a module only with a NOT APPLICABLE reason. Do not omit E1-E4 when a data-displaying UI exists.
4. **Changes and verification**: isolated branch and SHA, diff summary, focused test commands, exit codes, counts, required-suite final line, CI run IDs and links. If a parallel code/security/tests pass ran, attach the merged notes; the gate still does not deploy.
5. **Remaining risks and owner-only actions**.
6. **Not tested live**: plainly list every live service, setting, or behavior not verified (credentials, production settings, email delivery, backups, analytics, deployment, cache and CDN behavior, and so on).
7. **Next action**: the single action that would move the project forward.

Never write "production-ready" while an applicable launch-critical check is FAIL, BLOCKED, or UNKNOWN. Never include secret values. Never treat a Jev or LLM judgment as pass/fail. Never mark legal compliance PASS from this checklist.
