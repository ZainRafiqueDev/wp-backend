# ChatMate360 implementation blueprint

Status: Ready for implementation planning  
Source of truth: `docs/adr/0001-subsystem-architecture-review.md`  
Date: 2026-09-26

This document converts every approved ADR recommendation into an independently reviewable work package. It does not change architecture and does not authorize code in this pass.

Locked ADR decisions remain in force:

1. Stripe takes cash. ChatMate360 grants AI credits. Never grant AI dollars ≥ cash collected.
2. Customer-facing credits are monthly USD. Day/week numbers are infra burst control.
3. No Shopify, inbound email, or new retrieval vendors until async scanned ingest, ANN indexes, and an evaluation set exist.
4. Stay on shared Postgres + pgvector, with HNSW, tenant filters, and chunk/byte caps.
5. Keep application ownership checks. Add Postgres RLS next.

Out of scope until Phase 4 is done: Shopify, inbound email support, Chargebee, database-per-tenant, hosted vector vendors.

---

# Phase map

| Phase | Theme | Deployable alone? |
| --- | --- | --- |
| 1 | Money, indexes, safety rails | Yes |
| 2 | Ingest, hybrid retrieval, custom activation | Yes, after Phase 1 indexes/caps |
| 3 | Isolation, routing, catalog, memory ops | Yes, after Phase 1 ledger invariants |
| 4 | Quality, tax, privacy, scale extras | Yes, after Phase 2 retrieval/ingest |

Each phase can ship, run, and roll back without waiting for the next phase.

---

# Work packages

## WP-1.1 Ledger invariant: grant < cash

1. Priority: Critical  
2. Effort: Small  
3. Dependencies: `CRAWL_PLUS_20` in `src/lib/planEconomics.ts`; Stripe webhook already credits top-ups.  
4. Files: `src/lib/planEconomics.ts`, `src/services/topup.service.ts`, `src/services/billing.service.ts`, `src/env.ts`, `tests/unit/planEconomics.test.ts`, new `tests/unit/creditGrantInvariant.test.ts`.  
5. Migrations: none.  
6. APIs: `POST /billing/chatbots/:id/topup`, `POST /webhooks/stripe` (behavior only).  
7. Workers: none.  
8. Infra: set AWS `TOPUP_CREDIT_USD=4` and `CRAWL_PLUS_PLAN_MONTHLY_COST_CAP_USD=8`.  
9. Tests: unit for grant < amount_total; webhook fixture where $10 Checkout cannot credit $10; reject env that sets grant ≥ sale.  
10. Acceptance: a $10 top-up credits $4; a $20 subscription grants ≤ $8 monthly AI; logs/metrics include `amount_total` and `granted_usd`; startup warn if env violates invariant.  
11. Rollback: revert env to previous values; code remains backward compatible if `TOPUP_CREDIT_USD` is set.  
12. Risks: Stripe Price still looks like $10 credit to customers; copy must match.  
13. Monitoring: `billing.grant_usd`, `billing.amount_total_usd`, alert `grant_usd >= amount_total`.  
14. Production checklist: AWS env updated; Stripe top-up Price is $10 one-time; dashboard copy says $4 credit; one live test-mode top-up verified in `chatbot_model_credits`.  
15. Order: (1) add `assertGrantLessThanCash`, (2) call it from `creditTopup` and subscription activation, (3) fail closed on violation, (4) deploy env, (5) test-mode purchase.

## WP-1.2 Monthly customer credits; day/week as burst

