# Embedding model, dimension, and query budget (WP-2.4)

Every stored vector records `embedding_model` and `embedding_dim`. Query-time cosine search only compares vectors that match the **active** identity. Tenants cannot unbounded-embed via chat or upload: each embedding call is priced and reserved against a daily USD ledger.

```
chat / upload / catalog sync
        │
        ▼
 resolve model + dim + price   ← missing price fails closed
        │
        ▼
 reserve daily USD (Postgres)  ← over budget rejected
        │
        ▼
 OpenAI embeddings
        │
        ▼
 store vector + model + dim
```

Rollback: `EMBEDDING_BUDGET_ENABLED=false` (not recommended). Model/dim writes continue.

## Configuration

| Env | Default | Role |
| --- | --- | --- |
| `EMBEDDING_MODEL` / `PRODUCT_EMBEDDING_MODEL` | `text-embedding-3-small` | Active embedding model. |
| `EMBEDDING_DIM` | `1536` | Must match the `vector(1536)` column. |
| `EMBEDDING_BUDGET_ENABLED` | `true` | `false` disables the daily ledger. |
| `EMBEDDING_DAILY_BUDGET_USD` | `$8 / 30` from Crawl Plus economics | Per-account daily embed spend cap. |
| `EMBEDDING_PRICING_OVERRIDES_JSON` | empty | `{"text-embedding-3-small":0.02}` |
| `EMBEDDING_REEMBED_ON_SWEEP` | `false` | Gradual cutover on the ingest sweep. |

## Daily budget

- Tenant key is the chatbot **owner** (`users.id`), so multiple chatbots on one account share the $8-derived cap.
- Authority is `embedding_usage_daily` (atomic update). Redis only holds `embed.calls`, `embed.blocked_budget`, and `embed.cost_usd`.
- A failed provider call refunds the reservation.
- Upload / catalog sync: over-budget throws `429` and the document/sync fails.
- Chat / product lookup: over-budget skips the vector leg. Hybrid lexical (WP-2.3) still runs. Product lookup falls back to keyword match when the vector leg is empty or skipped (covers rows not yet cut over).

## Changing embedding models (no outage)

1. **Versioned rows** — new writes store the new `embedding_model` / `embedding_dim`.
2. **Coexistence** — vector SQL is `embedding_model = $active AND embedding_dim = $active`. Old generations stay in the table and are not mixed into cosine compare.
3. **Gradual cutover** — set the new `EMBEDDING_MODEL` (same 1536-dim family), deploy, then either:
   - leave lexical/hybrid covering old chunks until they are re-uploaded, or
   - set `EMBEDDING_REEMBED_ON_SWEEP=true` so the ingest sweep rewrites mismatched rows in small budgeted batches.
4. **Dimension change** — the stored column is `vector(1536)`. A 3072-dim model fails closed until a later schema WP changes the column. Do not truncate.

## Monitoring

- `embed.calls` (includes `costUsd`, `tokens`, `model`)
- `embed.blocked_budget`
- Redis `metric:embed.cost_usd:YYYY-MM-DD`

## Production checklist

1. Apply `db/migrations/20260927_embedding_model_budget.sql`.
2. Confirm `EMBEDDING_DAILY_BUDGET_USD` from the $8 Crawl Plus AI cap (`monthly / 30` unless overridden).
3. Confirm the active model has a price (or set `EMBEDDING_PRICING_OVERRIDES_JSON`).
4. Deploy API and worker together.
5. Leave `EMBEDDING_BUDGET_ENABLED=true`.
