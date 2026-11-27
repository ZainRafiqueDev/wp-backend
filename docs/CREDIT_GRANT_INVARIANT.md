# Credit grant invariant

Status: enforced in production code  
Work package: WP-1.1

## Invariant

Granted AI credits must be strictly less than cash collected (or the configured sale price when cash is represented by a catalog price).

```
granted_usd < amount_total_usd
```

Stripe moves money. ChatMate360 owns the credit ledger. A customer who pays `$X` must never receive `$X` or more of AI budget.

## Rationale

Granting AI dollars 1:1 with cash collected loses money after Stripe fees, platform overhead, and target profit. The Crawl Plus default package encodes that as a 40% AI budget. The invariant is the hard gate; the 40% ratio is the default grant size, not a second undocumented rule.

## Configuration

Do not change prices in code. Set:

| Variable | Meaning |
| --- | --- |
| `TOPUP_SALE_USD` | Configured top-up list price |
| `TOPUP_CREDIT_USD` | AI dollars granted after a successful top-up. Must be `< TOPUP_SALE_USD` |
| `CRAWL_PLUS_SALE_USD` | Configured Crawl Plus list price |
| `CRAWL_PLUS_PLAN_MONTHLY_COST_CAP_USD` | Monthly AI grant. Must be `< CRAWL_PLUS_SALE_USD` |
| `FULL_CUSTOM_SALE_USD` | Optional. When set and `> 0`, monthly Full Custom grant must stay below it |
| `FULL_CUSTOM_PLAN_MONTHLY_COST_CAP_USD` | Monthly Full Custom grant |

Defaults come from `src/lib/planEconomics.ts` (`DEFAULT_TOPUP_SALE_USD`, `CRAWL_PLUS_20`). Changing a Stripe Price without changing the matching `*_SALE_USD` will fail closed at grant time when Stripe `amount_total` or `unit_amount` no longer exceeds the grant.

## Failure modes

| Condition | Behaviour |
| --- | --- |
| Grant ≥ configured sale at process start | Process stays up. Checkout, top-up, auto-purchase, and credit writes return 503. `/health` is `status: "degraded"` with `billing.creditGrants: "disabled"` |
| Grant ≥ Stripe `amount_total` | Credit is not written. Webhook returns 500 so Stripe retries after config is fixed |
| Missing / unpaid `payment_status` | No credit, webhook 200 (retrying will not make it paid) |
| Non-USD currency | Credit is not written. Webhook 500 |
| Missing subscription `unit_amount` on entitled paid update | Entitlement is not written. Webhook 500 |
| Duplicate / concurrent webhook | `chatbot_model_credits.stripe_checkout_session_id` is unique; second write is a no-op |
| Admin monthly override without attested cash | 400. Monthly grant must be `< cashCollectedUsd` |
| Redis down | Does not affect this ledger write (Postgres). Chat reservations may fail separately |
| Stripe timeout on Checkout create | No session, no grant |
| `invoice.payment_failed` | Plan marked `past_due`; no grant |

`/health` stays HTTP 200 when degraded so the load balancer does not take the instance out of rotation. Alert on `status=degraded` or `billing.creditGrants=disabled`.

## Operational procedure

1. Set sale and grant env vars so every grant is below its sale price.
2. Deploy. Confirm `/health` shows `status: "ok"` and `billing.creditGrants: "enabled"`.
3. Run one test-mode top-up. `chatbot_model_credits.credited_usd` must equal `TOPUP_CREDIT_USD` and be less than Stripe `amount_total / 100`.
4. Confirm logs include `amount_total`, `granted_usd`, `billing.grant_usd`, and `billing.amount_total_usd`.
5. Alert if `granted_usd >= amount_total`.

If grants are disabled after deploy, existing chat and entitlements keep working. Fix env and restart; Stripe will retry failed grant webhooks.

## Rollback

1. Restore previous `TOPUP_CREDIT_USD` / `CRAWL_PLUS_PLAN_MONTHLY_COST_CAP_USD` / `*_SALE_USD` values that still satisfy grant `<` sale.
2. Restart API processes.
3. No database migration to undo.

A grant that is still `<` its configured sale remains backward compatible. Setting grant `≥` sale disables new grants; it does not take the API down.