1. Priority: Critical  
2. Effort: Medium  
3. Dependencies: WP-1.1.  
4. Files: `src/lib/plans.ts`, `src/services/usage.service.ts`, `src/env.ts`, `.env.example`, `src/services/accessGate.service.ts`, `components/dashboard/usage-panel.tsx`, `lib/data.ts`.  
5. Migrations: optional comment/check constraint later; none required to ship.  
6. APIs: `GET /chatbots/:id/usage` (labels), answering gate copy.  
7. Workers: none.  
8. Infra: env rename or document `*_DAILY/WEEKLY` as burst, not marketed credits.  
9. Tests: usage window tests prove monthly exhaustion returns upgrade/top-up; burst 429/503 does not say “credits empty.”  
10. Acceptance: customer-facing “credits” = monthly USD only; day/week can still shed load; pricing/usage UI does not sell daily credits.  
11. Rollback: restore previous UI labels; keep numeric caps.  
12. Risks: product/sales still describe daily caps; support confusion.  
13. Monitoring: `usage.monthly_blocked`, `usage.burst_blocked` as separate reasons.  
14. Production checklist: copy review; usage panel screenshot; confirm gateReason strings.  
15. Order: (1) split gate reasons, (2) update UI, (3) keep enforcement, (4) deploy frontend+backend together for copy.

## WP-1.3 Stripe webhook inbox

1. Priority: Critical  
2. Effort: Medium  
3. Dependencies: existing `processStripeWebhookEvent`.  
4. Files: `src/controllers/billing.controller.ts`, `src/services/billing.service.ts`, `src/worker.ts`, `src/lib/queue.ts`, new `src/services/stripeWebhookInbox.service.ts`.  
5. Migrations: `stripe_webhook_events (id pk stripe_event_id unique, type, payload jsonb, received_at, processed_at, attempts, last_error)`.  
6. APIs: `POST /webhooks/stripe` returns 200 after persist+verify; processing may be sync first, async later.  
7. Workers: optional `stripe-webhook` job if moved off request; Phase 1 may process inline after insert.  
8. Infra: none beyond DB migration.  
9. Tests: duplicate delivery inserts once; bad signature never inserts as processed; replay after crash completes grant once.  
10. Acceptance: Stripe retries do not double-credit; unprocessed events are queryable; at-least-once, exactly-once grant via existing checkout session unique key.  
11. Rollback: keep table; process inline only; drop consumer job.  
12. Risks: 200-before-process can delay entitlement if worker down—Phase 1 should process inline after insert.  
13. Monitoring: `stripe.inbox_unprocessed`, `stripe.inbox_age_seconds`, alert > 5 minutes.  
14. Production checklist: migrate; deploy API; send Stripe test event; confirm row + subscription/credit.  
15. Order: (1) migration, (2) persist then process, (3) unique event id, (4) admin/SQL visibility, (5) defer async worker to Phase 3 if needed.  
Phase 1 intentionally uses verify → persist → process → 200. Phase 3 cutover criteria and retention/replay config are in `docs/STRIPE_WEBHOOK_INBOX.md`.

## WP-1.4 pgvector HNSW index

1. Priority: Critical  
2. Effort: Medium  
3. Dependencies: ADR vector decision; existing `vector(1536)` columns.  
4. Files: `db/schema.sql`, new migration SQL, `src/services/documentIngestion.service.ts` (query must stay `chatbot_id` filtered).  
5. Migrations: `CREATE INDEX CONCURRENTLY ... USING hnsw (embedding vector_cosine_ops)` on `chatbot_document_chunks` and `product_catalog_cache` if queried by distance. Set `maintenance_work_mem` during build.  
6. APIs: none user-facing.  
7. Workers: none.  
8. Infra: enough RAM for HNSW; take a snapshot before build; run `EXPLAIN ANALYZE` on a copy of prod-sized data.  
9. Tests: integration lookup still tenant-scoped; explain plan uses index (staging).  
10. Acceptance: representative query does not sequential-scan embeddings; p95 document lookup measured and recorded.  
11. Rollback: `DROP INDEX CONCURRENTLY`; queries still work, slower.  
12. Risks: index build locks/IO; wrong ops class; filter+HNSW recall drop.  
13. Monitoring: `pg_stat_statements` for `<=>` queries; document lookup latency histogram.  
14. Production checklist: snapshot; CONCURRENTLY; `EXPLAIN ANALYZE`; compare recall on 50 questions.  
15. Order: (1) staging build, (2) explain, (3) prod snapshot, (4) concurrent index, (5) watch IO.  
Queries stay `chatbot_id` filtered. Build/rollback/recall notes: `docs/PGVECTOR_HNSW.md`.

## WP-1.5 Database chunk/byte/page caps

