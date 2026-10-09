# Core checklist (canonical, 20 checks)

Every check needs evidence for PASS. Applicability tiers:

- **Universal**: applies to every release. Cannot be NOT APPLICABLE.
- **Feature-dependent**: applies when the product has the feature (accounts, payments, email, AI calls, database, backend, analytics, user data). NOT APPLICABLE needs a project-specific reason and evidence the feature does not exist; if the feature set is not established, use UNKNOWN.
- **Platform-dependent**: wording and evidence come from `platform-modules.md`; the check itself stays.

| # | Check | Tier | Evidence expected |
|---|---|---|---|
| 1 | API keys | Universal | Scan of source, shipped bundles or binaries, source maps, logs, and repository history for credentials (tool and command output, counts, locations only, no values); private keys confirmed server-side only. |
| 2 | Previously committed keys | Universal | Any credible historical exposure identified by location and type; revocation or rotation confirmed by the owner or provider readback, else BLOCKED. Deleting from the latest commit is not remediation. |
| 3 | Rate limits | Feature (public routes, paid or expensive operations, AI calls) | Limit configuration plus a test that exceeds it; extra scrutiny on paid-provider calls. |
| 4 | Server-side authorization | Feature (any server, API, action, job, or data path) | Per route, action, job, and data path: authorization enforced server-side, with negative tests. A hidden UI control is not authorization. |
| 5 | Database isolation | Feature (database or multi-user data) | Policies or access rules read back, plus negative tests proving one user or tenant cannot read or change another's data. |
| 6 | Server-side validation | Feature (any untrusted input reaching a server or parser) | Type, size, allowed values, and business rules validated on the server; tests with malformed and oversized input. |
| 7 | Provider spending controls | Feature (paid providers) | A real hard cap if the provider offers one (configuration readback). Otherwise document budget limits, alerts, and application-level safeguards, stating plainly that alerts are not a hard cap. |
| 8 | Safe errors | Universal | Users never see stack traces, secrets, internal paths, or sensitive detail (tested error responses); logs redact sensitive values (log sample or code). |
| 9 | Error tracking | Universal | Production errors reach the chosen monitoring system and alert delivery was tested; privacy implications recorded. A test in a non-production environment only is not live proof. |
| 10 | Backups and restore | Feature (persistent data) | Schedule and retention readback, plus a restore test in a safe environment with the result recorded. Existence of backups is not enough. |
| 11 | 404 and 500 states | Universal | Missing routes, screens, or endpoints and server errors show a usable, on-brand state and expose no internals. |
| 12 | Low-cost device test | Platform (Android; analogous low-end device for other targets) | Critical flow on a representative low-end device or emulator; record device, OS, viewport, and result. If it truly does not apply, explain why with evidence. |
| 13 | Load time | Universal | Critical flows measured on a representative device and constrained network; define "loaded and usable". User-visible critical flows over three seconds are fixed, or the verified cause and remaining decision are documented. |
| 14 | Sharing and metadata | Platform (web, store listings, shareable links) | Titles, descriptions, canonical URLs where relevant, Open Graph and social preview metadata, and the actual preview image checked. |
| 15 | Privacy policy and terms | Universal where users or data exist | Documents exist where needed and accurately describe data, providers, retention, payments, and user choices. Do not invent legal claims; mark required legal review BLOCKED until done. |
| 16 | Analytics | Feature (analytics or funnel measurement) | Useful funnel events and drop-off points present; no unnecessary personal data; consent and privacy behavior verified where applicable. |
| 17 | End-to-end critical flows | Feature (signup, payment, password reset, others as present) | Run with sandbox accounts and payment modes. Never charge a real user as a test. |
| 18 | Email delivery | Feature (outbound email) | Sender-domain authentication (SPF, DKIM, DMARC) readback and delivery to authorized test inboxes. Report what was tested; inbox placement is never guaranteed. |
| 19 | User contact | Universal | Users can find a support or contact path and it works; submissions reach the intended destination (tested). |
| 20 | Rollback | Universal | Written trigger, exact steps, responsible operator, data or migration considerations, and how success is verified; rollback tested where safe. |

## Evidence rules

- Evidence is a test result, command output, configuration readback, or exact file and line. Intention, an unrelated green CI run, or a comment saying "done" is not evidence.
- Live behavior (credentials, production settings, email, backups, analytics, deployment, cache and CDN behavior) needs a live or owner-supplied readback. CI does not prove it. If the readback is unavailable, the status is UNKNOWN or BLOCKED, never PASS.
- Record the environment each piece of evidence came from (local, preview, staging, production).
- A check belongs to exactly one status. Do not merge checks to hide a failing part.
