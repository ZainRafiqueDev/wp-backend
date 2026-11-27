# ChatMate360 — Implementation handoff (2026-09-28, Phase 5 appended)

Written for the next assistant picking this up. It records what was actually built this session, what was deliberately **not** built and why, and the constraints and hazards that must carry forward.

Repos: backend `Chatmate360-Backend-main`, frontend `chatmate360-main`.

---

## Rules that carry forward — read before doing anything

1. **Never send a real email via Resend without asking the user first, explicitly, every time.** This includes OTP and verification emails. The user has stated this repeatedly. (Resend is in sandbox here anyway — the domain is unverified — but ask regardless.)
2. **The user does their own git commits and pushes.** Do not commit or push unless they ask in that session. The backend directory is not even a git repo (`git status` reports not a repository).
3. **`chatmate360-frontend-clone` is stale.** Abandoned fork of the same remote. Do not develop there.
4. **Phase 4 and Phase 5 are implemented.** Do not infer a Phase 6 from the blueprint.
5. **Two conflicting WP numbering schemes exist** — the user's Phase 3 prompt, and `docs/blueprint/IMPLEMENTATION_BLUEPRINT.md`. Do not cross-reference WP numbers between them.

---

## 1. Crawl Plus billing fix — DONE

The reported bug: payment succeeds, the user is never upgraded to Crawl Plus.

**Root cause.** In `syncFromSubscription`, `cashUsdFromSubscriptionItem` threw `"Subscription price unit_amount is missing."` — *after* the session-amount assertion had already passed. Because it threw, `upsertSubscriptionRow` never ran, so the plan was never written even though Stripe had taken the money. The `unit_amount` was missing because the subscription was retrieved without expanding the price.

**Fix.** Thread the already-known cash amount through as an option so the throwing lookup is skipped entirely, expand `items.data.price` on retrieve, and add `invoice.paid` as a second, independent activation path so a missed `checkout.session.completed` can't strand a paying customer.

```ts
async function syncFromSubscription(
  subscription: Stripe.Subscription,
  options: { userId?: string; cashUsd?: number; fallbackPeriodEnd?: Date } = {},
): Promise<void> {
  const cashUsd = options.cashUsd ?? cashUsdFromSubscriptionItem(subscription.items.data[0])
```

The other four requested behaviours:

| Requirement | Where |
| --- | --- |
| Next billing date visible (pay 7pm 28 Sep → 28 Oct 7pm) | `src/lib/billingPeriod.ts` → `addOneBillingPeriod`, clamping to month end so 31 Jan → 28/29 Feb |
| Unpaid reverts to the free dashboard | `accessGate.service.ts` reads the subscriptions row directly instead of deriving `plan` from the entitlement |
| Crawl Plus held until payment clears | `isHeldPaidPlan` + `onHold` on `BillingSummary` and `AccountStatus` |
| Alert 2–5 days before expiry | `runBillingLifecycleTick()` on the worker, `hasSubscriptionNotice()` |

**Stripe SDK v22 ("Basil") gotchas** encoded in `billingPeriod.ts` — worth knowing before touching billing:
- `current_period_end` lives on the **SubscriptionItem**, not the subscription.
- The invoice→subscription id is at `parent.subscription_details.subscription`.

**Files.** `src/lib/billingPeriod.ts` (new), `src/services/billing.service.ts`, `src/services/accessGate.service.ts`, `src/worker.ts`, `src/env.ts`; frontend `billing-panel.tsx`, `workspace.tsx`, `workspace-shell.tsx`, `embed-panel.tsx`.

**Tests.** `tests/unit/billingPeriod.test.ts` (new) + 4 cases added to `tests/integration/billing.integration.test.ts`.

---

## 2. WP-3.4 Advanced Session Memory — DONE

Full design notes are in **`docs/SESSION_MEMORY.md`**. Summary of what exists now:

- **`conversation_facts`** table — structured key/value facts per (chatbot, customer, key), with confidence and first/last-seen timestamps, capped at `SESSION_MEMORY_MAX_FACTS` with least-recently-seen eviction.
- **Fact extraction** after each turn via `completeCheaply()`, charged to tenant credits like every other model call. Fail-open: it runs after the answer is already produced and swallows every error.
- **Parsing isolated in `src/lib/memoryFacts.ts`**, deliberately free of DB and AI imports so it is directly unit-testable. Tolerates prose around the JSON, duplicate keys, out-of-range confidences, over-long values.
- **Compaction moved off the hot path.** It used to run inline on the turn that crossed the threshold, making one unlucky visitor pay for summarising the whole conversation. `recordTurn` now only sets a `needs_compaction` flag; the worker's maintenance tick does the work.
- **Conversation TTL** (`expires_at`), refreshed every turn — an *idle* TTL, not age since creation.
- **Privacy export/delete** at `POST /public/chatbots/:chatbotId/memory/{export,delete}`.