1. Priority: Critical  
2. Effort: Small  
3. Dependencies: current 25 docs / 15MB app checks.  
4. Files: `src/services/documentIngestion.service.ts`, `src/env.ts`, `db/schema.sql`.  
5. Migrations: columns or settings table: `max_documents`, `max_bytes`, `max_chunks` per chatbot or plan default; check before insert.  
6. APIs: `POST /chatbots/:id/documents` returns 409 with which cap.  
7. Workers: none.  
8. Infra: none.  
9. Tests: 26th doc rejected; oversize bytes rejected; chunk explosion rejected.  
10. Acceptance: caps enforced in DB-backed counts, not only multer; Crawl Plus defaults 25 docs / 15MB / documented chunk max.  
11. Rollback: raise env caps; keep columns.  
12. Risks: existing over-cap tenants fail new uploads—grandfather or one-time raise.  
13. Monitoring: `ingest.rejected_cap` by reason.  
14. Production checklist: count current max docs/bytes; set defaults; announce.  
15. Order: (1) measure prod, (2) add counters, (3) enforce, (4) deploy.

## WP-1.6 Cache tenant prefix and no live/tool answer cache

1. Priority: High  
2. Effort: Small  
3. Dependencies: `src/lib/cache.ts`, `answerChatbotQuestion.ts` action-cache skip.  
4. Files: `src/lib/cache.ts`, `src/lib/answerChatbotQuestion.ts`, `tests/unit/answerChatbotQuestionCaching.test.ts`.  
5. Migrations: none.  
6. APIs: public/authenticated chat (cache behavior).  
7. Workers: none.  
8. Infra: optional Redis flush after deploy if old keys lack prefix.  
9. Tests: keys include tenant/chatbot; tool-relevant questions never read/write answer cache.  
10. Acceptance: no cache key exists without `chatbotId`; live/action answers uncached.  
11. Rollback: revert key format; bump all cache versions.  
12. Risks: brief miss storm after prefix change (cost, not correctness).  
13. Monitoring: `cache.answer_hit`, `cache.answer_bypass_tools`.  
14. Production checklist: deploy; watch miss rate; do not flush unless prefix collision.  
15. Order: (1) helper `cacheKey(chatbotId, kind, hash)`, (2) migrate call sites, (3) tests, (4) deploy.

## WP-1.7 Cross-tenant negative test pack

1. Priority: High  
2. Effort: Medium  
3. Dependencies: existing `tests/integration/security.integration.test.ts`.  
4. Files: new/extended security integration tests for documents, chunks SQL, actions, usage, conversations, webhooks.  
5. Migrations: none.  
6. APIs: covered by tests only.  
7. Workers: none.  
8. Infra: CI must have test DB.  
9. Tests: every new table/endpoint has a “other tenant 404” case.  
10. Acceptance: CI fails if a new chatbot-scoped route lacks a cross-tenant test (checklist in PR template).  
11. Rollback: n/a (tests only).  
12. Risks: signup helper 500s in some local envs (email/fetch)—isolate that flake.  
13. Monitoring: CI gate.  
14. Production checklist: none; merge to main.  
15. Order: (1) inventory routes, (2) add missing cases, (3) PR template item.

## WP-1.8 Remove dashboard checkout kill-switch as control plane

1. Priority: High  
2. Effort: Small  
3. Dependencies: Stripe webhook inbox (WP-1.3) preferred first.  
4. Files: `components/dashboard/billing-panel.tsx` (`UPGRADE_CHECKOUT_ENABLED`).  
5. Migrations: none.  
6. APIs: `POST /billing/checkout` already exists.  
7. Workers: none.  
8. Infra: none.  
9. Tests: frontend not required if backend checkout integration tests pass.  
10. Acceptance: production checkout is enabled by backend Stripe config, not a frontend boolean.  
11. Rollback: revert the flag to false.  
12. Risks: enabling before Stripe webhook is live creates paid-but-not-activated users.  
13. Monitoring: `billing.checkout_started`, `billing.checkout_activated`.  
14. Production checklist: WP-1.3 live; test-mode Crawl Plus end-to-end; then enable.  
15. Order: (1) verify webhook, (2) enable, (3) one real test purchase.

