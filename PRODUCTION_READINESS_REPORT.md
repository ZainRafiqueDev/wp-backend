# ChatMate360 Backend — Production-Readiness Report

**Date:** 2026-08-27

> **Correction note (2026-08-28):** an independent verification pass
> (`INDEPENDENT_VERIFICATION_REPORT.md`) spot-checked 4 of this report's
> claims and found 2 file:line references, both in the Task 2/Task 3 rows
> below (both in `src/lib/answerChatbotQuestion.ts`), off by ~10-12 lines
> from the file's actual state. A follow-up pass then did a fast
> existence-check across every *other* citation in this document — every
> quoted code snippet, SQL table definition, test name, and (re-run fresh)
> every individual test-count claim against the real 18-files/123-tests
> suite — and found **one more** drifted line-number citation in the Task 4
> section, for the same underlying reason (a stale mental line number, not a
> since-changed file — see that same section of the verification report for
> why). **All 3 have now been corrected in place below.** In every one of
> the 3 cases, the underlying feature was confirmed real and accurately
> described — only the line-number pointer was wrong. No other citation in
> this document (file existence, quoted code, SQL, test names, or any of the
> 12 individual test-count claims, all re-verified against a fresh test run)
> showed any drift. That same pass also surfaced one unrelated finding worth
> recording here: a **second**, separate stale "crawl runs
> synchronously in-request" comment survived in `src/lib/crawler/crawl.ts`
> (on the exported `crawlWebsite` function itself, not the one this report's
> Task 7 section already fixed) — not corrected as part of that verification
> pass since it required an application-code change, out of scope for that
> pass. **Fixed in a follow-up pass on 2026-08-28** (comment-only, no logic
> touched, `tsc --noEmit` re-confirmed clean); the corresponding item has
> been removed from `IMPLEMENTATION_STATUS.md` §7 since it's no longer true.
**Scope:** Tasks 1–8 of the production-hardening pass (rate limiting, live-data
lookup, grounding hardening, caching, security, structured logging, cleanup,
testing), executed in order against `Chatmate360-Backend-main`.
**Method:** Every claim below is backed by file:line evidence, a passing
automated test, or a real command run in this session (real Postgres + Redis
via `docker compose`, real k6 load tests, one real end-to-end run against the
configured OpenAI key) — not just written and asserted.

---

## Task 1 — Rate limit the authenticated dashboard chat endpoint