**Two decisions that look odd but are deliberate — do not "fix" them:**

- **Export is a POST, not a GET.** The customer identifier goes in the body so it never lands in browser history, referrer headers, or access logs.
- **An unknown customer id returns 404, not 403.** A 403 would confirm the id exists, turning the endpoint into an oracle for probing which customers a chatbot has talked to.

**Security gap found and closed:** `session_summaries` is a chatbot-scoped table that had **never** been covered by RLS. It is now, in `db/rls.sql`.

**Migration:** `db/migrations/20260929_advanced_session_memory.sql`, already applied to both `chatmate360_test` and `chatmate360`. It is guarded — if `app.is_privileged()` is missing it raises a notice telling you to apply `db/rls.sql` first rather than failing obscurely. The tables were also appended to `db/schema.sql` so a fresh database is complete.

**Tests:** `tests/unit/memoryFacts.test.ts` (9) and `tests/integration/advancedSessionMemory.integration.test.ts` (16, including the two cross-tenant cases added for the route pack).

---

## 3. WP-3.5 RAG Evaluation Framework — DONE (as a gap-fill)

**Important framing:** the framework was *already built* under a different name as WP-2.5 — `src/lib/ragEval.ts`, `tests/eval/ragEval.test.ts`, `docs/RAG_EVAL.md`, 64 labeled pairs, all ten metrics, threshold gating, artifact writing. It did not need a rebuild. Three real gaps were closed instead.

**Gap 1 — no regression detection.** Absolute thresholds answer "is retrieval good enough", but cannot answer "did this change make it worse": a run could fall from 0.98 to 0.81 and still clear the 0.80 floor. Every run is now also compared against `evals/rag/baseline.json`, the last accepted run, via `evaluateRagRegression`. Isolation violations get **no** slack — any increase is a tenant leak. Re-baseline with `npm run eval:rag -- --update-baseline`, which only writes if the run passed both gates, so a bad run can't enshrine itself as the new floor.

**Gap 2 — no per-kind breakdown.** The aggregate was blind to which query class regressed. `breakdownByKind` now slices every metric by `lexical | synonym | negative | isolation`. A synonym-recall collapse offset by lexical gains is exactly what a retrieval or rerank change tends to introduce, and the flat average hides it.

**Gap 3 — no runner outside vitest.** `scripts/runRagEval.ts` + `npm run eval:rag`, exiting non-zero on failure so it drops into CI.

Current numbers (64 pairs): recall@5 and @10 100%, precision@5 71.9%, MRR 0.900, nDCG@10 0.926, citation coverage 100%, grounded 100%, hallucination 0%, isolation leaks 0, p50 36ms / p95 60ms.

### The non-obvious thing you need to know about this eval

**It is not hermetic, and the baseline is only valid for the canonical runner.**

Running the eval alone gives MRR 0.900. Running it as part of `npx vitest run` gives 0.847 — with recall still at a perfect 100%. Only the *ordering* moved. The cause: `chatbot_document_chunks.embedding` carries an **HNSW (approximate)** index, and the shared test database accumulates rows across every run with no reset (see the comment in `vitest.config.ts`). As the table grows and other suites write to it concurrently, approximate neighbour ordering shifts for reasons that have nothing to do with any retrieval change.

So the regression gate **fails** only when `RAG_EVAL_ENFORCE_BASELINE=true`, which `npm run eval:rag` sets because that runner executes the eval alone against a quiet database. A whole-suite run still computes and prints the deltas, but does not fail on them. Absolute thresholds are hermetic and always gate.

If you ever see the baseline gate firing in a full-suite run, this is why — do not "fix" it by loosening `RAG_EVAL_MAX_REGRESSION`.

---

## Verification state

Everything below was run and green after Phase 4:

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | clean |
| `npx eslint src tests scripts` | 0 errors; 2 pre-existing unused-var warnings (`commerceWebhookReceive.service.ts`, `semanticRechunk.integration.test.ts`) |
| `npx vitest run` | **118 files, 638 tests, all passing** |

