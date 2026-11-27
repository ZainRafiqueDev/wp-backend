# ADR 0001 — Subsystem architecture review

Status: Accepted as the current engineering position  
Date: 2026-09-26  
Scope: billing, credits, RAG, document ingestion, model routing, session memory, multi-tenancy, Stripe, vector storage, caching

This is a challenge review of the running design. It is not permission to add features on top of weak foundations.

Interactive copy: open the Cursor canvas `chatmate360-adr-review.canvas.tsx`.

## Locked decisions

1. Stripe remains the processor; ChatMate360 remains the credit ledger. Never grant AI dollars equal to cash collected.
2. Customer-facing credits are monthly USD. Day/week limits, if kept, are infra burst control—not plan marketing.
3. Do not add Shopify, inbound email, or retrieval vendors until ingest is async/scanned and vectors are ANN-indexed with an evaluation set.
4. Shared Postgres + pgvector stays, only with HNSW (or equivalent), tenant filters, and chunk/byte caps.
5. Application ownership checks stay; Postgres RLS is the next isolation layer.

## Verdicts

| Subsystem | Verdict |
| --- | --- |
| Billing | Keep, change now |
| Credits | Keep, change now |
| Stripe | Keep, change now |
| Model routing | Keep, change now |
| Session memory | Keep, change now |
| Multi-tenancy | Keep, change now |
| Caching | Keep, change now |
| RAG | Wrong for scale |
| Document ingestion | Wrong for scale |
| Vector storage | Wrong for scale |

No subsystem is “keep unchanged.”

## Reviews

Each section answers: best today, alternatives, why, trade-offs, 10k-tenant failure, greenfield redesign, FAANG-principal change.

### Billing — Keep, change now

Webhook-driven Stripe plus a local entitlement row is the right skeleton, not a finished control plane. Plan codes, a lead form, and dashboard feature flags are not a billing architecture.

Alternatives: Stripe as SoR with a local projection; Chargebee; invoice-first enterprise; Stripe usage meters.

Keep Stripe for money movement. ChatMate360 must own granted credits and features, reconciled by idempotent events.

At 10k tenants: webhook storms, missing add-ons/tax, spreadsheet entitlements, one-account blast radius.

FAANG change: Billing Service, tax, dunning, immutable grant ledger. Remove UI booleans as production controls.

### Credits — Keep, change now

USD estimate → reserve → call → reconcile with Redis Lua and a Postgres hold ledger is the correct economic core. Daily/weekly product caps contradict monthly-only policy. Granting $10 AI for $10 cash was a margin bug; the $20 → $8 package is now encoded but can be overridden by env.

Alternatives: token quotas; arrears usage; Postgres-only SERIALIZABLE wallets; provider spend limits; soft overage.

USD is the only honest multi-provider currency. Reservation-before-call is mandatory under concurrency.

At 10k: hot Redis, reservation table growth, price-catalog misses, herd fallback spend.

FAANG change: Credit Ledger service, versioned price catalog, page on estimated-vs-actual error, never fail-open unknown models to $0.

### RAG — Wrong for scale

Current path: rewrite → embed → cosine top-5 with a distance cutoff → prompt → lightweight grounding. That is a demo with rails, not retrieval.

Alternatives: hybrid lexical+vector+metadata then rerank; ColBERT; hosted search; BM25 for crawl, vectors for files.

Exact IDs, SKUs, and clause numbers lose to pure vectors. Crawled pages already use keyword ranking; documents do not.

At 10k: unindexed or poorly filtered scans, noisy-neighbor corpora, silent recall collapse.

FAANG change: evaluation gate, separate crawl vs document indexes, per-tenant embedding query budgets.

### Document ingestion — Wrong for scale

Parse, chunk, embed, and insert still run in the upload HTTP request. Memory multer, no malware scan, no object store, no OCR, no replay.

Alternatives: S3 + queue + virus scan; layout-aware parse vendors; OCR only below a text threshold; reject scans until OCR exists.

Async is required so API workers do not embed. Object storage is required to reprocess after chunker/model changes.