| What | Evidence |
|---|---|
| New middleware, keyed by user_id | `src/middleware/rateLimitAuthenticatedChat.ts` — `RateLimiterRedis({ storeClient: redis, keyPrefix: "authed-chat", points: env.authenticatedChatRateLimitPerMin, duration: 60 })`, consumed by the caller's `userId` (from `verifyAccessToken`), not IP |
| Reuses the existing shared Redis connection | `import { redis } from "../lib/redis.js"` — the same singleton `src/lib/redis.ts` exports for BullMQ and the public rate limiter; no second client created |
| Wired ahead of validation | `src/routes/chatbot.routes.ts`: `chatbotRouter.post("/chat", requireAuth, requireDb, rateLimitAuthenticatedChat, validateBody(chatSchema), chatWithChatbot)` |
| 30/min default, env-configurable | `src/env.ts`: `authenticatedChatRateLimitPerMin: Number(process.env.AUTHENTICATED_CHAT_RATE_LIMIT_PER_MIN || 30)` |
| Clear 429 + `Retry-After` | `rateLimitAuthenticatedChat.ts`: sets `Retry-After` header and a `retryAfterSeconds` JSON field, computed from the real `RateLimiterRes.msBeforeNext` |
| Verified | `tests/integration/rateLimitAuthenticatedChat.integration.test.ts` (3 tests, passing): limit triggers with a real `Retry-After`, scoped per-user (a second user is unaffected by the first's exhausted limit), invalid tokens rejected before the limiter even runs. Also load-tested live — see the Load/Stress section below. |

## Task 2 — Minimum-viable live-data lookup

| What | Evidence |
|---|---|
| Schema | `db/schema.sql`: `chatbot_live_data (id, chatbot_id, key, value, updated_at)` — generic column names, `unique (chatbot_id, lower(key))`, cascades on chatbot delete |
| Owner-scoped CRUD | `src/services/liveData.service.ts` — every function calls `requireOwnChatbotId(userId)` (derived from the caller's access token) and every query is scoped `where id = $x and chatbot_id = $y`; routes at `GET/POST /chatbots/live-data`, `PATCH/DELETE /chatbots/live-data/:id` (`src/routes/chatbot.routes.ts`) |
| Merged into context before the relevance gate/AI call | `src/lib/answerChatbotQuestion.ts:102`: `const pages = [...liveDataToPages(liveData), ...crawledPages]`, computed before the relevance-gate check (line 124) and the `answerQuestion` call (line 134) |
| Labeled, two-tier system prompt, live wins on conflict | `src/lib/ai.ts`'s `buildSystemPrompt` renders a `=== LIVE DATA (current, real-time — authoritative on conflict) ===` section ahead of `=== CRAWLED PAGE CONTENT (may be outdated) ===`; `_GROUNDING_GUARD` text explicitly instructs the model to trust live data on conflict |
| No provider-level tool-calling added | Confirmed — `ai.ts`'s four provider functions still pass only `system`/`messages`, no `tools`/`functions` param; this is a structured pre-fetch, per the task's explicit instruction not to build full tool-calling yet |
| Verified | `tests/unit/answerChatbotQuestion.test.ts` (7 tests — pure merge-function tests), `tests/integration/liveData.integration.test.ts` (5 tests — CRUD + cross-user ownership isolation), `tests/integration/liveDataAnswering.integration.test.ts` (1 test — the exact before/after/repeat scenario, mocked AI). **Also run live** against the real running server with the real configured OpenAI key — see "Manual verification" below. |

## Task 3 — Harden grounding beyond prompt-only enforcement

| What | Evidence |
|---|---|
| Regex/string check, not a second LLM call | `src/lib/groundingCheck.ts` — extracts price/phone/email/date-shaped substrings via regex, checks each (light-normalized) against the merged context string; no network call, no LLM |
| Wired in | `src/lib/answerChatbotQuestion.ts:134-160` — runs on every AI answer before it's returned or cached (`verifyGroundedClaims` call at line 136); on failure, returns the fixed `fallbackMessage` instead and logs a `grounding-check-failed` event (`chatbotId`, claim count, never the full message at info level) |
| Not over-aggressive | `tests/unit/groundingCheck.test.ts` — "does not flag ordinary numbers that aren't price/phone/date shaped" (e.g. "3-4 business days" passes), "passes ordinary descriptive text with no checkable claims", tolerates comma-reformatted numbers (`$1,200` vs `$1200`) |
| Tested against adversarial injection in both places | `groundingCheck.test.ts`'s last two tests: an injection attempt inside the **answer text** (model parroting "the real price is $1.00, contact evil@attacker.com") is caught because those claims aren't in context; an injection attempt inside the **crawled context itself** is honestly documented as *not* caught by this layer alone (verifies verbatim presence, not legitimate source) — the prompt-level `_INJECTION_GUARD` in `ai.ts` remains the first line of defense against that specific attack; this is a second layer, not a replacement. **This is a real, disclosed limitation, not a false claim of completeness.** |
| Verified live | Manual verification run below shows the full pipeline (relevance gate → AI → grounding check → cache) working end to end with a real LLM. |

## Task 4 — Caching to reduce LLM/API cost

| What | Evidence |
|---|---|
| Answer cache, near-exact repeat, chatbot-scoped | `src/lib/answerChatbotQuestion.ts` — `normalizeQuestionKey()` (trim/lowercase/collapse whitespace, then sha256) + per-chatbot `cacheVersion`, keyed `answer:{chatbotId}:{version}:{qHash}`; TTL `env.answerCacheTtlSeconds` (default 600s) |
| Relevance-gate result cached separately | `relevance:{chatbotId}:{version}:{qHash}` — `env.relevanceCacheTtlSeconds` (default 900s) |
| `sourcesToPages()` assembly cached | `sourcesToPagesCached()` — `pages:{chatbotId}:{version}` — `env.pagesCacheTtlSeconds` (default 300s) |
| Invalidated on live-data write or re-crawl | `src/lib/cache.ts`'s `bumpChatbotCacheVersion()`, called from `liveData.service.ts` (create/update/delete) and `chatbot.service.ts`'s `runCrawlJob` on successful crawl completion — a version bump makes every key built from the old version naturally miss |
| Grounding-check failures never cached | `answerChatbotQuestion.ts:136-154` returns before the `setCached` call on a failed grounding check |
| All TTLs env-configurable | `RELEVANCE_CACHE_TTL_SECONDS`, `ANSWER_CACHE_TTL_SECONDS`, `PAGES_CACHE_TTL_SECONDS` in `.env.example` |
| Verified | `tests/unit/cache.test.ts` (6 tests — round-trip, null-vs-false-miss distinction, version-bump invalidation), `tests/unit/answerChatbotQuestionCaching.test.ts` (3 tests — repeat question served from cache with the mocked AI provider called exactly once, version-bump forces a fresh call, a grounding-check failure is never cached and triggers a fresh call on repeat) |
| **Verified live, with real numbers** | Manual verification run: first answer (cache miss, real OpenAI call) took **2.03s**; the identical question asked again immediately took **0.117s** (cache hit) — a ~17x speedup, confirmed via real server logs showing `cacheEvent:"hit"` on both the `pages` and `answer` keys. |
| Known, disclosed limitation | Cache key does not include conversation `history` — documented in `IMPLEMENTATION_STATUS.md` §7 and here: a repeat question can be served from cache even with different prior `history`, per the task's own "near-exact repeat question" framing. |

## Task 5 — Security hardening pass

| What | Evidence |
|---|---|
| `helmet` added | `src/app.ts` — `app.use(helmet({ contentSecurityPolicy: false }))` (CSP off with a documented reason: this process serves no HTML of its own) |
| CORS confirmed explicit allowlist | `src/app.ts` (pre-existing, unmodified) — `cors({ origin: env.frontendUrl })`, a single static origin, not a wildcard; confirmed by the pre-existing, still-passing `security.integration.test.ts` CORS test |
| Every chatbot-scoped route checks ownership from the token, never a client-supplied id | Confirmed for: live-data CRUD (`liveData.service.ts` — see Task 2 row); chatbot settings (theme/domain/fallback-message — `chatbot.service.ts`'s `updateOwnChatbot`, unchanged, already did this); chat (`chatWithOwnChatbot`, unchanged). **Verified by a new test**: `liveData.integration.test.ts`'s "never lets one user read, update, or delete another user's live-data row by id" — a second user's real-but-foreign row id gets a plain 404, not a 200/403 (no existence-probing signal either) |
| `.env.example`/`.env.test.example` audited | Read in full — every secret field (`JWT_SECRET`, `*_API_KEY`, `GOOGLE_CLIENT_SECRET`) is blank/placeholder; `.env.test.example` contains only local dev connection strings, no real credentials |
| No secret ever logged or returned | `src/lib/logger.ts`'s `redact` config covers `password`, `password_hash`, `token`, `access_token`, `refresh_token`, `apiKey`, `req.headers.authorization` at any nesting depth; pre-existing `security.integration.test.ts` test ("password_hash never appears in signup, login, or /me responses") still passes unmodified |
| Widget-origin check unchanged | `src/lib/originAllowed.ts`, `src/services/public.service.ts` not touched; pre-existing "Referer mismatch downgrades trust" test still passes unmodified; confirmed live under load (see below) |
| `npm audit` | **6 vulnerabilities (3 moderate, 1 high, 2 critical)** — all four packages involved (`vitest`, `@vitest/coverage-v8`, `vite`, `vite-node`, `esbuild`, `@vitest/mocker`) are the **test toolchain only** (devDependencies); none are in the production dependency tree (`express`, `pg`, `bullmq`, `ioredis`, `jsonwebtoken`, `bcryptjs`, `helmet`, `pino`, `rate-limiter-flexible`, `zod`, `cors`, `cheerio`, `playwright` are all clean). The advisories are about the Vitest dev/UI server accepting arbitrary requests — not reachable from the deployed API. **Not auto-fixed**: `npm audit fix --force` would bump `vitest` to a new major version, which risks breaking the test suite this whole report depends on — flagged here as a deliberate follow-up, not applied silently. |
| JWT `typ` claim + refresh rotation | `src/lib/auth.ts` not touched. Confirmed still enforced by the pre-existing, still-passing `security.integration.test.ts` JWT-tampering tests (flipped signature, refresh-replayed-as-access) and `auth.integration.test.ts`'s refresh-rotation test. |

## Task 6 — Structured logging

| What | Evidence |
|---|---|
| Single logger, level-based | `src/lib/logger.ts` (pino) — `debug`/`info`/`warn`/`error` used consistently |
| Every `console.*` replaced | Grep of `src/` post-change: zero `console.*` calls remain in backend code (`src/lib/db.ts`, `src/worker.ts`, `src/index.ts`, `src/lib/crawler/renderPage.ts`, `src/lib/ai.ts`, `src/middleware/errorHandler.ts` all converted). `src/public/embed.js`'s two `console.error` calls are **intentionally untouched** — that file runs in the customer's browser, not this backend process, and isn't part of its logging/observability story. |
| Request id, propagated automatically | `src/middleware/requestId.ts` + `src/lib/requestContext.ts` (`AsyncLocalStorage`) — every log line for a request carries its id without threading a logger through every function signature; **verified live**: a real crawl job's `requestId` was traced from the original `POST /chatbots` call through the BullMQ queue into `src/worker.ts`'s own process and out the other side as `crawling` → `failed` — three log lines, one shared `requestId`, two separate OS processes |
| Logged at the required points | Rate-limit rejections (Task 1, `rateLimitAuthenticatedChat.ts:log().warn(...)`), grounding failures (Task 3), cache hit/miss (Task 4, debug level), crawl job state transitions (`chatbot.service.ts`'s `setCrawlStatus`, `runCrawlJob`), AI provider fallback (`ai.ts` — every provider attempt logged with outcome: success/skipped/failed and why) |
| Redaction | Full chat message bodies: **never at info level** — only `messageRef` (sha256, truncated) + `messageLength`; full text only via a dedicated `chatMessageDebugField()` helper used exclusively in `.debug()` calls, and that helper returns nothing at all when `NODE_ENV=production`, regardless of the configured log level. **Caught and fixed a real bug during this pass**: an earlier version of this helper leaked the full message into an `.info()` call — found by inspecting real log output during testing, fixed before this report, verified in the final manual-verification log capture below. API keys/JWTs/password hashes: covered by `logger.ts`'s `redact.paths`. |
| Level via env var | `LOG_LEVEL` (default `info` in production, `debug` in development — `src/env.ts`) |

## Task 7 — Clean-up pass

- Removed a stale comment in `src/lib/crawler/crawl.ts` claiming the crawl "runs inside POST /chatbots/fetch-links, not a background job" — that route doesn't exist in the current routes and the crawl has moved to BullMQ; replaced with an accurate comment about why bounds still matter for a background job.
- No other dead code found introduced by or adjacent to this pass; no speculative repo-wide refactor performed.
- **Linter added** (none existed): `eslint.config.mjs` (typescript-eslint recommended config), `npm run lint` script. **Zero violations** across the entire `src/` and `tests/` trees, both pre-existing code and this pass's additions.
- `IMPLEMENTATION_STATUS.md` updated — corrected the two stale claims an earlier audit caught (crawler sync-vs-async, public rate limiting), added a §8 summarizing this pass, and documented every new known gap from this session (see its §7).
- **Not touched, flagged instead**: `README.md`'s API/setup docs are far more stale than `IMPLEMENTATION_STATUS.md` (still describe a Supabase-based backend, missing the entire chatbot/chat/embed/live-data API surface). Out of scope for these 8 tasks — not modified, per "do not touch anything not described."

## Task 8 — Testing before production

**Unit tests added:** `groundingCheck.test.ts` (13), `cache.test.ts` (6),
`answerChatbotQuestion.test.ts` (7, merge logic), `answerChatbotQuestionCaching.test.ts`
(3, cache-key/invalidation against the real function).
**Integration tests added:** `liveData.integration.test.ts` (5),
`liveDataAnswering.integration.test.ts` (1), `rateLimitAuthenticatedChat.integration.test.ts` (3).
**Full suite: 18 files, 123 tests, 123 passing.** (Baseline before this pass: 11 files, 85 passing — all still pass unmodified except `errorHandler.test.ts`, updated to assert against the new logger instead of `console.error`, same behavior under test.)

### Load/stress test results (k6, real server, real Postgres + Redis — not mocked)

**Public widget endpoint**, 15 VUs, 20s burst, single chatbot (worst case — all
traffic sharing one rate-limit bucket):
- Run 1: 69,034 checks, 99.97% passed (20 anomalous — not reproduced on rerun), 0 responses ≥500, 34,517 requests, 1,724 req/s, p95 latency 15.07ms.
- Run 2 (rerun, explicit per-status breakdown): 27,447 requests, **100% were 200 or 429, zero unexpected statuses.**
- Server responded to `/health` normally immediately after both runs.

**Authenticated chat endpoint**, 10 VUs, 15s burst, single user:
- 13,702 requests, 27,404 checks, **100% passed** — every response was 200 or 429, every 429 carried a `Retry-After` header, zero 5xx. p95 latency 14.83ms overall; the small subset that actually reached the answering pipeline (rate-limit survivors) had p95 1.61s (real DB + cache-layer work), max 1.84s.

### Soak test (bounded — see caveat below)

150 seconds sustained load, 8 VUs, mixed across 10 distinct chatbots (avoids
one rate-limit bucket dominating), ~26 req/s:
- **3,939 requests, 0 failures, 0 checks failed, avg latency 3.83ms, p95 6.61ms.**
- **API process memory (RSS)**: 147MB baseline → grew to 250MB over the 150s load window → **plateaued at 247–250MB and slightly declined** over 75s of post-load idle monitoring (5 samples, 15s apart: 250.7 → 250.7 → 250.8 → 247.2 → 247.2 MB). Growth-then-plateau, not sustained unbounded growth — consistent with normal V8 heap/connection-pool warmup, not a leak, **in this observation window**.
- **Postgres connections**: stayed at 1–5 throughout (pool reused correctly, no connection leak).
- **Redis connected clients**: flat at 4 throughout (no connection leak).
- **Caveat, stated plainly**: this was a ~4-minute, single-machine test, not a multi-hour production soak. The memory plateau is a real, sampled signal, not a guess — but it does not rule out a slow leak with a longer time constant than this window could show. Recommend a longer soak (hours, under realistic traffic patterns, with an APM/heap-snapshot tool) before treating memory as fully cleared for production.

### BullMQ failure handling (real test, not just code inspection)

Enqueued a real crawl against `http://192.0.2.1/` (TEST-NET-1 — publicly
routable format, universally black-holed, so it genuinely times out rather
than getting SSRF-blocked instantly). Result:
- Job failed cleanly after the 8s static-fetch timeout: chatbot status went `queued` → `crawling` → `failed`, with a user-readable `statusReason`.
- `bull:crawl-queue:failed` set contained **exactly 1 entry** — no retry, no pile-up (`attempts: 1` in `src/lib/queue.ts`, confirmed empirically, not just by reading the code).
- The same `requestId` from the original `POST /chatbots` call appeared on every worker-process log line for this job — direct, verified proof of Task 6's end-to-end tracing claim.

---

## Manual verification (the exact scenario requested)

Run against the real server (not mocked), real Postgres/Redis, real OpenAI
key (`gpt-4o-mini`), a chatbot with unrelated crawled content ("Acme sells
outdoor camping gear including tents and backpacks."):

1. **"is the tent in stock right now?" before any live-data row** →
   `{"text":"I don't have that information here. Please check the website directly for current stock availability on tents.","aiGenerated":true}`
   — the relevance gate let it through (shares vocabulary with the crawled content) and the LLM correctly declined per `_SCOPE_GUARD`, rather than guessing. Graceful, as required.
2. **Added a live-data row** — `{"key":"Tent stock","value":"14 units in stock, ships same day"}`.
3. **Same question again** → `{"text":"Yes, there are 14 tents in stock right now, and they ship the same day.","aiGenerated":true}` in **2.033s** — correct, live-grounded, not stale/absent crawled text.
4. **Same question immediately again** → identical text in **0.117s** — served from the Task 4 cache (confirmed via server logs: `cacheEvent:"hit"` on both the `pages` and `answer` cache keys, same `requestId`-free but same cache-version-scoped keys as step 3).

All three behaved exactly as specified.

---

## What could NOT be completed safely in this pass

- **A true multi-hour production soak test** — not practical in this environment (see the Soak test caveat above). What was done is a real, bounded signal (no leak observed in ~4 minutes of load + idle monitoring), not a substitute for longer-horizon monitoring before full sign-off.
- **`npm audit`'s 6 findings** — not silently fixed. They're dev-toolchain-only (see Task 5), but `npm audit fix --force` (the only available fix) is a major-version `vitest` bump; left as a flagged follow-up rather than applied without explicit sign-off, per the task's own instruction not to silently upgrade majors.
- **README.md's stale Supabase-era documentation** — noticed while working through Task 7, but out of scope for the 8 tasks given ("do not touch anything not described"); flagged, not fixed.
- **Full LLM-decided tool-calling** — deliberately not built per Task 2's explicit instruction; the live-data lookup is a structured pre-fetch, not the model deciding when to query. Documented as a real, intentional gap in `IMPLEMENTATION_STATUS.md` §7.
- **The rate limiters' fail-closed behavior on a genuine Redis outage** (both the pre-existing public one and the new authenticated one) was noticed, not fixed — fixing the pre-existing public limiter's behavior wasn't part of the 8 tasks, and changing only the new one would make the two inconsistent for no clear benefit. Documented in `IMPLEMENTATION_STATUS.md` §7 rather than silently left unmentioned.