---

## WP-2.1 Async document ingestion

1. Priority: Critical  
2. Effort: Large  
3. Dependencies: WP-1.4, WP-1.5.  
4. Files: `src/services/documentIngestion.service.ts`, `src/middleware/uploadDocument.ts`, `src/worker.ts`, `src/lib/queue.ts`, new `src/lib/objectStorage.ts`.  
5. Migrations: `storage_key`, `page_count`, `bytes`, status already has processing/ready/failed.  
6. APIs: `POST /chatbots/:id/documents` returns 202 + document id; `GET` lists status.  
7. Workers: new `document-ingest` BullMQ processor.  
8. Infra: S3/MinIO bucket, IAM, encryption, worker concurrency 1–2.  
9. Tests: upload persists processing; worker marks ready; retry failed; API timeout does not lose the file.  
10. Acceptance: HTTP handler does not embed; dashboard polls status; reprocess possible from `storage_key`.  
11. Rollback: feature-flag sync path for files < N MB; keep bucket.  
12. Risks: dual-path complexity; stuck `processing`.  
13. Monitoring: `ingest.queue_depth`, `ingest.processing_age`, `ingest.failed`.  
14. Production checklist: bucket; IAM; worker on AWS; lifecycle on failed objects.  
15. Order: (1) storage helper, (2) enqueue, (3) worker steps, (4) flip API to 202, (5) remove sync embed.

## WP-2.2 Malware scan in ingest

1. Priority: High  
2. Effort: Medium  
3. Dependencies: WP-2.1.  
4. Files: new `src/services/malwareScan.service.ts`, worker ingest pipeline.  
5. Migrations: `scan_status`, `scan_vendor`, `scanned_at`.  
6. APIs: document list shows rejected-for-malware.  
7. Workers: scan step before parse.  
8. Infra: ClamAV sidecar or AWS-supported scanner; no execute-from-upload.  
9. Tests: eicar (or mocked vendor) → failed, never embedded.  
10. Acceptance: unclean files never reach chunk/embed.  
11. Rollback: fail closed (reject all) or pause uploads; do not skip scan in prod.  
12. Risks: false positives; vendor outage blocks all uploads.  
13. Monitoring: `ingest.scan_denied`, `ingest.scan_error`.  
14. Production checklist: vendor SLA; fail-closed runbook.  
15. Order: (1) mock scan in worker, (2) vendor, (3) fail closed, (4) deploy with WP-2.1 or immediately after.

## WP-2.3 Hybrid retrieval

1. Priority: High  
2. Effort: Large  
3. Dependencies: WP-1.4; no new vector vendor (ADR).  
4. Files: `src/services/documentIngestion.service.ts`, `src/lib/relevance.ts`, `src/lib/answerChatbotQuestion.ts`, `db/schema.sql`.  
5. Migrations: `tsvector` column + GIN on chunks; optional `heading`/`source_type` metadata.  
6. APIs: chat answering only.  
7. Workers: backfill tsvector on existing chunks.  
8. Infra: none.  
9. Tests: exact SKU/id query hits lexical; synonym query still hits vector; tenant filter on both.  
10. Acceptance: retrieve union/fuse of lexical + vector, still top-K, still `chatbot_id` scoped. Rerank is Phase 4.  
11. Rollback: env `RETRIEVAL_MODE=vector`.  
12. Risks: worse recall if fusion weights wrong.  
13. Monitoring: `retrieval.lexical_hits`, `retrieval.vector_hits`, `retrieval.empty`.  
14. Production checklist: backfill; shadow-compare 100 queries; then default on.  
15. Order: (1) column+GIN, (2) write tsvector on ingest, (3) fuse, (4) flag on.

## WP-2.4 Embedding model/dim + query budget