Two failures seen mid-session and resolved, recorded so they aren't re-diagnosed:

- **`crossTenantRoutePack.test.ts`** correctly caught that the two new memory routes weren't in the WP-1.7 catalog. Fixed properly: registered in `tests/helpers/crossTenantRoutePack.ts` **and** given real cross-tenant coverage, including a test that another tenant's erase attempt returns 404 *and leaves the victim's memory intact*. Do not silence this guard by adding a catalog entry without a covering test.
- **`preferredModel.integration.test.ts`** timed out at 30s in the full suite but passes alone in 13.6s. It deliberately makes **real** provider calls with no mocking, so it is sensitive to network latency under suite load. Pre-existing flake, not a regression.

---

## Test hazard — read before adding retrieval tests

`.env` in this environment holds **real, live** OpenAI and Gemini keys, and the suite exercises some of them on purpose.

If you add a test that calls `lookupRelevantDocumentChunks` (or anything reaching it) with real document chunks seeded, you **must** carry the same `src/lib/ai.js` mock the existing eval uses:

```ts
vi.mock("../../src/lib/ai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/ai.js")>()
  return { ...actual, completeCheaply: vi.fn(async () => null) }
})
```

Without it the test will silently make real network calls against production keys, and will flake, time out, or consume real quota. `advancedSessionMemory.integration.test.ts` mocks `completeCheaply` and branches on `prompt.includes("Extract durable facts")`.

---

## 4. Phase 4 (WP-4.1–4.6) — DONE as a gap-fill

Phase 4 was **not** a rebuild. RLS, AES-256-GCM secret encryption, async ingest, ownership 404s, and `planEconomics` already existed. This work filled the production-hardening gaps from the 2026-09-28 Phase 4 prompt.

**Deliberate substitutions (do not "fix" them to match the prompt verbatim):**

| Prompt asked | What we kept / did instead | Why |
| --- | --- | --- |
| pgcrypto `pgp_sym_encrypt` with `SET LOCAL app.encryption_key` | Keep `src/lib/crypto.ts` AES-256-GCM (`INTEGRATION_ENCRYPTION_KEY`) | Transaction-mode PgBouncer would drop a session GUC encryption key; GCM already encrypts every `*_encrypted` column |
| Ownership 403 | Ownership **404** | Revealing 403 confirms the chatbot exists |
| `chatmate_app` / `chatmate_admin` roles | Existing `chatmate360_app` (NOBYPASSRLS) + `app.is_privileged()` for admin/system/worker | Already deployed; renaming roles is a production outage |
| `conversation_messages` / `customer_profiles` / `ai_usage_ledger` | `messages`, `customer_identities`, `chatbot_usage` | Those are the real table names |
| Inline ingest forbidden always | `DOCUMENT_INGEST_ASYNC` defaults **true**; `false` is tests/rollback only | Existing ingest tests need the sync path |
| Alert emails on by default | `ALERT_EMAIL_ENABLED` defaults **false** | Never send Resend without asking the user |
| 500-concurrent live chat load test | `scripts/loadTestChat.ts` hits `/health` | Live provider calls would burn quota |

### WP-4.1 Security

- `security_audit_log` + `recordSecurityEvent` (unauthorized_access, rls_violation, admin_action, webhook_signature_failed)
- 403/401 → audit in `errorHandler.ts`; webhook signature failures audited
- RLS already on tenant tables; Phase 4 migration adds policies for new tables
- Five named negative tests in `tests/integration/postgresRls.integration.test.ts` (`WP-4.1 five negative isolation tests`) — CI runs the full suite and blocks on failure

### WP-4.2 Scale

- PgBouncer service in `docker-compose.yml` (`pool_mode=transaction`, `max_client_conn=1000`, `default_pool_size=25`). `SET LOCAL` app GUCs still work because `src/lib/db.ts` wraps queries in BEGIN/SET LOCAL/COMMIT
- Redis circuit breakers `circuit:{provider}`: CLOSED/OPEN/HALF-OPEN, 5 fails/30s, 60s recovery, 3 half-open successes, 5 min TTL
- Ingest queue backpressure at depth > 1000 → 429; BullMQ attempts=3, `removeOnFail: false`
- `GET /chatbots/:chatbotId/documents/:id/status`

### WP-4.3 Model routing

