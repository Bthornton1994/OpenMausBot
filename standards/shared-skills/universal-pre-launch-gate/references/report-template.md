# Final report template

Start with exactly one of: **READY FOR OWNER RELEASE DECISION**, **NOT READY**, **BLOCKED**.

1. **Audited**: repository, branch, exact SHA, environment, platforms (with how they were established), instructions read.
2. **20-row table**: `# | Check | Status | Evidence (command, output, readback, file:line, environment) | Finding`. One status per row.
3. **Changes and verification**: isolated branch and SHA, diff summary, focused test commands, exit codes, counts, required-suite final line, CI run IDs and links.
4. **Remaining risks and owner-only actions**.
5. **Not tested live**: plainly list every live service, setting, or behavior not verified (credentials, production settings, email delivery, backups, analytics, deployment, cache and CDN behavior, and so on).
6. **Next action**: the single action that would move the project forward.

Never write "production-ready" while an applicable launch-critical check is FAIL, BLOCKED, or UNKNOWN. Never include secret values.
