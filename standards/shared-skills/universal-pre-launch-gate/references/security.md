# Security extension

Extra evidence under the core security checks. Candidate wording came from untrusted X posts (`2106697085311406390`, `2108376910577246579`, `2110705357492203564`) and from `addyosmani/agent-skills` `skills/shipping-and-launch/SKILL.md` @ `aeac41d4d005999432bb7312f7ff06383a91d59d`. Overlap source (not in this repo, do not edit): Grok Bot `public-share-security-audit`.

Do not weaken core checks 1-8. Status and evidence rules are unchanged.

| ID | Check | Maps to | Evidence expected |
|---|---|---|---|
| S1 | Secrets out of client, repo, and chat logs | 1, 2 | Scan of source, shipped bundles, history, and (where authorized) CI logs; locations and types only. Any past commit of a credential needs owner/provider revocation readback. |
| S2 | Server-side auth on every route, job, and data path | 4 | Negative tests: unauthenticated and cross-user requests fail. A hidden UI control is not authorization. Never trust a user id sent only from the client. |
| S3 | Rate limits on login, signup, and paid or expensive operations | 3 | Limit configuration plus a test that exceeds it. Extra scrutiny on paid-provider and AI calls. |
| S4 | Parameterized queries; no string-built SQL | 6 | Code search for string-built queries; tests with injection payloads on user-controlled input. |
| S5 | CORS locked to intended origins (not `*`) on credentialed or authenticated APIs | 4 / web module | Readback of allowed origins. Wildcard plus credentials is FAIL. |
| S6 | Cookie flags on session cookies | 4 | `HttpOnly`, `Secure`, and a documented `SameSite` value, read back from Set-Cookie or config. |
| S7 | Password hashing | 4 | Algorithm and parameters read from code or IdP config (argon2 or bcrypt, or the project's IdP). Plaintext or reversible storage is FAIL. |
| S8 | Security headers on web responses | 8 / web module | Live or staging response headers (for example CSP, HSTS). Missing headers on a public web app are FAIL or UNKNOWN if not fetched, never PASS. |
| S9 | Dependency vulnerabilities | — (not core 1; core 1 is API keys) | Project's audit command (`npm audit`, `pip-audit`, `cargo audit`, or equivalent) exit code and summary counts. Any unresolved critical/high finding is FAIL. S9 is launch-critical in its own right: S9 FAIL selects **NOT READY**. An owner-accepted residual list does not turn FAIL into PASS; record it as an owner-accepted FAIL (owner release-decision note) and the outcome stays NOT READY. This skill does not install scanners. |
| S10 | Uploads (if present) | 6 | Size limit, type allow-list, stored outside the executable web root, and a test of a rejected oversize or disallowed file. |
| S11 | Logs do not record passwords, tokens, or card numbers | 8 | Log sample or redaction code. Card data in logs is FAIL (also see payments and legal). |

## Session and identity extras (feature-dependent)

Apply when the product has accounts. Else NOT APPLICABLE with evidence the feature does not exist.

| ID | Check | Maps to | Evidence expected |
|---|---|---|---|
| S12 | Plus-sign and other RFC 5322 `atext` characters in email local-parts | 17 | Signup and login with a `+` in the local-part succeed, or the rejection is documented as intentional with a product reason. Independent check: RFC 5322 §3.2.3 lists `+` in `atext` (fetched `https://www.rfc-editor.org/rfc/rfc5322`). |
| S13 | Password-reset links expire and work once | 17 | Test: first use succeeds; reuse and an expired token fail. |
| S14 | Session timeout and a way to revoke all sessions for one user | 4, 17 | Config or code plus a test that an old session is rejected after timeout or revoke. |
| S15 | MFA and recovery | 4, 17 | If MFA is claimed or required by the project: enroll, challenge, and a recovery path tested. If not in scope, NOT APPLICABLE with evidence, not because it was skipped. |
| S16 | Cross-user IDOR | 4, 5 | Changing an id in a URL, API path, or body does not return another user's data (negative test). |
| S17 | Tenant isolation | 5 | Negative test across tenants when multi-tenant. |
| S18 | Support "log in as user" | 4 | If present: audit trail of every use. If absent: NOT APPLICABLE. |
| S19 | SSO / SAML / SCIM | 4 | Enterprise-dependent. Required only when the project or a named customer contract says so. Otherwise remaining risk, not a universal FAIL. |

SSO, SAML, SCIM, pentest-before-every-launch, and questionnaire packs are not universal. Record them as remaining owner actions unless the project requires them.