- `model_routing_configs` + `model_costs`
- `decideModelRoute`: preferred → circuit skip → cost switch (<20% remaining) → fallback chain → null (caller returns 503)
- Credit rates prefer `cachedRateForModel` from `model_costs`
- `selectModelForConversation` still falls back to the old auto chain if routing throws (keeps existing unit tests)

### WP-4.4 Pricing

- `pricing_configs` with `computed_ai_credits < price_usd` check constraint
- Immutable on change: deactivate old row, insert new `effective_from`
- Grants use stored `computed_ai_credits`, never recompute at grant time
- Admin `/admin/pricing` + Recalculate preview/apply
- Seeded: crawl_plus_monthly $20, top-up starter/standard/growth/scale

### WP-4.5 Observability

- Admin `/admin/observability` — platform health (30s refresh), AI quality from `rag_evaluations`, tenant usage drill-down
- APIs: `/admin/metrics/{platform-health,ai-quality,tenant-usage,provider-status,queue-depth}`
- Alerts in `alert_configs` (grounding, circuit open, queue depth, tenant 90%). Emails only if `ALERT_EMAIL_ENABLED=true`

### WP-4.6 Ingest pipeline

- Stages: validate (inline) → scan → extract (+ optional tesseract OCR) → semantic chunk (v2) → embed batches of 100 → finalize
- `paused_no_credits` + `resumePausedIngests` after top-up webhook
- `document_ingestion_log` per job
- Isolation probe after READY; logs `rls_violation` if another tenant's chunks are visible
- `assertProductionGuards()`: production + `DOCUMENT_SCAN_SKIP=true` **throws at startup**
- 202 + `job_id` (the document id)

### Database migration (apply to `chatmate360` and `chatmate360_test`)

```
db/migrations/20260930_phase4_hardening.sql
```

Also `\ir`'d from `db/schema.sql` after `rls.sql`. If `app.is_privileged()` is missing, apply `db/rls.sql` first.

### New API endpoints

| Method | Path |
| --- | --- |
| GET | `/chatbots/:chatbotId/documents/:id/status` |
| GET | `/admin/metrics/platform-health` |
| GET | `/admin/metrics/ai-quality?days=7&chatbot_id=` |
| GET | `/admin/metrics/tenant-usage?month=&limit=10` |
| GET | `/admin/metrics/provider-status` |
| GET | `/admin/metrics/queue-depth` |
| GET/POST | `/admin/pricing` |
| POST | `/admin/pricing/recalculate` `{ apply?: boolean }` |
| GET | `/admin/alerts` |
| PATCH | `/admin/alerts/:alertType` |

### Rollback (each WP independently)

1. **4.1** — drop `security_audit_log`; leave existing RLS (do not disable it)
2. **4.4** — stop writing `pricing_configs`; grants fall back to `env.crawlPlusPlanMonthlyCostCapUsd` / `env.topupCreditUsd`
3. **4.2** — point `DATABASE_URL` back at Postgres :5435; circuit breaker fail-open if Redis is down
4. **4.3** — `selectModelForConversation` catch path still runs the old auto chain
5. **4.6** — `DOCUMENT_INGEST_ASYNC=false` restores inline ingest for files under the sync cap
6. **4.5** — hide admin nav items; metrics routes 404 if you remove them

### Production checklist (from the Phase 4 prompt)

```
Pre-deployment:
[ ] DOCUMENT_SCAN_SKIP=false verified in prod env
[ ] pgcrypto extension enabled (already in schema.sql; used for gen_random_uuid)
[ ] PgBouncer configured and tested with RLS (SET LOCAL inside transactions)
[ ] ClamAV running; app will refuse to start if SCAN_SKIP=true in production
[ ] Redis running (circuit breakers + BullMQ ingest)
[ ] pricing_configs seeded (migration insert)
[ ] Stripe products created; store price ids on pricing_configs.stripe_price_id
[ ] ALERT_EMAIL_ENABLED left false until the user authorizes Resend
[ ] INTEGRATION_ENCRYPTION_KEY set (32-byte hex)

Deployment order:
1. DB migrations (20260930_phase4_hardening.sql, rls.sql if not applied)
2. Background workers
3. API server
4. Admin dashboard (observability + pricing pages)

Post-deployment:
[ ] Upload a document → 202 + job_id → READY
[ ] Chat < 1000ms
[ ] Observability dashboard shows live provider/queue data
[ ] Cross-tenant tests still pass
```