At 10k: worker OOM, unbounded embedding spend, one tenant blocking ingest, unreprocessable failures.

FAANG change: untrusted-file pipeline on isolated workers; cap bytes/pages/chunks; bill embedding to the tenant.

### Model routing — Keep, change now

Preferred model, static priority, allow-list, quota, per-attempt authorize, and conversation pin are correct money/UX rules. Missing: health, latency, cost-aware auto, circuit breakers. Non-BLOCK limit actions are UI fiction. Gemini cannot tool-call.

Alternatives: cheapest-only; BYO keys; scored router; split answer vs tool model; hosted gateway.

Keep in-process keys to preserve margin. Re-authorize every fallback.

At 10k: thundering-herd fallback turns one provider outage into a platform outage and a bill spike.

FAANG change: provider gateway, per-provider concurrency, implement or delete ROUTE_TO_CHEAPER_MODEL.

### Session memory — Keep, change now

`(chatbot_id, session_id)` plus last-K and a compacting blob is a valid widget design. localStorage UUID, 20-turn compact, 6-turn window, 1,500-character user-question fold is not a memory product.

Alternatives: stateless last-N; LLM summaries; fact store; server TTL sessions; login-gated memory.

Do not send full history. Do not invent cross-device memory without identity.

At 10k: unbounded `messages`, compact-on-hot-path, no retention policy (the UUID is tracking).

FAANG change: privacy/retention/export; move compact to a worker; charge summary tokens to the $8 budget.

### Multi-tenancy — Keep, change now

Shared schema with `requireOwnedChatbotId` is acceptable only with relentless negative tests. No RLS, no universal `tenant_id`, no storage/crawl/Redis quotas.

Alternatives: RLS; schema-per-tenant; DB-per-enterprise; cells.

Schema-per-tenant at 10k is an ops trap. RLS is the next cheap guarantee.

At 10k: noisy neighbor; one forgotten `chatbot_id` predicate is a privacy P0.

FAANG change: assume app-layer breach; RLS + scoped IAM + enterprise KMS + red-team widget paths.

### Stripe — Keep, change now

Correct processor. Checkout, portal, signed webhooks, subscription sync, server-side price IDs: keep. Stripe cannot encode “collect $20, grant $8.”

Alternatives: Paddle/Lemon Squeezy (MoR/tax); Adyen; Stripe meters later.

At 10k: tax, disputes, live/test mix-ups, no PO/net-30 path for enterprise.

FAANG change: Stripe Tax, webhook inbox, reconcile grants to Balance Transactions; alert if grant ≥ amount collected.

### Vector storage — Wrong for scale

pgvector in primary Postgres is a valid 12-month choice. Current schema: `vector(1536)` with btree on `chatbot_id` / `document_id` and **no HNSW/IVFFlat**. Distance search will scan.

Alternatives: pgvector+HNSW partitioned; Qdrant/Weaviate; Pinecone; OpenSearch k-NN.

Do not add a second vector vendor until a proper index still misses the chat SLO.

At 10k: tens of millions of chunks on sequential scans will dominate Postgres.

FAANG change: no production RAG without `EXPLAIN ANALYZE` on a representative corpus; store embedding model+dim; enforce chunk caps in the database.

### Caching — Keep, change now

Versioned Redis invalidation and fail-open reads are sound. Answer caching by normalized question is dangerous with follow-ups, tools, and live data. Cache, queues, and credit holds share one Redis.

Alternatives: no cache; CDN for static only; single-flight; split Redis roles.

Cache is how the $8 budget survives repeated FAQs. A cross-tenant cache hit is Sev-1.

At 10k: hot keys, stampede on version bump, BullMQ vs cache contention.

FAANG change: mandatory tenant+chatbot key prefix; single-flight; never cache tool/live/PII answers; separate Redis for holds vs cache vs queues.

## What a FAANG principal would do next

Stop feature work. Spend one cycle on: ledger invariants, HNSW + hybrid retrieval, async scanned ingest, provider circuit breakers, and tenancy/RLS tests. More product surface on this foundation increases blast radius, not readiness.
