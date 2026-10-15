# Legal items

**Needs a qualified lawyer, not a checklist pass.** This skill does not give legal advice, does not invent compliance, and cannot mark the items below PASS.

Core check 15 already requires privacy policy and terms that match the product, and BLOCKED until required legal review has happened. This module lists extra candidate risks. Sources are untrusted X posts (`2107478486227071360`, `2110705357492203564`, `2101154043720876226`) plus the core gate. Penalty amounts, court outcomes, and "per visitor" figures in those posts were **not independently verified against statute or case law** in this task; treat them as UNKNOWN claims.

| ID | Topic | Maps to | What this gate may do | What it must not do |
|---|---|---|---|---|
| L1 | Privacy policy and terms vs actual data flows, providers, retention, payments, and choices | 15 | Compare the documents to the code and named processors. FAIL if the docs omit a processor the code calls, or claim a choice the product does not implement. | Declare the documents legally sufficient. |
| L2 | Age / COPPA / child-directed collection | 15, 17 | Record whether signup collects age or the product is clearly not for children, with evidence. | Assert COPPA compliance or cite unverified penalty figures as fact. |
| L3 | Marketing email (unsubscribe, sender identity) | 18, 15 | If marketing email exists: unsubscribe path tested in a test inbox; record whether a postal address is present. Transactional mail is check 18. | Assert CAN-SPAM or equivalent compliance. |
| L4 | Auto-renewal disclosure next to the subscribe control | 17, 15 | If subscriptions: screenshot of the checkout control and adjacent renewal terms, or FAIL if missing. | Assert a jurisdiction's renewal law is satisfied. |
| L5 | Session replay / keystroke capture | 16, 15 | If replay is on: consent and input masking evidence, or FAIL if replay captures secrets without that. | Assert CIPA or wiretap law is satisfied. |
| L6 | Fonts and other third-party requests that send visitor IPs | 15, 16 | Inventory of third-party origins on launch pages. Self-hosting is a product choice, not a legal PASS. | Assert GDPR damages or a named judgment. |
| L7 | DMCA agent / UGC safe harbor | 15 | If users upload others' content: record whether an agent is registered (owner action). | Assert safe harbor. |
| L8 | Cookie / tracking consent | 16, 15 | If analytics or non-essential cookies: record the banner and what loads before consent. | Assert ePrivacy/GDPR cookie-law compliance. |
| L9 | HIPAA, BAA, PCI, SOC 2, GDPR deletion, data residency | 15, 5, 10 | Feature- or contract-dependent. If in-scope: BLOCKED until the owner points to a lawyer or auditor artifact. PCI: card numbers in this app's database are FAIL (payments module). | Treat SOC 2, HIPAA, PCI, or GDPR as a checkbox this gate can PASS. |

## Status rule (mandatory)

For L2-L9, allowed statuses are:

- **BLOCKED** — required legal review has not happened (default when the topic applies).
- **UNKNOWN** — it is not established whether the topic applies, or social-media legal claims remain unverified.
- **NOT APPLICABLE** — project-specific evidence the risk does not exist (no children, no marketing email, no UGC, no PHI, and so on).
- **FAIL** — only for a factual product defect this gate can see (docs contradict code; PAN stored; no unsubscribe on marketing mail).
- **PASS** — not allowed for "we are legally compliant." The nearest PASS is L1's document-vs-code consistency, which is still not a legal opinion.

Record the lawyer or firm, date, and document identifier when review exists. Owner "we will deal with it later" keeps the check BLOCKED.
