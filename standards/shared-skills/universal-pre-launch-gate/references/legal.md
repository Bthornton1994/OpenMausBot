# Legal items

**Needs a qualified lawyer, not a checklist pass.** This skill does not give legal advice, does not invent compliance, and never certifies legal compliance. A PASS on L1 is factual document-vs-code consistency only; it does not clear core check 15. Core check 15 stays **BLOCKED** until a qualified lawyer (or an owner-cited legal review artifact) has done it; that still is not a legal-compliance certification. A PASS on L2-L9 means an owner- or lawyer-supplied artifact is recorded as evidence; it is not a legal opinion.

Core check 15 already requires privacy policy and terms that match the product, and stays BLOCKED until required legal review has happened. This module lists extra candidate risks. Sources are untrusted X posts (`2107478486227071360`, `2110705357492203564`, `2101154043720876226`) plus the core gate. Penalty amounts, court outcomes, and "per visitor" figures in those posts were **not independently verified against statute or case law** in this task; treat them as UNKNOWN claims.

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

Existing statuses only. None of them is a legal-compliance certification.

- **L1 PASS** — documents match the code and named processors (factual consistency). Still not a legal opinion. L1 PASS does not change core check 15; 15 stays BLOCKED until the legal-review artifact exists.
- **L2-L9** when the topic applies: stay **BLOCKED** or **UNKNOWN** and route to the owner until an owner- or lawyer-supplied artifact is recorded as evidence (lawyer or firm, date, document identifier). With that artifact, **PASS** means "artifact recorded," not "we are legally compliant." Without it, they cannot leave BLOCKED/UNKNOWN except as **FAIL** (a factual product defect this gate can see: docs contradict code; PAN stored; no unsubscribe on marketing mail) or **NOT APPLICABLE** (project-specific evidence the risk does not exist).
- **UNKNOWN** — it is not established whether the topic applies, or social-media legal claims remain unverified.
- Owner "we will deal with it later" keeps the check BLOCKED.
