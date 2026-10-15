# Pre-ship candidate items (verified vs UNKNOWN)

Untrusted source: X post `2110705357492203564` (@mardehaym), mirror-sourced 2026-10-15 (X.com returned HTTP 402; fxtwitter HTTP 200). Items are candidates. This table is not a second 150-check gate. Independently verified items map into core or extension checks. Unverifiable items stay UNKNOWN.

Legend: **mapped** = required under that check when the feature exists; **supporting** = remaining risk or project-specific, not a universal launch-critical FAIL; **UNKNOWN** = not independently verified here.

## Independently verified (mapped)

| Candidate (paraphrased) | Verification | Gate mapping |
|---|---|---|
| Email local-part with `+` | RFC 5322 §3.2.3 `atext` includes `+` (fetched `https://www.rfc-editor.org/rfc/rfc5322`) | S12 |
| Money not in binary floating point | Local eval: `0.1 + 0.2 === 0.3` is false | P10 |
| Secrets out of code/repo | Core gate already | 1, 2, S1 |
| Rotate committed keys; delete is not remediation | Core gate already | 2 |
| Rate limits on login and expensive calls | Core gate already | 3, S3 |
| Server-side auth; IDOR by changing an id | Core gate already | 4, S2, S16 |
| Tenant / row isolation | Core gate already | 5, S17 |
| Server-side validation | Core gate already | 6 |
| Parameterized queries / injection | OWASP class; code search is evidence | S4, 6 |
| Safe errors; no stack traces | Core gate already | 8 |
| Error tracking | Core gate already | 9 |
| Backups plus a restore test | Core gate already | 10 |
| 404/500 usable states | Core gate already | 11 |
| Empty, loading, error states on every data surface | Product-UI requirement; see empty-state module | E1-E4 |
| Load time / low-end device | Core gate already | 12, 13 |
| Privacy policy and terms matching the product | Core gate already; legal review still required | 15, L1 |
| Analytics without unnecessary PII | Core gate already | 16 |
| Signup, payment, password reset E2E in test mode | Core gate already | 17 |
| Password-reset single use and expiry | Standard reset threat model; testable | S13 |
| SPF, DKIM, DMARC | Core gate already | 18 |
| User contact path | Core gate already | 19 |
| Rollback written and tested where safe | Core gate already | 20 |
| Stripe webhook signatures | Stripe docs: verify `Stripe-Signature` / raw body | P1 |
| Idempotency keys so retries do not double-charge | Stripe docs: `Idempotency-Key` | P2 |
| Failed payments, refunds, upgrades, cancel, receipts | Processor test-mode paths | P3-P8 |
| Prompt-injection on fields that reach a model | AI module / A2 | 6, A2 |
| Model spend cap | Core 3/7, A3 | 3, 7, A3 |
| CORS not `allow everything` on authenticated APIs | Header readback | S5 |
| Security headers | Header readback | S8 |
| Logs without passwords/tokens/PAN | Log sample | S11, P9 |

## Feature- or contract-dependent (supporting unless the project requires them)

MFA, session kill-switch, SSO, SAML, SCIM, support impersonation with audit trail, point-in-time recovery, soft deletes, connection pooling, indexes at production scale, pagination at large offsets, import/export, retention jobs, pentest, enterprise questionnaires, disclosure program, stolen-laptop plan, on-call rotation, status page, feature flags, CDN, second region, zero-downtime deploys, annual contracts, usage metering, versioned public API, sandbox for integrators. Record as remaining owner actions. Do not FAIL a consumer MVP solely for missing SAML.

## UNKNOWN (not independently verified in this task)

| Candidate | Why UNKNOWN |
|---|---|
| Penalty dollar amounts and named court outcomes (COPPA, CAN-SPAM, CIPA, DMCA, Google Fonts/GDPR damages) | Social-media figures; not checked against statute or case law. See `legal.md`. |
| SOC 2 / HIPAA / BAA / PCI / GDPR / residency as a checklist PASS | Needs a qualified lawyer or auditor, not this gate. |
| Anthropic OSS Scanner eligibility and terms | Brief already labels terms UNKNOWN. Post `2108690218639630658` is not program terms. |
| "Schema someone designed" as a binary gate | No objective evidence rule without project design records. |
| Lockout policy that never locks a specific executive | Policy choice; not a universal test. |
| "Code a human can read", bus factor, README-in-an-hour | Process quality; no evidence rule that this gate can PASS/FAIL uniformly. |
| Exact accessibility standard required | Contract-dependent. Keyboard/screen-reader evidence may still be recorded under shipping-and-launch extras. |

Unverifiable items must not be marked PASS.