### Intentionally incomplete vs the letter of the prompt

- **500 concurrent chat against live models** was not run. Use `npx tsx scripts/loadTestChat.ts --n 500` against a running API (`/health` only).
- ~~**PgBouncer image tag** `edoburu/pgbouncer:v1.22.1-p1` is unpulled here~~ — **fixed**: that tag was a 404 (never existed on Docker Hub; the real tags use a `v` prefix and a `-pN` suffix, e.g. `v1.25.2-p0`, not `v1.22.1-p1`). `docker-compose.yml` now pins `edoburu/pgbouncer:v1.25.2-p0`, confirmed pullable and confirmed live: brought the container up and verified `SET LOCAL` tenant GUCs survive transaction-mode pooling end-to-end (container-to-container, matching how the real app connects — not through a Windows-host port-forward, which has an unrelated SCRAM/NAT quirk on this dev machine only).
- **Full golden eval is not spawned after every ingest** (would burn embedding quota on every PDF). Isolation probe + `npm run eval:rag` remain the gates.
- **Admin pricing UI** lists/recalculates; it does not create Stripe products from the browser. Store `stripe_price_id` on the config row after creating the product in Stripe.

---

## 5. Phase 5 OKF Knowledge Layer — DONE

Pre-check: `rag_evaluations` had 1 labeled-eval row before start.

OKF is a **second knowledge path** in front of hybrid RAG. A match returns curated `body_md` with a citation and **never** sends that text through the answering LLM. No match falls through to WP-3.2 unchanged.

**Invariants kept:**
- `approved_at IS NULL` is invisible to the router
- Soft deactivate only (`is_active = false`)
- Tenant isolation via ownership 404 + RLS
- Suggestion emails are in-app `system` notifications only (`ALERT_EMAIL_ENABLED` still defaults false)

### Audit checklist (evidence)

| Item | Evidence |
| --- | --- |
| Tables + HNSW | `db/migrations/add_okf_tables.sql` |
| Index rebuild on approve/deactivate | `src/services/okf.service.ts` `rebuildIndex` / `approveConcept` / `deactivateConcept` |
| Audit log every mutate | `writeAudit` in `okf.service.ts` |
| Export ZIP + YAML frontmatter | `exportBundle` + `src/lib/okf.ts` `toOkfMarkdownFile` |
| Router before RAG | `src/lib/answerChatbotQuestion.ts` ~239–258 |
| Thresholds from env | `OKF_SEMANTIC_THRESHOLD` etc. in `src/env.ts` |
| No LLM paraphrase | `aiGenerated: false`, answer = `formatOKFAnswer` |
| Routing logged | `okf_routing_log` + `rag_evaluations` pair_count=0 rows |
| `okf_suggest` after finalize | `documentIngestion.service.ts` `afterIngestReady` |
| Suggestions pending | `created_by = 'ai_extracted'`, `approved_at` null |
| Staleness alert | `maybeAlertOkfStale` from conversation maintenance tick |
| Negative tests | `tests/integration/okf.integration.test.ts` |

### Intentional gaps vs the letter of the prompt

- There is still **no customer thumbs-up widget**, so OKF satisfaction is not a live ratio. Dashboard shows hit rate / coverage gap / pending / live count.
- Per-query routing rows go into `rag_evaluations` with `pair_count = 0` so they do not pollute WP-3.5 quality averages (`pair_count > 0` filter).
- Tenant CRUD lives at `/dashboard/okf` (chatbot owner), not `/admin/chatbots/:id/okf`. Platform admin gets OKF metrics on `/admin/observability`.

---

## NOT implemented — and why

### Smaller items not done

- The frontend has no UI for the memory export/delete endpoints. The backend API is complete and tested; nothing consumes it yet.
- The labeled eval set is 64 pairs. `docs/RAG_EVAL.md` targets 50–100 before treating hybrid retrieval as frozen.

---

## Environment notes (Windows / PowerShell)

- `psql` is **not** on PATH. Use:
  ```powershell
  Get-Content <file> -Raw | docker exec -i chatmate360-backend-main-postgres-1 psql -U postgres -d <db> -v ON_ERROR_STOP=1
  ```
- `<` redirection is a **PowerShell parse error** ("The '<' operator is reserved for future use"). Pipe `Get-Content` instead.
- Databases: `chatmate360` (dev) and `chatmate360_test` (suite). Apply migrations to both.