1. Priority: High  
2. Effort: Medium  
3. Dependencies: WP-1.5, embeddings service.  
4. Files: `src/services/embeddings.service.ts`, `src/env.ts`, document/product tables.  
5. Migrations: `embedding_model text`, `embedding_dim int` on chunk tables.  
6. APIs: none.  
7. Workers: none required unless re-embed job later.  
8. Infra: Redis/Postgres counter per tenant per day for embedding calls.  
9. Tests: missing model price fails closed; over-budget embed rejected.  
10. Acceptance: every stored vector records model+dim; tenant cannot unbounded-embed via chat or upload.  
11. Rollback: disable budget via env (not recommended).  
12. Risks: blocking chat if budget too tight.  
13. Monitoring: `embed.calls`, `embed.blocked_budget`, cost estimate.  
14. Production checklist: set daily embed cap from $8 economics.  
15. Order: (1) columns, (2) write on insert, (3) budget check, (4) deploy.

## WP-2.5 RAG evaluation set (gate)

1. Priority: Medium  
2. Effort: Medium  
3. Dependencies: WP-2.3 preferred.  
4. Files: new `evals/rag/*.json`, `tests/eval/ragEval.test.ts` or script.  
5. Migrations: none.  
6. APIs: none.  
7. Workers: none.  
8. Infra: CI job, no extra vendor.  
9. Tests: golden questions with expected source ids; fail on groundedness/recall thresholds.  
10. Acceptance: retrieval change cannot merge if eval fails.  
11. Rollback: skip job only with explicit CI override.  
12. Risks: small set overfits.  
13. Monitoring: eval score in CI artifacts.  
14. Production checklist: 50–100 labeled pairs before hybrid default-on.  
15. Order: (1) collect labels, (2) script, (3) CI required on retrieval PRs.

## WP-2.6 Full Custom activation API

1. Priority: High  
2. Effort: Medium  
3. Dependencies: WP-1.1, WP-1.3. Same ledger as Crawl Plus (ADR).  
4. Files: `src/services/admin.service.ts`, `src/validators/admin.validator.ts`, admin frontend user detail.  
5. Migrations: none if `subscriptions.plan` already supports `full_custom`; add `activated_by`, `activated_at` optional.  
6. APIs: `POST /admin/users/:id/activate-plan` `{ plan, monthlyCreditUsd, allowedModels }`.  
7. Workers: none.  
8. Infra: none.  
9. Tests: free→full_custom; cannot exceed computed safe credits without override reason; audit log.  
10. Acceptance: after meeting+payment, admin activation writes the same entitlement shape as Stripe Crawl Plus.  
11. Rollback: admin cancel/downgrade existing path.  
12. Risks: selling Custom Actions if policy is Crawl Plus only—activation must not silently grant actions unless product says so.  
13. Monitoring: `admin.plan_activated`.  
14. Production checklist: runbook for senior; audit; no self-serve Full Custom checkout.  
15. Order: (1) API+audit, (2) admin UI, (3) train senior, (4) deploy.

---

## WP-3.1 Postgres RLS

1. Priority: High  
2. Effort: Large  
3. Dependencies: WP-1.7; keep `requireOwnedChatbotId`.  
4. Files: `src/lib/db.ts`, new `src/lib/tenantContext.ts`, all services using `pool.query`, migration policies.  
5. Migrations: `tenant_id` where missing (or rely on `chatbot_id`/`user_id`); `ENABLE ROW LEVEL SECURITY`; policies `chatbot_id = current_setting('app.chatbot_id')::uuid` (or user_id).  
6. APIs: all authenticated and public chat paths must set context.  
7. Workers: crawl/ingest/commerce workers must set tenant context per job.  
8. Infra: none.  
9. Tests: query without context returns 0 rows; wrong tenant 0 rows even if SQL omits filter.  
10. Acceptance: application checks remain; RLS is defense in depth.  
11. Rollback: `DISABLE ROW LEVEL SECURITY` or `FORCE ROW LEVEL SECURITY` off on a hotfix.  
12. Risks: forgotten SET LOCAL on a new connection → empty data or, if bypass role, leak. Use a non-bypass role for API.  
13. Monitoring: error rate on 0-row anomalies; log missing tenant context.  
14. Production checklist: shadow policies in staging; then enable.  
15. Order: (1) SET LOCAL helper, (2) policies in staging, (3) worker coverage, (4) enable prod.

