# Crawl Plus $20 economics

Authoritative package for the self-service Crawl Plus plan.

| Line | Amount |
| --- | ---: |
| Revenue | $20.00 |
| Stripe fee | -$1.10 |
| Platform overhead | -$0.50 |
| Available after fees | $18.40 |
| Target profit | $10.40 |
| Maximum safe AI credits | **$8.00** |

Implemented in `src/lib/planEconomics.ts` as `CRAWL_PLUS_20`.

## Rules

- The account's monthly AI allowance must not exceed $8.
- A customer who pays $20 does **not** receive $20 of model usage.
- A $10 top-up grants $4 of AI credit (same 40% AI-budget ratio), unless `TOPUP_CREDIT_USD` is set lower.
- Custom-plan packages should use `computeSaleEconomics()` the same way: choose sale price, fees, overhead, and target profit, then grant only `maximumSafeCreditsUsd`.
- `assertGrantLessThanCash` is the ledger invariant: granted AI dollars must be strictly less than configured sale / Stripe cash. See `docs/CREDIT_GRANT_INVARIANT.md`.
- Sale prices are configured (`TOPUP_SALE_USD`, `CRAWL_PLUS_SALE_USD`), not hardcoded in the grant path.
- If grant ≥ configured sale, the process stays up and only billing grants are disabled (`/health` → `degraded`).
