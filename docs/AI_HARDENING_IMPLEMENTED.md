# ChatMate360 AI hardening — implemented changes

Date: September 25, 2026

This file records the AI usage, profitability, retrieval, concurrency, and
operational hardening implemented in this development pass. It describes
completed code, not proposed behavior.

For the broader architecture, proposed SLOs, risk register, capacity test plan,
and future roadmap, see `docs/PRODUCTION_READINESS.md`.

## 1. Shared account AI budget

Implemented in `src/services/usage.service.ts`.

- Day, week, and month AI-cost allowances are now shared across every chatbot
  and provider owned by one account.
- A customer can no longer multiply a plan allowance by switching between
  chatbots or between OpenAI, Claude, and Gemini.
- Existing per-chatbot/per-model limits remain as defense-in-depth boundaries
  and reporting dimensions.
- The platform-wide daily, weekly, and monthly ceilings remain enforced.
- Monthly model top-ups contribute to the account's monthly allowance while
  the model-specific top-up restriction remains in place.

This closes the Crawl Plus worst case where five chatbots and three providers
could previously multiply a `$5` allowance into `$75` of potential AI spend.

## 2. Adaptive, atomic cost reservations

Implemented in:

- `src/lib/aiPricing.ts`
- `src/lib/answerChatbotQuestion.ts`
- `src/services/usage.service.ts`
- `src/env.ts`

Completed behavior:

- The reservation amount is estimated from:
  - provider/model pricing;
  - estimated input tokens;
  - maximum output tokens;
  - possible tool-call rounds;
  - a configurable safety multiplier.
- Small calls use a configurable reservation floor.
- Calls estimated above the configured per-call maximum are rejected rather
  than admitted with an insufficient hold.
- A model without a configured price fails reservation safely instead of being
  treated as free.
- Gemini output is limited to 800 tokens, matching the bounded-output policy
  used by the other hosted providers.
- Platform, account, and chatbot/model counters are initialized and reserved
  atomically in Redis Lua.
- Missing Redis counters are seeded from PostgreSQL inside the same atomic
  reservation operation, preventing expiry/initialization races.
- A request-specific Redis marker makes reservation acquisition idempotent.
- If a Redis operation times out and completes late, an ordered token-specific
  release prevents an untracked budget hold.
- Successful attempts reconcile the estimated hold to actual token cost.
- Reservation infrastructure failures now fail closed.
- Durable PostgreSQL reservation rows still provide request idempotency,
  reconciliation history, and orphan detection.

New configuration:

```env
MIN_PER_CALL_COST_RESERVATION_USD=0.0005
PER_CALL_COST_RESERVATION_USD=0.05
RESERVATION_ESTIMATE_MULTIPLIER=1.25
```

`PER_CALL_COST_RESERVATION_USD` is now a safety maximum. It is not a flat charge
or a flat hold.

## 3. Distributed chatbot concurrency protection

Implemented in:

- `src/middleware/rateLimitPublic.ts`
- `src/routes/public.routes.ts`
- `src/env.ts`

Completed behavior:

- Every chatbot has a bounded number of active public chat requests.
- The concurrency control uses a Redis sorted-set semaphore and unique request
  tokens, so it works across multiple AWS API instances.
- Acquisition, expired-slot pruning, counting, and admission are atomic.
- Active requests refresh their slot with a heartbeat.
- A slow request cannot lose its slot merely because its original TTL elapsed.
- Releasing an old request removes only that request's token and cannot
  decrement a newer request's slot.
- A crashed process leaves a slot only until its TTL; the next acquisition
  also prunes expired tokens.
- Redis admission failures fail closed.
- Excess requests receive:

```text
HTTP 503
Retry-After: 2
```

Response body:

```json
{
  "ok": false,
  "error": "This chatbot is busy — please try again in a moment."
}
```

New configuration:

```env
PUBLIC_CHAT_MAX_CONCURRENT_PER_CHATBOT=10
PUBLIC_CHAT_CONCURRENCY_SLOT_TTL_SECONDS=45
```

The existing per-IP limits remain:

- normal public traffic: 20 messages per minute;
- unverified/mismatched referrer traffic: 5 messages per minute.

## 4. Context-aware follow-up retrieval

Implemented in `src/lib/answerChatbotQuestion.ts`.

- Ambiguous references such as “How much is it?” incorporate bounded recent
  user and assistant context when constructing the retrieval query.
- Self-contained short questions such as “What are your hours?” remain
  independent and are not contaminated by an older topic.
- The contextual retrieval query is used for document search, crawled-page
  ranking, and relevance checks.
- Contextual cache keys include the recent conversation context.
- The same vague question from two different visitors can no longer reuse an
  answer cached from the wrong conversation.
- Context included in retrieval is bounded to the last four messages and 500
  characters per message.

## 5. Safer document-vector retrieval

Implemented in:

- `src/services/documentIngestion.service.ts`
- `src/env.ts`

Completed behavior:

- Document lookup remains scoped by `chatbot_id`.
- Only chunks belonging to documents with `status = 'ready'` participate.
- pgvector cosine distance is returned and filtered.
- Chunks beyond the configured maximum distance are excluded instead of being
  injected into the prompt merely because they are the nearest available
  results.
- The number of returned chunks is configurable.

New configuration:

```env
DOCUMENT_RETRIEVAL_MAX_DISTANCE=0.65
DOCUMENT_RETRIEVAL_LIMIT=5
```

The threshold must still be calibrated against representative customer
documents before production launch.

## 6. Public-chat observability

Implemented in:

- `src/middleware/rateLimitPublic.ts`
- `src/controllers/public.controller.ts`
- `src/routes/public.routes.ts`

Structured events now include:

- `public-chat-completed`
  - chatbot ID;
  - HTTP status;
  - request latency;
  - normal finish versus client disconnect;
  - AI-generated versus fallback outcome when available;
  - gate reason when available.
- `public-chat-rate-limited`
- `public-chat-concurrency-rejected`
- `public-chat-concurrency-unavailable`

Observation middleware runs before the database requirement, rate limiter,
concurrency limiter, body validation, and controller. It therefore records
successful responses, validation failures, rate limits, busy responses,
database-unavailable responses, internal errors, and client disconnects.

Existing routing, reservation, usage, provider, grounding, and threshold logs
remain in place.

## 7. Configuration documentation

Updated `.env.example` with:

- adaptive reservation settings;
- per-chatbot concurrency settings;
- document retrieval settings;
- clarification that plan caps are shared account allowances.

Updated `tokenallocation.md` with a current-policy amendment explaining:

- the shared account budget;
- adaptive reservations;
- the relationship between account-wide and per-model controls.

## 8. Production-readiness specification

Added `docs/PRODUCTION_READINESS.md`, containing:

- component architecture diagram;
- document ingestion and retrieval diagram;
- provider failure sequence;
- quota reservation state machine;
- document lifecycle state machine;
- plan economics and boundaries;
- tenant-isolation checklist;
- proposed availability and latency SLOs;
- metrics, dashboard, and alert requirements;
- staged capacity/load-test procedure;
- severity-ranked risk register;
- prioritized delivery roadmap;
- architecture decision records for pgvector, USD-based metering, shared
  account budgets, and bounded concurrency.

Proposed SLOs and capacity values in that document are not production
commitments until validated by AWS load tests.

## 9. Tests added

Added `tests/unit/aiPolicy.test.ts`.

Coverage includes:

- ambiguous follow-up context;
- assistant context inclusion;
- self-contained short-question isolation;
- non-contextual question isolation;
- token-estimate inputs;
- adaptive reservation bounds;
- unknown model price failure.

Added `tests/integration/publicConcurrency.integration.test.ts`.

Coverage includes:

- expired crash-slot pruning;
- concurrent request rejection;
- `Retry-After`;
- slot release after normal completion;
- admission after capacity is released.

Extended `tests/integration/usageReservation.integration.test.ts`.

Coverage includes:

- one account allowance shared across different chatbots;
- switching providers does not bypass the account cap;
- existing concurrent atomic-cap behavior;
- actual-cost reconciliation;
- denial after recorded usage reaches the cap.

## 10. Verification completed

- TypeScript typecheck: passed.
- Final hardening regression set: 37/37 passed.
- Final focused atomic reservation/concurrency set: 12/12 passed.
- Answer/relevance regression set: passed.
- Patch whitespace validation: passed.
- Independent correctness review: no remaining high-severity issue found in
  the scoped changes after fixes.

A complete test-suite run produced:

```text
386 passed
2 failed
```

The two failures are existing Stripe environment-isolation tests. They expect
Stripe to be unconfigured, but the real local `.env` contains Stripe test
credentials. They are unrelated to the AI hardening changes.

The repository lint command still reports three pre-existing errors:

- TypeScript namespace rule in `src/middleware/requestId.ts`;
- TypeScript namespace rule in `src/middleware/requireAdminAuth.ts`;
- `prefer-const` in `src/services/otp.service.ts`.

No new lint finding was introduced by this hardening work.

## 11. AWS deployment configuration

Set these values explicitly on the AWS backend rather than relying on defaults:

```env
MIN_PER_CALL_COST_RESERVATION_USD=0.0005
PER_CALL_COST_RESERVATION_USD=0.05
RESERVATION_ESTIMATE_MULTIPLIER=1.25

PUBLIC_CHAT_MAX_CONCURRENT_PER_CHATBOT=10
PUBLIC_CHAT_CONCURRENCY_SLOT_TTL_SECONDS=45

DOCUMENT_RETRIEVAL_MAX_DISTANCE=0.65
DOCUMENT_RETRIEVAL_LIMIT=5
```

Also verify the existing production values:

```env
FREE_PLAN_MONTHLY_COST_CAP_USD=0.50
FREE_PLAN_WEEKLY_COST_CAP_USD=0.15
FREE_PLAN_DAILY_COST_CAP_USD=0.05

CRAWL_PLUS_PLAN_MONTHLY_COST_CAP_USD=5
CRAWL_PLUS_PLAN_WEEKLY_COST_CAP_USD=1.50
CRAWL_PLUS_PLAN_DAILY_COST_CAP_USD=0.50

FULL_CUSTOM_PLAN_MONTHLY_COST_CAP_USD=150
FULL_CUSTOM_PLAN_WEEKLY_COST_CAP_USD=50
FULL_CUSTOM_PLAN_DAILY_COST_CAP_USD=15

PLATFORM_MONTHLY_COST_CAP_USD=500
PLATFORM_WEEKLY_COST_CAP_USD=115
PLATFORM_DAILY_COST_CAP_USD=20
```

No database migration was added or required by this hardening pass.

## 12. Not claimed as completed

The following require production infrastructure, business decisions, or a
separate security engagement and are therefore not falsely marked complete:

- AWS production load and stress testing;
- measured average/P95 customer cost distribution;
- provider-price verification at launch time;
- retrieval-threshold calibration with labelled customer questions;
- production dashboards and alert rules in the selected monitoring service;
- dedicated security review and penetration test;
- provider circuit breakers;
- moving document ingestion to an asynchronous worker;
- customer-facing/admin pricing-calculator page in the ChatMate360 frontend;
- real session-expiry or per-visitor lifetime message policy;
- implementation of `ROUTE_TO_CHEAPER_MODEL` and metered overage billing.

The interactive engineering calculator created for planning is available in
the Cursor canvas:

```text
C:\Users\zainr\.cursor\projects\c-Users-zainr-Downloads-test\canvases\chatmate360-usage-pricing.canvas.tsx
```