## WP-3.2 Provider circuit breakers

1. Priority: High  
2. Effort: Medium  
3. Dependencies: `src/lib/ai.ts` fallback loop.  
4. Files: `src/lib/ai.ts`, `src/services/modelSelection.service.ts`, new `src/lib/providerHealth.ts`.  
5. Migrations: none (Redis keys).  
6. APIs: chat.  
7. Workers: none.  
8. Infra: Redis.  
9. Tests: after N failures, provider skipped; cooldown; re-authorize next provider; no herd to one model.  
10. Acceptance: OpenAI outage does not instantly stampede Claude/Gemini unbounded.  
11. Rollback: env `PROVIDER_BREAKER=off`.  
12. Risks: false open from a few 429s.  
13. Monitoring: `provider.breaker_state`, `provider.fallback_rate`.  
14. Production checklist: tune thresholds on staging load.  
15. Order: (1) Redis counters, (2) skip open circuits, (3) metrics, (4) deploy.

## WP-3.3 Split Redis roles

1. Priority: Medium  
2. Effort: Medium  
3. Dependencies: `src/lib/redis.ts`, BullMQ, cache, reservations.  
4. Files: `src/lib/redis.ts`, `src/lib/queue.ts`, `src/lib/cache.ts`, `src/services/usage.service.ts`.  
5. Migrations: none.  
6. APIs: none.  
7. Workers: point BullMQ at queue Redis.  
8. Infra: 2–3 Redis instances or clusters (cache, queue, holds).  
9. Tests: unit with separate clients; chaos: cache Redis down does not drop reservations.  
10. Acceptance: cache outage increases AI spend, does not lose credit holds.  
11. Rollback: single URL for all three env vars.  
12. Risks: ops cost; misconfigured URL.  
13. Monitoring: per-instance memory, evictions, `maxclients`.  
14. Production checklist: provision; dual-write not required—cut by client.  
15. Order: (1) three env vars, (2) default to one URL, (3) split staging, (4) prod.

## WP-3.4 Versioned model price catalog

1. Priority: Medium  
2. Effort: Medium  
3. Dependencies: `src/lib/aiPricing.ts`, WP-1.1.  
4. Files: `src/lib/aiPricing.ts`, new table or JSON with effective dates.  
5. Migrations: `ai_model_prices (model, effective_from, input_per_m, output_per_m)`.  
6. APIs: none required; admin read later.  
7. Workers: none.  
8. Tests: unknown model reserve fails closed; date-effective rate used.  
9. Acceptance: no hardcoded-only rates; override still possible.  
10. Rollback: built-in DEFAULT_RATES fallback.  
11. Risks: stale catalog undercharges.  
12. Monitoring: `pricing.unknown_model` error; estimated vs actual.  
13. Production checklist: seed current OpenAI/Claude/Gemini rates.  
14. Order: (1) table, (2) loader, (3) fail closed, (4) deploy.

## WP-3.5 Conversation TTL and compact on worker

1. Priority: Medium  
2. Effort: Medium  
3. Dependencies: `src/services/conversation.service.ts`.  
4. Files: conversation service, `src/worker.ts`.  
5. Migrations: `expires_at` on `conversations`; retain `messages` via existing compact.  
6. APIs: public chat session behavior.  
7. Workers: `conversation-compact` and expiry sweep.  
8. Infra: none.  
9. Tests: idle session expires; compact not on request path; new session does not inherit (ADR).  
10. Acceptance: chat request only inserts turn; compact async; documented TTL (7–30 days).  
11. Rollback: disable sweep; keep data.  
12. Risks: GDPR deletion still needed separately (Phase 4).  
13. Monitoring: `conversation.compact_lag`, `conversation.expired`.  
14. Production checklist: choose TTL; disclose in privacy copy.  
15. Order: (1) enqueue compact, (2) TTL column, (3) sweep, (4) remove sync compact.

## WP-3.6 Implement or delete non-BLOCK limit actions

