# Payments and Stripe

Feature-dependent. NOT APPLICABLE only with evidence the product does not take payment. Candidate items from untrusted X post `2096889326248288301` and `2110705357492203564`. Confirm against Stripe docs and the project's processor, not the posts.

Use sandbox / test mode. Never charge a real customer as a test (core 17).

| ID | Check | Maps to | Evidence expected |
|---|---|---|---|
| P1 | Webhook signatures verified | 4, 17 | Handler verifies `Stripe-Signature` (or the processor equivalent) with the endpoint secret; invalid signatures are rejected. Stripe: verify events are sent from Stripe, using the raw request body (`https://docs.stripe.com/webhooks/signatures`). |
| P2 | Idempotency on charge, refund, and subscription-change requests | 17 | Idempotency keys sent and a retried request does not double-charge. Stripe: `Idempotency-Key` on POST create/update (`https://docs.stripe.com/api/idempotent_requests`). |
| P3 | Failed payments, dunning, expired cards | 17 | Test-mode failed charge and (if subscriptions exist) retry / customer-visible state. |
| P4 | Refunds, credits, partial refunds | 17 | Test-mode refund path and resulting access/entitlement state. |
| P5 | Upgrades, downgrades, proration, cancel | 17 | If subscriptions exist: each path in test mode, with server-side entitlement gating (not only UI). |
| P6 | Subscription status synced server-side | 4, 17 | Database or equivalent matches a test-clock or webhook-driven status change. A client-only flag is FAIL. |
| P7 | Billing portal or equivalent customer self-serve | 17 | If Stripe Billing: customer can open the portal in test mode. If another processor: the equivalent path, or NOT APPLICABLE with reason. |
| P8 | Receipts | 18 | Test receipt or invoice email to an authorized inbox, or in-app receipt with the same facts. |
| P9 | Payment events logged without PAN/CVC | 8, 17 | Event ids and types logged; card numbers absent (log sample). |
| P10 | Tax / VAT / currency | 17, 15 | If the product sells: tax collection setting or an explicit owner decision that tax is out of scope for this launch, recorded. Multi-currency only if offered. Money in major-currency integers or a decimal type that is not binary floating point. Independent check: IEEE-754 `0.1 + 0.2 === 0.3` is false (local eval). |
| P11 | Duplicate submit / double click | 17 | Two rapid checkouts produce one charge (idempotency or equivalent). |

Live-mode keys, live webhooks, and real charges stay UNKNOWN or BLOCKED without an owner-authorized live readback. Test-mode PASS is not live proof.

Card numbers in the application's database are a PCI-scope incident: FAIL, and see `legal.md`. Prefer the processor's hosted fields or equivalent so PAN never touches this app.