1. Priority: Medium  
2. Effort: Small  
3. Dependencies: WP-3.2 if implementing cheaper route.  
4. Files: `src/lib/plans.ts`, `components/admin/pages/entitlement-override-form.tsx`, usage service.  
5. Migrations: none.  
6. APIs: admin entitlement override.  
7. Workers: none.  
8. Infra: none.  
9. Tests: UI only offers implemented actions.  
10. Acceptance: `ROUTE_TO_CHEAPER_MODEL`, `USE_OVERAGE`, `ADMIN_OVERRIDE` are either real or removed from admin UI.  
11. Rollback: restore labels if needed.  
12. Risks: sales already promised overage.  
13. Monitoring: n/a if deleted.  
14. Production checklist: product sign-off.  
15. Order: (1) product decision, (2) delete or implement one action, (3) deploy.

---

## WP-4.1 Cross-encoder rerank

1. Priority: Medium  
2. Effort: Medium  
3. Dependencies: WP-2.3, WP-2.5. No new vector DB.  
4. Files: new `src/services/rerank.service.ts`, `answerChatbotQuestion.ts`.  
5. Migrations: none.  
6. APIs: chat.  
7. Workers: none.  
8. Infra: optional small rerank model host or API—cost must hit the $8 budget.  
9. Tests: eval nDCG improves; latency budget documented.  
10. Acceptance: retrieve 30–50, rerank to 5–8; eval gate green.  
11. Rollback: `RERANK=off`.  
12. Risks: latency and cost.  
13. Monitoring: `rerank.latency_ms`, `rerank.cost_usd`.  
14. Production checklist: eval + p95.  
15. Order: (1) candidate widen, (2) rerank, (3) eval, (4) flag on.

## WP-4.2 OCR path

1. Priority: Medium  
2. Effort: Large  
3. Dependencies: WP-2.1, WP-2.2.  
4. Files: ingest worker, new OCR adapter.  
5. Migrations: `ocr_used boolean`.  
6. APIs: document status.  
7. Workers: OCR step when extractable text below threshold.  
8. Infra: OCR vendor or Textract; bill to tenant embed/OCR budget.  
9. Tests: scanned PDF → OCR → ready; text PDF skips OCR.  
10. Acceptance: scans work; cost reserved; reject if OCR would blow cap.  
11. Rollback: reject scans (honest).  
12. Risks: margin on Crawl Plus $8.  
13. Monitoring: `ocr.pages`, `ocr.cost`.  
14. Production checklist: price a page; set cap.  
15. Order: (1) detect scan, (2) reserve cost, (3) OCR, (4) chunk.

## WP-4.3 Single-flight cache and metrics

1. Priority: Medium  
2. Effort: Small  
3. Dependencies: WP-1.6.  
4. Files: `src/lib/cache.ts`.  
5. Migrations: none.  
6. APIs: chat.  
7. Workers: none.  
8. Infra: Redis.  
9. Tests: 20 parallel identical questions = 1 provider call.  
10. Acceptance: stampede on version bump reduced; hit/miss/stale metrics exported.  
11. Rollback: disable single-flight env.  
12. Risks: stuck lock.  
13. Monitoring: `cache.singleflight_wait`, hit/miss.  
14. Production checklist: export to existing logs first.  
15. Order: (1) lock key, (2) metrics, (3) deploy.

## WP-4.4 Stripe Tax and balance reconciliation

1. Priority: Low  
2. Effort: Large  
3. Dependencies: WP-1.3.  
4. Files: billing service, Stripe Checkout create.  
5. Migrations: store tax fields on subscription/payment rows.  
6. APIs: checkout session.  
7. Workers: daily reconcile vs Balance Transactions.  
8. Infra: Stripe Tax enabled.  
9. Tests: tax-inclusive session fixtures; grant still < net or gross per finance rule.  
10. Acceptance: tax collected; finance export; grant invariant uses the agreed base.  
11. Rollback: disable automatic tax.  
12. Risks: price display vs $20 marketing.  
13. Monitoring: `stripe.tax_usd`, reconcile diffs.  
14. Production checklist: finance + legal.  
15. Order: (1) finance decision, (2) Stripe Tax, (3) reconcile job.

## WP-4.5 LLM summary, facts, privacy export

1. Priority: Low  
2. Effort: Large  
3. Dependencies: WP-3.5; summary tokens charged to monthly credits.  
4. Files: conversation service, new `customer_facts`, widget privacy.  
5. Migrations: `conversation_facts`, deletion/export tables.  
6. APIs: export/delete (GDPR); chat uses facts+summary.  
7. Workers: summary job (LLM).  
8. Infra: none.  
9. Tests: summary cost reserved; export completeness; delete cascade.  
10. Acceptance: no cross-session memory without OTP consent (ADR); idle TTL remains.  
11. Rollback: disable LLM summary; keep last-K.  
12. Risks: extra spend vs $8.  
13. Monitoring: `memory.summary_cost`.  
14. Production checklist: privacy policy update.  
15. Order: (1) charge summary, (2) facts extract, (3) export/delete, (4) consent for cross-session.

## WP-4.6 Partitioning / cells (only if needed)

1. Priority: Low  
2. Effort: Large  
3. Dependencies: evidence that one primary is the bottleneck after HNSW/RLS/split Redis.  
4. Files: schema, routing.  
5. Migrations: partition `messages`, `reservations`, chunks by hash/month.  
6. APIs: none if transparent.  
7. Workers: backfill.  
8. Infra: possible extra DBs.  
9. Tests: routing correctness.  
10. Acceptance: p95 recovered; no tenant cross-read.  
11. Rollback: do not start without a rollback plan per partition.  
12. Risks: premature sharding.  
13. Monitoring: primary CPU, index size.  
14. Production checklist: only after measured need.  
15. Order: measure → design → partition one table → stop.

---

# Roadmap

## Phase 1 — Money and safety (deployable now)

WP-1.1 Ledger invariant  
WP-1.2 Monthly credits vs burst labels  
WP-1.3 Stripe webhook inbox  
WP-1.4 HNSW indexes  
WP-1.5 Chunk/byte caps  
WP-1.6 Cache prefixes / no tool cache  
WP-1.7 Cross-tenant tests  
WP-1.8 Enable checkout only after 1.3  

Exit: paid $20 grants ≤ $8 AI; top-up $10 grants $4; embeddings indexed; checkout can be turned on safely.

## Phase 2 — Ingest and retrieval (deployable after Phase 1)

WP-2.1 Async S3 ingest  
WP-2.2 Malware scan  
WP-2.3 Hybrid retrieval  
WP-2.4 Embed model/dim + budget  
WP-2.5 RAG eval gate  
WP-2.6 Full Custom activation API  

Exit: uploads are async and scanned; hybrid search behind eval; custom customers activated on the same ledger. Still no Shopify/email/new vector vendor.

## Phase 3 — Isolation and operations (deployable after Phase 1)

WP-3.1 RLS  
WP-3.2 Provider breakers  
WP-3.3 Split Redis  
WP-3.4 Price catalog  
WP-3.5 Conversation TTL + worker compact  
WP-3.6 Delete or implement extra limit actions  

Exit: tenancy has DB teeth; provider outages do not stampede; cache/queue/holds isolated.

## Phase 4 — Quality and compliance (deployable after Phase 2)

WP-4.1 Rerank  
WP-4.2 OCR  
WP-4.3 Single-flight cache  
WP-4.4 Stripe Tax  
WP-4.5 Memory/privacy  
WP-4.6 Partition only if measured  

Exit: better answer quality, honest scan support, tax/privacy. Cells only with evidence.

---

# Suggested implementation sequence inside each phase

Phase 1: 1.1 → 1.3 → 1.5 → 1.4 → 1.2 → 1.6 → 1.7 → 1.8  
Phase 2: 2.1 → 2.2 → 2.4 → 2.3 → 2.5 → 2.6  
Phase 3: 3.4 → 3.2 → 3.5 → 3.3 → 3.6 → 3.1  
Phase 4: 4.3 → 4.1 → 4.2 → 4.5 → 4.4 → 4.6  

Phase 2 and Phase 3 may proceed in parallel after Phase 1, as long as 2.1 does not land without 1.4/1.5 and 3.1 does not land without 1.7.
