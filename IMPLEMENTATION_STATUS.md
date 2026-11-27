# ChatMate360 — Implementation Status

_Last updated: 2026-09-19_

> **2026-09-19 session update:** For OTP verification, password-reset hardening, Stripe Checkout UX (success polling + `/billing/checkout` alias), Google OAuth env alignment, and OpenAI-first model selection, read the workspace root file first:
>
> **`C:\Users\zainr\Downloads\test\CHATMATE360_SESSION_UPDATE.md`**
>
> That file is the authoritative “what was built in recent sessions” snapshot for those topics. Sections below remain useful historical inventory but may lag on those areas.

_Previously: 2026-09-18 (§24 added — document ingestion, daily/weekly usage caps, persisted trial deactivation, widget verification)_

> **Correction note (2026-08-27):** this document was found to be stale in
> two places during a production-hardening audit — the crawler had already
> moved to a real background-job queue (BullMQ), and public-widget rate
> limiting had already been built, but §3/§5/§7 below still described both as
> not done. Both are corrected in place below, and a new §8 covers the
> hardening pass itself. Lesson: this file is a snapshot from whenever it was
> last hand-edited, not something re-derived from the code — treat it as a
> lead list to verify against source, the way the audit that caught this did,
> not as ground truth on its own.

This document tracks what has actually been built in this session, across both
`Chatmate360-Backend-main` (Express/Node) and `Chatmate360-main` (Next.js).
It reflects real, working code — not the product's original architecture doc.

---

## 0. Recent session pointer (2026-09-19)

See **`../../CHATMATE360_SESSION_UPDATE.md`** (workspace `test\` root) for:

- Purpose-based email OTP (`/auth/otp/send`, `/auth/otp/verify`, table `auth_otps`)
- Password routes `/auth/password/forgot` + `/reset` with `used_at`
- Stripe: hosted Checkout, webhook-owned activation, billing panel polling
- Google OAuth: `GOOGLE_REDIRECT_URI=http://localhost:4000/auth/google/callback`
- OpenAI-first `MODEL_PRIORITY_ORDER`

## 1. Database: full migration off Supabase to plain PostgreSQL

The backend previously depended on Supabase (auth + a handful of edge functions,
no real tables). It now runs on a self-hosted Postgres instance with a hand-written
schema and no Supabase dependency anywhere.

- **Schema** (`db/schema.sql`):
  - `users` — id, email, password_hash, google_id, name. Check constraint requires
    at least one login method (password or Google).
  - `chatbots` — one per user (unique constraint), `sources` and `theme` as `jsonb`,
    `allowed_domain` for widget origin checks.
  - `refresh_tokens` — hashed, per-session, supports rotation and revocation.
  - `waitlist`, `trial_signups`, `contact_submissions` — carried over from the
    original marketing-site forms.
- **Access layer**: `src/lib/db.ts` — a `pg` connection pool, `null` when
  `DATABASE_URL` isn't configured (`hasDatabase` feature flag).
- **Local dev**: `docker-compose.yml` runs Postgres on host port **5435**
  (5432 and 5433 were both occupied by pre-existing native Postgres instances
  on this machine).
- All Supabase-specific code (`middleware/supabase.ts`, the old auth-callback
  shape) has been deleted, not just bypassed.

## 2. Authentication

Real, revocable session auth — no Supabase Auth involved.

- **Password auth**: bcrypt hashing (12 rounds), Zod-validated signup/login
  (`src/validators/auth.validator.ts`, `src/services/auth.service.ts`).
- **Sessions**: short-lived JWT access tokens + opaque, hashed (sha256) refresh
  tokens stored in `refresh_tokens`, rotated on every use. Access tokens carry
  a `typ: "access"` claim so a refresh token can't be replayed as an access token.
- **Routes** (`src/routes/auth.routes.ts`):
  `POST /auth/signup`, `POST /auth/login`, `GET /auth/me`, `POST /auth/refresh`,
  `POST /auth/logout`.
- **Google OAuth** (`POST /auth/google`, `GET /auth/google/callback`):
  - Full authorization-code flow: builds the Google consent URL with a
    CSRF-protected, signed, short-lived (600s) `state` JWT
    (`signOAuthState`/`verifyOAuthState` in `src/lib/auth.ts`).
  - Callback is a `GET` handler (Google redirects the browser directly) that
    exchanges the code, fetches the Google profile, finds-or-creates a user
    (matches by `google_id`, falls back to linking an existing account by
    email), issues a session, and **redirects** to
    `${FRONTEND_URL}/auth/callback#access_token=...&refresh_token=...` —
    tokens in the URL hash, not a JSON body, since this is a full-page
    navigation, not an API call.
  - Errors redirect to `/auth/callback?error_description=...` so the frontend
    shows a real error screen instead of a raw JSON dump.
  - **Status**: fully implemented; requires the exact redirect URI
    (`http://localhost:4000/auth/google/callback`) to be registered in Google
    Cloud Console under the OAuth client's Authorized redirect URIs — this is
    an account-side setup step, not code, and was the source of the most
    recent `redirect_uri_mismatch` error.
- **SSO (SAML/OIDC enterprise federation)**: **not implemented.** Discussed
  three options (generic OIDC, hand-rolled SAML, or a vendor like
  WorkOS/Auth0); no direction chosen yet. Current SSO button in the UI (if
  any) is a placeholder only.

## 3. Web crawler (`src/lib/crawler/`)

Ported and hardened from the `aichatbot` project's worker crawler.

- `ssrf.ts` — blocks requests to private/internal IP ranges, re-resolves DNS
  per redirect hop so a hostname can't rebind to an internal address mid-crawl.
- `safeFetch.ts` — redirect-safe, byte-capped (`MAX_RESPONSE_BYTES`, 3MB) fetch
  wrapper, SSRF-checked on every hop.
- `sitemap.ts` — parses `sitemap.xml` / sitemap indexes via Cheerio's XML mode
  (immune to XXE by parser choice), one-hop cap on child-sitemap fetching.
- `robots.ts` — practical `robots.txt` subset parser, longest-match-wins rule
  resolution.
- `renderPage.ts` — Playwright headless Chromium fallback for JS-rendered SPAs.
  Browser instance is memoized (promise-holder pattern, race-safe under
  concurrency) and reused for the process lifetime.
- `crawl.ts` — bounded BFS crawl: `MAX_PAGES=12`, `MAX_DEPTH=3`,
  `CONCURRENCY=3`, `STATIC_FETCH_TIMEOUT_MS=8000`, `RENDER_TIMEOUT_MS=15000`,
  `MAX_TEXT_PER_PAGE=6000`. Tries a static fetch first; escalates to
  `renderPage` only when the static HTML looks like an unhydrated JS shell
  (`looksLikeJsShell()` heuristic).
- **Runs as a real background job, not in-request**: `POST /chatbots` enqueues
  via `src/lib/queue.ts` (BullMQ) and returns immediately; the crawl itself
  runs in `src/worker.ts`, a separate process/concurrency-3 worker. *(This
  corrects the previous version of this doc, which still described the crawl
  as synchronous-in-request — that was accurate at an earlier point but not
  by the time this line was written.)*
- **Verified working** against a real JS-rendered site
  (`zararportfolio.netlify.app`) — real content extraction in ~7s.

## 4. AI answering (`src/lib/ai.ts`, `src/lib/answerChatbotQuestion.ts`)

- **Provider fallback chain**: Claude → OpenAI → Gemini → Ollama, each wrapped
  in a timeout (`withTimeout`, `env.aiRequestTimeoutMs`).
- **Model**: OpenAI provider uses `gpt-4o-mini` (real API key configured), per
  explicit instruction to use a GPT mini model.
- **Grounding / anti-hallucination guardrails**:
  - `_SYSTEM_PREAMBLE`, `_INJECTION_GUARD`, `_SCOPE_GUARD` — ported from
    `aichatbot`.
  - `_GROUNDING_GUARD` (new) — explicitly forbids rounding, averaging,
    estimating, or inferring any specific checkable detail (price, date,
    name, email, phone number, policy term) not verbatim in the page content.
  - `GROUNDED_TEMPERATURE = 0.3` applied across all four providers for
    factual consistency.
  - `MAX_CONTEXT_CHARS` raised from 60,000 → 100,000 to fit the crawler's real
    max output (~72,000 chars).
- **Orchestration** (`answerChatbotQuestion.ts`): filters chatbot sources down
  to ones with real crawled `.content`, tries the AI chain first, and only
  falls back to the old keyword matcher (`answerFromSources.ts`) if no AI
  provider is configured/available.
- **Verified working**: real, accurate answers grounded in real crawled
  content (previously returned fake template text).

## 5. Chatbot creation, theming, and embedding

- **Real crawl on creation** (`src/services/chatbot.service.ts`,
  `crawlWebsiteForChatbot`) — replaces the old stub that just estimated
  character counts.
- **Theming**: `ChatbotTheme` (`primaryColor`, `bgColor`, `textColor`),
  customizable per chatbot, stored as `jsonb`.
- **Domain authorization for the embedded widget**:
  - Bug found and fixed: checking `req.headers.origin` is architecturally
    wrong, because the widget iframe always shares the SaaS's own origin —
    never the customer's embedding page's origin.
  - Fix: `embed.js` (runs in the customer's real page context) forwards
    `window.location.origin` as a `parentOrigin` query param → the widget page
    sends it as an `X-Widget-Origin` header → the backend checks that header
    (`src/lib/originAllowed.ts`, `src/services/public.service.ts`,
    `authorizePublicRequest`).
  - Explicitly documented as a **client-supplied, spoofable signal** — not a
    hard security boundary. The actual abuse control is Redis-backed rate
    limiting (`src/middleware/rateLimitPublic.ts`), keyed by chatbot+IP, with
    a stricter tier when the (harder-to-spoof) Referer header doesn't
    corroborate the claimed origin. *(This corrects the previous version of
    this doc, which still listed rate limiting as not yet built — see §8.)*
  - **Note**: the same architectural bug is still present, unfixed, in the
    original `aichatbot` project.
- **Embed panel** (frontend, `components/dashboard/embed-panel.tsx`): color
  pickers, allowed-domain field, live-generated `<script>` embed snippet with
  a copy button.
- **Dashboard preview chat**: authenticated `chatWithOwnChatbot` uses the same
  `answerChatbotQuestion` engine as the public widget (`POST /chatbots/chat`).

## 6. Frontend fixes

- **Stale-cache navigation bug** ("Create a chatbot first" shown despite a
  visible chat UI): both `dashboard-shell.tsx` and `create-chatbot.tsx` were
  trusting a stale `localStorage`-cached chatbot over the server's `/auth/me`
  response. Fixed to treat the server response as authoritative; redirects to
  `/onboarding` only when the server confirms no chatbot exists.
- **Google OAuth callback page** (`components/auth/auth-callback.tsx`):
  rewritten — no longer POSTs anything to "complete" sign-in (that flow no
  longer exists); reads `access_token`/`refresh_token`/`expires_at` straight
  from the URL hash, saves them, then calls `GET /auth/me` for the profile.
- **Hydration warning fix**: `suppressHydrationWarning` added to `<html>`/
  `<body>` in `app/layout.tsx` — the warning was caused by a browser
  extension ("Liner") injecting DOM attributes, not a real app bug.

## 7. Known gaps / explicitly deferred

- **SSO** (SAML/OIDC enterprise identity federation) — discussed, not built.
  Decision on approach (generic OIDC vs. SAML vs. WorkOS/Auth0) still open.
- **PDF/Word chatbot sources** — still only get a size *estimate*, not real
  extracted text. Out of scope for the crawler-integration pass and for §8.
- **Domain-origin check in `aichatbot`** — same class of bug as the one fixed
  here for ChatMate360, not yet backported (`aichatbot` is a separate,
  predecessor project, not part of this repo).
- **End-to-end Google OAuth browser test** — not completed; requires signing
  in with a real Google account, which is outside what I can do directly.
  Most recent blocker was a `redirect_uri_mismatch` (Google Cloud Console
  redirect URI not yet registered to match the backend's callback URL
  exactly) — guidance given, not yet confirmed fixed.
- ~~**Full tool-calling (LLM-decided live-data lookups)** — §8 adds a
  structured *pre-fetch* of live data, not true function-calling; the LLM
  never decides when to query it.~~ **Closed in §9** (Custom Actions,
  2026-09-07) — real `tools`/function-calling for Claude and OpenAI, the LLM
  decides when to call. §8's live-data pre-fetch is unchanged and still the
  right tool for facts the owner just wants always-present, not something
  worth an extra round trip to fetch conditionally.
- **Answer-cache key ignores conversation history** — by design (see §8) — a
  cached answer can be served for a repeat question even if the caller's
  `history` differs. Acceptable for the cost savings intended, but worth
  knowing if a chatbot ever needs history-sensitive answers to the exact same
  question.
- **Rate limiters fail closed on a Redis outage** — both the public and
  authenticated chat rate limiters (`rate-limiter-flexible`) treat *any*
  rejection from `.consume()`, including a genuine Redis connection failure,
  the same as "limit exceeded" → 429. A Redis outage would 429 all chat
  traffic rather than fail open. Pre-existing behavior in the public limiter,
  carried into the new authenticated one for consistency (§8) rather than
  fixed, since fixing it wasn't in scope for this pass.
  **(Corrected in a later pass: this is no longer true. All five rate
  limiters — including these two — now fail OPEN on a Redis/infra error via
  one shared `consumeOrFailOpen` helper (`src/middleware/rateLimitShared.ts`),
  and `rateLimitAdminLogin.ts`/`rateLimitPublicAttachment.ts` additionally
  fall back to an in-memory `insuranceLimiter` rather than no limiting at
  all. See `src/middleware/README.md`'s "Rate limiting" section for the
  current behavior and `tests/unit/rateLimitFailOpen.test.ts` /
  `rateLimitInsuranceLimiter.test.ts` for the tests. This entry is left in
  place as a historical record of what was true when this section was
  written, not a current description.)**
- **Grounding check is regex-based, not exhaustive** — the Task 3 (§8)
  post-generation check catches price/date/phone/email-shaped claims, not
  every possible fabricated fact (e.g. an invented product name or an
  invented policy term with no digits/`@` in it passes through unchecked).
  It's a second line of defense on top of the prompt-level guard, not a
  complete grounding guarantee — see `tests/unit/groundingCheck.test.ts`'s
  last test for a documented example (a fabricated claim is only caught if
  it's absent from context; if the *context itself* is poisoned via prompt
  injection, this check can't tell the difference).
- **npm audit**: 6 vulnerabilities (3 moderate, 1 high, 2 critical), all in
  the `vitest`/`vite`/`esbuild` dev-time test toolchain (devDependencies
  only — nothing in the production dependency tree). The fix requires
  `npm audit fix --force`, which bumps `vitest` to a new major version — not
  applied in this pass per "don't silently upgrade majors"; flagged for a
  deliberate follow-up instead. See §8's final report for detail.
## 8. Production-hardening pass (2026-08-27)

Full detail, evidence, and load/soak numbers in the session's own final
report; summary here for anyone scanning this file.

- **Authenticated chat rate limiting**: `POST /chatbots/chat` now rate
  limited per user_id (`src/middleware/rateLimitAuthenticatedChat.ts`,
  `AUTHENTICATED_CHAT_RATE_LIMIT_PER_MIN`, default 30/min), reusing the
  existing shared Redis connection. 429s carry a `Retry-After` header and
  body field.
- **Live-data (`chatbot_live_data` table + CRUD)**: generic per-chatbot
  key-value store (`db/schema.sql`), owner-scoped CRUD at
  `/chatbots/live-data[/:id]` (`src/services/liveData.service.ts` — every
  read/write re-derives the caller's own chatbot_id from their token, never
  trusts a client-supplied id alone). Merged into the answering pipeline
  (`src/lib/answerChatbotQuestion.ts`) ahead of crawled content, both tagged
  and both prompted (`src/lib/ai.ts`) as two tiers — live data wins on
  conflict. No provider-level tool-calling yet (see §7).
- **Grounding — code-level second check**: `src/lib/groundingCheck.ts`
  regex-matches price/date/phone/email-shaped claims in the AI's answer
  against the actual merged context; a claim that doesn't appear gets the
  whole answer swapped for the fixed fallback, logged as a
  `grounding-check-failed` event. Not a second LLM call — negligible latency.
- **Caching**: `src/lib/cache.ts` — Redis-backed, per-chatbot cache-version
  key bumped on live-data writes and on crawl completion (so a data change
  naturally invalidates old entries). Caches: the final answer, the
  relevance-gate result, and the `sourcesToPages()` assembly — all TTLs
  env-configurable. A grounding-check failure is never cached.
- **Structured logging**: `src/lib/logger.ts` (pino) replaces every
  `console.*` call in the backend (embed.js, which runs in the customer's
  browser, is out of scope). Every request gets an id
  (`src/middleware/requestId.ts`) propagated via `AsyncLocalStorage`
  (`src/lib/requestContext.ts`) into every log line for that request,
  including across the BullMQ queue → worker boundary (a crawl job carries
  the enqueueing request's id) — verified live: a single `requestId` traced
  a real crawl job from `POST /chatbots` through `crawling` → `failed`.
  Chat message bodies are never logged at info level (a hashed
  ref + length only); the full text is debug-only, and never present at all
  when `NODE_ENV=production`, regardless of log level.
- **Security**: `helmet` added; CORS confirmed already an explicit allowlist
  (`env.frontendUrl`), not a wildcard. Every chatbot-scoped route (live-data
  CRUD, theme/domain/fallback settings, chat) derives ownership from the
  caller's access token, never from a client-supplied id — verified by a new
  integration test that a second user gets 404s (not 403s, to avoid
  existence-probing) trying to read/modify the first user's live-data rows.
  `.env.example`/`.env.test.example` confirmed placeholder-only. Widget
  origin check and its strict-rate-limit-on-mismatch behavior confirmed
  unchanged. `npm audit`: see §7.
- **Testing**: `tests/unit/groundingCheck.test.ts`,
  `tests/unit/cache.test.ts`, `tests/unit/answerChatbotQuestion.test.ts`,
  `tests/unit/answerChatbotQuestionCaching.test.ts`,
  `tests/integration/liveData.integration.test.ts`,
  `tests/integration/liveDataAnswering.integration.test.ts`,
  `tests/integration/rateLimitAuthenticatedChat.integration.test.ts` added.
  Full suite: 123/123 passing. ESLint added (`eslint.config.mjs`,
  `npm run lint`) — zero violations across the whole codebase.
- **Load/soak testing (k6)**: public and authenticated chat endpoints both
  confirmed to degrade to clean 429s under sustained multi-VU load, never a
  5xx or a hang; a 2.5-minute sustained-load soak (8 VUs, ~3,900 requests,
  mixed across 10 chatbots) showed 0 errors, p95 6.6ms, memory rising during
  load then plateauing (not climbing) once load stopped — no leak signal in
  the observed window, though this was a bounded, single-machine test, not a
  multi-hour production soak. BullMQ confirmed to fail a timed-out crawl
  cleanly (1 failed job, no retry, no pile-up) rather than retrying forever.

## 9. Custom Actions — real LLM tool-calling (2026-09-07)

**This closes the "Full tool-calling (LLM-decided live-data lookups)" gap
called out in §7 and referenced in §8's live-data entry** — §8 gave the
chatbot a structured *pre-fetch* of owner-set facts; this pass gives it a
real, LLM-decided `tools` call to the owner's own backend mid-conversation.
It is a separate, additive capability built on top of §8's live-data work,
not a replacement or a duplicate of it — a chatbot can have live-data
entries, actions, or both.

Two things had to be built that this task assumed already existed and did
not: a `chatbot_integrations` credential table, and any backend-link
infrastructure at all. Verified by reading `db/schema.sql`, git log, and
this repo's own `phas1.md` audit (§4: "Backend / Live-Data Access — ❌ Not
implemented") before starting — both are built here, scoped to exactly what
Custom Actions needs.

- **Data model** (`db/schema.sql`): `chatbot_integrations` (one encrypted
  API key per chatbot) and `chatbot_actions` (`name`, `description`,
  `http_method`, `url_template`, `headers_template` jsonb, `body_template`
  jsonb, `parameters` jsonb, plus a `chatbot_actions_name_format` check
  constraint and a unique `(chatbot_id, name)` index). `parameters` isn't in
  the task's literal column list but is required for the tool's typed input
  schema — added and called out here rather than silently included.
- **Encryption**: `src/lib/crypto.ts` — AES-256-GCM, `INTEGRATION_ENCRYPTION_KEY`
  (32-byte hex, `hasIntegrationEncryption` flag in `src/env.ts`). The
  decrypted key is returned by exactly one function,
  `getDecryptedApiKeyForChatbot` (`src/services/integration.service.ts:82-92`),
  called only from the answering pipeline, never by any route handler — no
  API response ever includes it, verified by
  `tests/integration/actions.integration.test.ts`'s
  "never returns the API key itself" test.
- **Owner-scoped CRUD**: `src/services/actions.service.ts` and
  `src/services/integration.service.ts`, same
  re-derive-chatbot-from-token-never-from-client discipline as
  `liveData.service.ts`. Routes at `/chatbots/actions[/:id]` and
  `/chatbots/integration` (`src/routes/chatbot.routes.ts:66-90`). A
  cross-user ownership test (`actions.integration.test.ts`) confirms a
  second user gets 404s, not 403s, on another owner's action id.
- **Real tool-calling** (`src/lib/ai.ts:141-338`): `answerWithClaude` and
  `answerWithOpenAI` (the two providers here that support it — both hit
  their raw REST APIs directly, no SDK, matching this file's existing
  style) now run a bounded loop: send `tools` built from the chatbot's
  actions, execute any `tool_use`/`tool_calls` the model returns via
  `src/lib/actionExecutor.ts`, feed the result back, repeat. `MAX_TOOL_CALLS
  = 3` (`ai.ts:126`) caps total executions per turn — verified by
  `tests/unit/aiToolCalling.test.ts`'s "caps tool calls" test (a model that
  never stops asking still only fires 3 real executions). Gemini/Ollama are
  untouched — they answer without tool access, same as before.
- **Execution safety** (`src/lib/actionExecutor.ts`): parameter validation
  (type + required-ness) before any HTTP call; the *same* `assertSafeUrl`
  the crawler uses (`lib/crawler/ssrf.ts`) on the filled URL; a 4s timeout,
  zero retries; any failure (SSRF block, timeout, non-2xx) collapses to one
  fixed "This action is currently unavailable." tool result — the model is
  never left to improvise about what happened. Every call logged
  (`tool`, `isError`, `latencyMs`) via the existing structured logger.
- **Grounding fix (a real bug caught before it shipped)**: the existing
  post-generation grounding check (`groundingCheck.ts`) verifies specific
  claims (price/date/phone/email-shaped) against crawled+live-data text
  only. A tool result (e.g. a real ship date from the owner's own API) isn't
  in that text, so an accurate tool-grounded answer would have been wrongly
  swapped for the fallback message. Fixed by threading a `toolResultSink`
  side-channel (`ai.ts:118,224,336` / `answerChatbotQuestion.ts`) that
  captures every *successful* tool result's content into the grounding
  context — caught and fixed during this pass, not left as a known gap.
  Covered by `aiToolCalling.test.ts`'s first test.
- **Relevance-gate fix**: same class of issue — the deterministic
  keyword-overlap pre-filter (`relevance.ts`) only ever saw crawled/live
  text, so a question an action could answer ("track my order #1234") but
  that shares no vocabulary with the site's crawled content would have been
  silently fallback-answered without ever reaching the LLM or its tools.
  Fixed via `actionRelevancePages()` (`answerChatbotQuestion.ts`), which
  feeds each action's own name/description into the relevance check only
  (never into the actual LLM context — that's what the `tools` schema is
  for).
- **Dashboard UI**: `Chatmate360-main/components/dashboard/actions-panel.tsx`
  — list/create/edit/delete, a backend-connection sub-panel for the API key,
  and 5 prebuilt templates across the 3 target verticals
  (`check_order_status`, `check_stock` — ecommerce; `check_availability`,
  `get_listing_details` — property; `check_inventory` — store management),
  matching `embed-panel.tsx`'s structure/styling exactly (no separate
  live-data panel existed in the frontend to mirror — it was built on the
  backend in §8 but never wired into the dashboard UI; flagged here as a
  pre-existing gap this pass didn't touch). Wired into
  `dashboard-shell.tsx` next to `EmbedPanel`. Manually verified end-to-end
  in a real browser: signup → onboarding → dashboard → picked the
  `check_order_status` template → saved → appeared in the list with correct
  name/method/description/URL.
- **Testing**: `tests/unit/actionExecutor.test.ts` (parameter validation
  rejects missing/wrong-typed args before any HTTP call; SSRF blocks a
  private-IP and a cloud-metadata-IP action URL the same way the crawler's
  own SSRF test does; header/URL template filling; owner API key sent as
  bearer unless the action sets its own `Authorization`), `tests/unit/aiToolCalling.test.ts`
  (a real tool-call round trip via mocked fetch produces a grounded final
  answer; a failing tool call produces the graceful "unavailable" message,
  never a fabricated answer; the 3-call cap), `tests/integration/actions.integration.test.ts`
  (CRUD, name-format validation, duplicate-name 409, cross-user ownership,
  integration-key status never leaking the raw key). Full suite run against
  a real local Postgres + Redis (this repo's own `docker-compose.yml`):
  **143/143 passing**, including one pre-existing test
  (`answerChatbotQuestionCaching.test.ts`) that had to be updated to mock
  `getActionsForAnswering` — it deliberately uses synthetic non-UUID
  chatbot ids and was never meant to touch Postgres; this pass added the
  first unconditional DB read inside `answerChatbotQuestion()`, which broke
  that test's isolation until mocked out, same pattern the file already
  used for `lib/ai.js`.

**Gaps, called out rather than silently assumed away:**
- **No plan/billing gating.** The task asked to gate Actions behind a paid
  tier "if that matches the product's intended pricing" — no Stripe
  entitlement system, plan table, or pricing model exists anywhere in this
  codebase (confirmed by repo-wide search before starting). Actions ship
  ungated. Per-call `tool` events are logged with enough detail
  (chatbot/action/latency/success) to build metering on top of later, but
  no metering or quota enforcement exists yet.
- **Zero-crawled-pages chatbots can't use actions yet.**
  `answerChatbotQuestion()`'s existing `pages.length === 0` branch
  (pre-dates this pass) returns the plain fallback before ever reaching the
  AI/tools path — an actions-only chatbot with nothing crawled has no way to
  use its actions today. Noted in-line at the call site
  (`answerChatbotQuestion.ts`, just above that branch) rather than fixed,
  since redesigning that gate wasn't in this task's scope.
- **A shared-infrastructure Redis issue was found during manual
  verification, unrelated to this feature's code**: the local `.env`'s
  `REDIS_URL` (Upstash) returned `max requests limit exceeded` mid-session —
  that account's free-tier monthly request quota is exhausted. Since the
  same credential is very likely what backs the production Railway
  services (per this repo's own `DEPLOYMENT.md` recommending Upstash), this
  is a strong candidate root cause for the previously-reported "crawler not
  working" issue across multiple production chatbots — a BullMQ worker or
  queue that can't reach Redis at all looks identical to one that's simply
  never consuming jobs. Not something this pass can fix (it's an account
  quota, not a code issue) — needs a plan upgrade or a fresh Redis instance
  on the production side.

## 10. Stripe Billing, backend-link read tier, and token-based metering (2026-09-07)

Three previously-open architecture questions, each with the decision
already made going into this pass (Stripe Checkout, not manual billing;
user-supplied `api_base_url` + key, not a webhook-based push model; real
token/cost metering, not a conversation-count cap) — implemented in the
order given.

### Task 1 — Stripe Billing

- **`subscriptions` table** (`db/schema.sql`): `user_id` (unique — one
  subscription per user), `stripe_customer_id`, `stripe_subscription_id`,
  `plan` (`free`/`starter`/`growth`/`business` — matching the tier names on
  the actual pricing page, `Chatmate360-main/lib/data.ts:121-148`, not
  invented names), `status`, `current_period_end`, with check constraints on
  both `plan` and `status`.
- **Stripe SDK wiring** (`src/lib/stripe.ts`): lazy client construction
  (`stripeClient()`, line 14) gated by `hasStripe` (`src/env.ts`) — a clean
  503 until both `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are set, no
  apiVersion pin (uses the Stripe account's own dashboard-configured
  default rather than a hardcoded string this code could drift against).
  `priceIdForPlan`/`planForPriceId` (lines 31, 48) map plan tiers to/from
  Stripe Price ids via `STRIPE_PRICE_STARTER`/`_GROWTH`/`_BUSINESS` env
  vars — **no real Stripe account, so no actual Price ids exist yet**; see
  Gaps below.
- **Hosted Checkout** (`src/services/billing.service.ts:67-83`,
  `createCheckoutSession`): `mode: "subscription"`, redirect flow (Stripe's
  own hosted page, no card data ever touches this backend), plan carried on
  both the session and the resulting subscription's metadata so
  `checkout.session.completed` can resolve which tier this was for without
  guessing from the price id alone. Route: `POST /billing/checkout-session`
  (`src/routes/billing.routes.ts:15`), authenticated.
- **Webhook** (`POST /webhooks/stripe`, mounted directly in `src/app.ts:71`
  — deliberately ahead of the global `express.json()` at line 73, with its
  own `express.raw()`, since Stripe's signature is computed over the exact
  request bytes and would never verify against a re-serialized JSON body).
  Signature verification (`verifyStripeWebhookSignature`,
  `billing.service.ts:170`) is a hard separate step from event processing
  (`processStripeWebhookEvent`, line 174) — an unverified payload is never
  processed (a bad/missing signature is a 400), and a verified-but-failed-
  to-handle event is a 500 (so Stripe's own retry schedule tries again),
  never conflated into one catch block. Handles
  `checkout.session.completed`, `customer.subscription.updated`,
  `customer.subscription.deleted`, `invoice.payment_failed` — the four
  required at minimum. `src/controllers/billing.controller.ts` also 503s
  up front if Stripe isn't configured at all, rather than letting a stray
  webhook ping fall through to a misleading "signature invalid" 400.
- **Entitlement gating**: `getEntitlementForChatbot`/`getEntitlementForUser`
  (`billing.service.ts:227, 243`) are the single source of truth — a
  chatbot's plan is "free" unless its owner's subscription status is
  `active` or `trialing` (a lapsed/`canceled`/`past_due` subscription
  reverts to free-tier limits, not whatever plan it used to be). This is
  what Task 3's cost cap reads from (see below); Custom Actions is **not**
  gated behind it in this pass — see Gaps.
- **No custom proration/tax/dunning logic** — Stripe's own dashboard and
  hosted checkout own all of that, per the explicit instruction; this app
  only reads webhook state back into `subscriptions`.
- **Testing**: `tests/integration/billing.integration.test.ts` (webhook
  event processing against a real test-DB `subscriptions` row for all four
  event types, `stripeClient()` mocked so no real Stripe account is
  needed), `tests/integration/billingWebhookRoute.integration.test.ts`
  (route-level: 503 when unconfigured rather than a misleading signature
  error, 401 without auth, 400 on an invalid plan value).

**Gap, explicitly flagged, not silently skipped: the manual end-to-end
verification this task asked for ("complete a real Stripe test-mode
checkout end to end") could not be completed in this pass.** It requires a
real Stripe account: a live `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`
(test mode) and three real subscription Prices created in that account for
`STRIPE_PRICE_STARTER`/`_GROWTH`/`_BUSINESS`. None of that exists in this
environment and isn't something that can be generated — it needs a person
with dashboard access to Stripe. Everything on the code side is built and
unit/integration-tested against Stripe's documented API shapes; the actual
hosted-checkout round trip and live webhook delivery are unverified. Also
not done, and out of scope unless/until Task 1's entitlements are meant to
gate it: **Custom Actions (§9) still ships with no plan check** — the
infrastructure to gate it now exists (`getEntitlementForChatbot`), but
wiring it in wasn't part of this task's three sections and would be scope
creep against the "don't touch anything outside what's described"
instruction. Flagged as the natural next step.

### Task 2 — Backend link for live data (read-only Phase 1)

- **Contract spec**: `docs/BACKEND_INTEGRATION_CONTRACT.md` — full
  read/write contract, versioned (`contract_version`, currently always
  `"v1"`), generic naming ("product" maps to room/listing/SKU depending on
  vertical) so one contract serves all three target verticals. READ
  (`GET {base_url}/products`, `GET {base_url}/products/{id}/availability`)
  is implemented now; WRITE (`POST {base_url}/bookings`,
  `POST {base_url}/reservations`) is specified in full (request/response
  shapes, error format) but never called anywhere in this codebase — a
  deliberate Phase 1/2 split, not a shortcut.
- **Schema**: `chatbot_integrations` (the same one-per-chatbot table §9
  built for Custom Actions, reused rather than duplicated per the explicit
  instruction) gains `api_base_url` and `contract_version` columns
  (`db/schema.sql`). The Custom Actions and backend-link features now share
  one credential row per chatbot.
- **Owner-scoped CRUD**: extended, not rebuilt — `PUT /chatbots/integration`
  now optionally accepts `apiBaseUrl` alongside `apiKey`
  (`src/validators/integration.validator.ts`,
  `src/services/integration.service.ts:73-109`). Both fields are
  independently optional-with-keep-existing on update (a caller updating
  just the URL doesn't have to resend, and thereby re-encrypt, an unchanged
  key, and vice versa) — `apiKey` is required only the first time, when
  there's no existing encrypted value to fall back to. One real bug caught
  and fixed while building this: Postgres validates a NOT NULL constraint
  against an `INSERT ... ON CONFLICT DO UPDATE`'s VALUES clause *before*
  deciding whether to actually insert or update, so passing a literal
  `null` placeholder for "keep existing" failed with a NOT NULL violation
  even though the UPDATE branch would never have used it — fixed by
  re-reading the existing encrypted value first and passing that back as
  the placeholder (`integration.service.ts:83-96`). Covered by
  `tests/integration/actions.integration.test.ts`'s "never returns the API
  key itself" test (extended) and its new first-connect-requires-a-key
  test.
- **Read client** (`src/lib/backendLink.ts`): fetches `/products` (bounded
  to 20 for context size), then `/products/{id}/availability` for up to the
  first 5 products in parallel (`MAX_AVAILABILITY_LOOKUPS`, line 18) — each
  its own 4s-timeout, zero-retry call (`BACKEND_LINK_TIMEOUT_MS`, line 12),
  so one slow product doesn't block the others. Any failure at any stage
  (SSRF block, timeout, non-2xx, non-JSON, non-array response) degrades to
  an empty result, never a thrown error — the caller falls back to
  crawled-content/live-data/the fixed fallback message exactly as if no
  backend link were configured at all.
- **SSRF protection**: the *same* `assertSafeUrl`
  (`src/lib/crawler/ssrf.ts`) the crawler and Custom Actions both use,
  re-resolved on every call, applied to the owner-supplied `api_base_url`
  before any request goes out.
- **Wired as a third context tier** (`src/lib/answerChatbotQuestion.ts:154`,
  `fetchBackendLiveContext`): live-data table first, then the backend-link
  read tier, then crawled content — matching the instruction's ordering.
  Tagged `kind: "live"` so `lib/ai.ts`'s system prompt treats it as
  authoritative on conflict, same as chatbot_live_data. Cached briefly per
  chatbot cache-version (`BACKEND_LINK_CACHE_TTL_SECONDS`, default 30s) to
  bound request volume to the owner's backend under a burst of chat
  messages — not a correctness mechanism, and short enough that "live"
  still means live; the integration CRUD bumps the chatbot's cache version
  on every write so a changed URL/key doesn't wait out that TTL
  (`integration.service.ts:99, 110`).
- **Security notes documented, not just implemented**: the contract doc
  explicitly says encryption-at-rest protects against a ChatMate360
  database compromise, not against what a legitimately-obtained key can
  do, and recommends (without being able to enforce) issuing a scoped/
  read-only key where the owner's platform supports it.
- **Testing**: `tests/unit/backendLink.test.ts` — no link configured (no
  HTTP call made), SSRF blocks a private-IP `api_base_url`, a full
  successful `/products` + `/products/{id}/availability` round trip
  produces correctly-tagged live pages with the owner's key as a bearer
  token, network failure and non-2xx both degrade gracefully to no pages,
  and the per-cacheVersion cache prevents a redundant fetch. Dashboard UI:
  `Chatmate360-main/components/dashboard/actions-panel.tsx`'s
  `IntegrationConnection` component gained an API-base-URL field with its
  own independent save action (never resending/re-encrypting the key just
  to change the URL).

### Task 3 — Token-based metering for free-plan limits

- **No prior token-tracking instrumentation existed** to reuse (checked
  `src/lib/ai.ts` and grepped the repo for `input_tokens`/`estimated_cost`
  before starting — nothing) — built fresh, not a second system alongside
  an existing one.
- **Usage capture** (`src/lib/ai.ts`): every provider response is now read
  for its actual token counts and pushed to an optional `usageSink`
  side-channel — `AiUsage` (line 117), pushed in `answerWithClaude` (line
  246, from `data.usage.input_tokens`/`output_tokens`), `answerWithOpenAI`
  (line 390, `prompt_tokens`/`completion_tokens`), `answerWithGemini` (line
  326, `usageMetadata`), `answerWithOllama` (line 461,
  `prompt_eval_count`/`eval_count`). Pushed for **every real HTTP round
  trip**, including every iteration of the Claude/OpenAI tool-calling loop
  — a 3-round-trip tool-calling turn pushes 3 entries, so metering captures
  the full request including tool-call overhead, not just the final
  visible answer, per the explicit instruction. Covered by
  `tests/unit/aiToolCalling.test.ts`'s new usage-capture test (asserts two
  separate usage entries for a one-tool-call turn).
- **`chatbot_usage` table** (`db/schema.sql`): one row per chatbot per UTC
  calendar month (`billing_period`, `'YYYY-MM'`), `input_tokens`,
  `output_tokens`, `estimated_cost` — incremented (`on conflict ... do
  update set ... = chatbot_usage.x + excluded.x`), not overwritten, so
  multiple messages in the same period accumulate correctly.
- **Pricing table** (`src/lib/aiPricing.ts`, `estimateCostUsd`, line 48):
  $/1M-token rates per model, hardcoded defaults for the three paid
  providers actually configured (`claude-sonnet-5`, `gpt-4o-mini`,
  `gemini-flash-latest`), overridable via an `AI_PRICING_OVERRIDES_JSON`
  env var without a redeploy (per the explicit "configurable, since
  provider pricing changes" requirement). Self-hosted Ollama is a real `$0`
  rate, not a missing-data placeholder; a genuinely unrecognized *paid*
  model logs a warning and estimates `$0` rather than fabricating a
  plausible-looking nonzero number — under-counting is the safer failure
  direction for a cost cap than inventing a rate.
- **Fast pre-call cap check** (`src/services/usage.service.ts`):
  `isOverCostCap` (line 61) reads a Redis-cached running total
  (`getCurrentPeriodCostUsd`, line 31) kept warm by `recordUsage` (line 83)
  after every real AI call, falling back to a real `chatbot_usage` SUM only
  on a cache miss — never re-aggregating from scratch per message, per the
  explicit performance requirement. A Redis/DB failure in the cap check
  fails **open** (allows the request), consistent with every other
  cache-degradation path already in this codebase
  (`lib/cache.ts`'s getCached/setCached) — a metering outage degrades to
  "the AI chain runs as normal," not "every free-plan chatbot goes dark."
- **Wired into the gate that matters** (`answerChatbotQuestion.ts:203-226`):
  checked immediately before the only place this function actually spends
  money (right after the relevance gate, before `answerQuestion`), so a
  cached/gated/irrelevant question never counts against the cap. Over cap
  → the same graceful fallback message as the relevance gate, not an
  error, per the explicit instruction. Usage is recorded regardless of what
  happens to the AI's answer afterward (a real answer, a grounding-check
  rejection, or `null`) — the provider was actually billed either way.
- **Plan-aware, not a global constant**: `isOverCostCap` calls
  `getEntitlementForChatbot` (Task 1) and only checks the dollar cap for
  `plan === "free"` — an active/trialing paid subscription of any tier is
  never checked against `FREE_PLAN_MONTHLY_COST_CAP_USD` at all in this
  pass (see Gap below), reading the chatbot's *real*, current entitlement
  rather than a single global flag.
- **Testing**: `tests/unit/aiPricing.test.ts` (rate lookup, linear scaling,
  zero-token edge case, unrecognized-model-is-$0), the usage-capture test
  in `aiToolCalling.test.ts` mentioned above,
  `tests/integration/usage.integration.test.ts` (accumulation across
  multiple `recordUsage` calls within a period against a real Postgres test
  DB; a fresh free-plan chatbot is under cap; recorded usage crossing
  `FREE_PLAN_MONTHLY_COST_CAP_USD` flips it over cap; an active paid
  subscription is never flagged regardless of usage; a canceled
  subscription reverts to free-tier cap checking).

**Manually verified live, per the task's explicit requirement ("verified
with real token counts, not assumed round numbers")** — ran the real
backend locally (`npm start`, real `OPENAI_API_KEY`) against a chatbot
with real crawled content, asked a real question through
`POST /chatbots/chat`, and got back a real, correctly-grounded AI answer
(`"Widget X costs $49.99 and it ships in 2 business days."`). The resulting
`chatbot_usage` row shows **real captured token counts, not synthetic
ones**: `input_tokens: 623, output_tokens: 16, estimated_cost: 0.000103`.
Then lowered `FREE_PLAN_MONTHLY_COST_CAP_USD` below that real recorded
cost and asked a second, different-but-still-relevant question against the
same chatbot: got back `{"aiGenerated": false, "text": "I can only help
with questions about Usage Bot..."}` — the fixed fallback, not a real AI
call — with a `"cost-cap-exceeded"` log line and, confirmed via a direct
DB query, no new usage row written (the AI provider was never actually
called). (Note: this required pointing the local verification instance's
`REDIS_URL` at the local docker-compose Redis instead of the real `.env`'s
Upstash credential — the same Upstash quota exhaustion flagged in §9's
gaps reproduced again during this verification, failing the authenticated-
chat rate limiter closed for every request against it. Further evidence
for that being a real, current production risk, not a one-off.)

**Gap, explicitly flagged: paid-plan chatbots have no cap or metering
enforcement of their own in this pass** — `isOverCostCap` returns `false`
unconditionally for any non-free plan rather than reading a higher,
plan-specific dollar limit. Usage is still *recorded* for every chatbot
regardless of plan (so the data exists), but nothing currently acts on it
for paid tiers. The instruction said "much higher cap or no hard cap
depending on their plan" without specifying paid-tier dollar amounts
anywhere in the existing pricing docs, and inventing limits not documented
anywhere felt like the wrong kind of judgment call to make silently —
flagged for a deliberate follow-up once real per-plan usage limits are
decided.

### Full-suite verification (all three tasks together)

`db/schema.sql` re-applied cleanly (idempotent) to both the local
`chatmate360` and `chatmate360_test` Postgres databases. `npm run
typecheck` and `npm run lint` clean on the backend; `npx tsc --noEmit` and
`npx eslint` clean on the touched frontend files
(`Chatmate360-main/components/dashboard/actions-panel.tsx`). Full backend
test suite: **170/170 passing, 26/26 test files**, run against real local
Postgres + Redis (`docker-compose.yml`) — up from the 143/143 recorded at
the end of §9, the 27 new tests covering exactly the three tasks above.

## 11. MVP-launch pass: admin dashboard, trial/plan limits, abuse detection, incremental re-crawl, conversation memory (2026-09-07)

Ten numbered sections, worked in order. Two points where the casual framing
of the request conflicted with its own explicit numbered spec, resolved in
favor of the explicit spec (stated up front rather than silently picked):
conversation memory is **plain Postgres, not LangChain/LangGraph** (§6
literally says "NOT a memory/LangChain concern — plain DB"); all new
logging is the **existing pino structured logger, not raw console.log**
(§8 literally says "not console.log/print"). Both are load-bearing
decisions, not oversights, if either is actually wanted later.

### §1 — Admin dashboard (separate privileged surface)

- **Schema**: `admin_users` (own login, no FK to `users`) and
  `admin_audit_log` (`admin_user_id`, `action`, `target_user_id`, `detail`
  jsonb) — `db/schema.sql`. No self-service signup route exists for
  `admin_users` at all; the only way to create one is
  `scripts/createAdmin.ts` (`npm run create-admin -- "Name" email
  password`), run from a machine with `DATABASE_URL` access — see
  `docs/ADMIN_SETUP.md`.
- **Isolated JWT scope**: `signAdminAccessToken`/`verifyAdminAccessToken`
  (`src/lib/auth.ts:61,66`) mirror the existing `typ: "access"` pattern
  with `typ: "admin"` instead — signed with the same `jwtSecret` (no
  second secret needed; the claim itself is what stops cross-use).
  `src/middleware/requireAdminAuth.ts` does **real verification on every
  request** (unlike the customer `requireAuth`, which is a presence check
  only — a deliberate, documented deviation for this higher-privilege
  surface), attaching `req.adminUserId`.
- **Routes** (`src/routes/admin.routes.ts:19-44`, all behind
  `requireAdminAuth` except `/login`): `POST /admin/login` (rate-limited,
  see below), `GET /admin/users` (search, plan, trial status, current-
  period usage via a single join query — `src/services/admin.service.ts`'s
  `listUsers`, no N+1), `POST /admin/users/:id/deactivate|activate`,
  `DELETE /admin/users/:id` (requires `{confirm:true}` — `400` without it;
  cascading delete falls out of pre-existing `on delete cascade` FKs, no
  manual per-table cleanup needed), `GET /admin/users/:id/usage` (by
  chatbot + billing period), plus `GET /admin/abuse-flags` /
  `POST /admin/abuse-flags/:id/review` (§4's abuse detection, reviewable
  here).
- **Audit logging**: every write goes through `logAdminAction`
  (`admin.service.ts`) — one row in `admin_audit_log` AND one line through
  the normal pino logger (`log().info(...)`), per the explicit "log it
  through the normal logger too" instruction.
- **Brute-force protection added, not just assumed**: `POST /admin/login`
  had no rate limit until `src/middleware/rateLimitAdminLogin.ts`
  (IP-keyed, `ADMIN_LOGIN_RATE_LIMIT_PER_MIN`, default 10/min) — flagged
  here because the pre-existing customer `POST /auth/login` **still has no
  rate limit at all**; not retrofitted in this pass (out of scope — an
  existing route, not one this pass added) but a real gap worth a
  deliberate follow-up.
- **Frontend**: `Chatmate360-main/components/admin/admin-shell.tsx` + `app/admin/page.tsx`
  — its own tiny fetch client, its own `sessionStorage` key
  (`chatmate360.admin_access_token`, distinct from the customer
  dashboard's `localStorage` token), rendered via `next/dynamic(...,
  {ssr:false})` so reading sessionStorage on first render can't produce a
  hydration mismatch. Shares no import, storage key, or code path with
  `lib/session.ts`/`lib/api.ts` (the customer auth stack) — verified by
  inspection, not just by convention.
- **Test**: `tests/integration/adminAuth.integration.test.ts` — every
  `/admin/*` route 401s with no token; a real customer access token 401s
  on `/admin/users`; a real admin token 401s on `/auth/me`; a real admin
  token can list users; deactivate/activate round-trips and actually blocks
  login (see §1's login-blocking fix below); delete requires `confirm:true`
  and actually removes the row.

### §2 — Free trial and plan limits

- **`trial_started_at`** (`db/schema.sql`, `users` table) defaults to
  `now()` at the column level — `auth.service.ts`'s plain `INSERT` needed
  no code change for either signup path (password or Google).
- **1-chatbot limit**: this was ALREADY a hard schema constraint
  (`chatbots.user_id unique`) before this pass — every account, free or
  paid, has always been capped at exactly one chatbot; there is no
  multi-chatbot-per-paid-account capability anywhere in this codebase, and
  building one was out of scope here (a real architecture change, not
  mentioned in the spec). What changed: the rejection message
  (`src/services/chatbot.service.ts`'s `createChatbot`) is now
  upgrade-aware for a free/trial account ("Your free trial includes 1
  chatbot. Upgrade your plan...") instead of the old generic "You already
  created your first chatbot." **Flagged, not silently pretended away**:
  a paid account hitting this limit gets a different, honest message
  ("You already have a chatbot on this account") since upgrading wouldn't
  actually unlock a second one today.
- **One unified answering gate** (`src/services/accessGate.service.ts:30`,
  `checkAnsweringGate`) — collapses chatbot-deactivated,
  account-deactivated, trial-expired, and cost-cap-exceeded into a single
  function returning one of those four reasons or "not blocked." Called
  as the FIRST thing in `answerChatbotQuestion`
  (`src/lib/answerChatbotQuestion.ts:150-165`), before any cache lookup —
  a blocked chatbot never serves even a cached answer. This **replaces**
  the standalone cost-cap check §3 (prior session) had here, per the
  explicit "one clear gate, not two separate checks" instruction — trial
  expiry and the cost cap are now checked in the exact same call, not two
  separate ones that could drift.
- **`gateReason`** (`ChatbotAnswer.gateReason`,
  `answerChatbotQuestion.ts:43`) is the distinct signal threaded all the
  way to both `POST /chatbots/chat` and `POST /public/chatbots/:userId/chat`
  responses (both controllers already spread `...answer`, so no extra
  plumbing needed) — consumed by the widget
  (`Chatmate360-main/app/widget/[chatbotId]/page.tsx`'s `GATE_MESSAGES`
  banner) and the dashboard preview chat.
- **Paying lifts both limits automatically**: `checkAnsweringGate` skips
  the trial-expiry check entirely once `getEntitlementForChatbot` (Task 1,
  prior session) reports `active: true` — no separate manual
  trial-extension mechanic exists or was built.
- **Manually verified live** (see the end-of-pass verification section
  below) — real signup, real second-chatbot rejection, real
  `trial_started_at` backdated via SQL, real `gateReason: "trial_expired"`
  returned from a real `/chatbots/chat` call.

### §3 — Token metering, confirmed split between free and paid

- **Per-plan caps, not "free capped / paid uncapped"**:
  `MONTHLY_COST_CAP_BY_PLAN` (`src/services/usage.service.ts:25`) reads
  `env.freePlanMonthlyCostCapUsd`/`starterPlanMonthlyCostCapUsd`/
  `growthPlanMonthlyCostCapUsd`/`businessPlanMonthlyCostCapUsd` (defaults
  $0.50 / $5 / $20 / $60 — **placeholder figures scaled off relative plan
  price, not real observed unit economics**, adjustable via env var,
  flagged rather than presented as researched numbers).
  `isOverCostCap` (`usage.service.ts:61`) looks up the cap for the
  chatbot's *actual* plan (`getEntitlementForChatbot`), never a single
  global constant.
- **Tool-calling overhead confirmed captured, not re-verified from
  scratch**: this was already true from the prior Task 3 pass —
  `lib/ai.ts`'s `usageSink` captures one entry per real provider HTTP round
  trip, including every iteration of the Claude/OpenAI tool-calling loop
  (Custom Actions). Nothing needed to change here; confirmed by re-reading
  `lib/ai.ts:117-140` and the existing `tests/unit/aiToolCalling.test.ts`
  usage-capture test, both untouched in this pass.

### §4 — API/model security audit

- **Confirmed, not assumed**: grepped both repos for any AI provider key
  or endpoint reference outside `src/lib/ai.ts`/`src/env.ts` — zero hits in
  the frontend repo (`Chatmate360-main`) for `OPENAI_API_KEY`,
  `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, or any provider's API host.
  Grepped every backend controller for `env.` usage — only `frontendUrl`
  (redirects) and `hasStripe` (a boolean flag) are ever referenced; no
  controller echoes a raw env value or raw provider response body back to
  a client. `NEXT_PUBLIC_*` audit on the frontend: only
  `NEXT_PUBLIC_API_URL` (the backend's own base URL) and
  `NEXT_PUBLIC_SITE_URL` are exposed to the bundle — no secret carries that
  prefix.
- **Rate limiting / origin checks on new routes**: `/admin/*` is
  correctly excluded from the public-widget rate limiter (its own auth +
  its own new `rateLimitAdminLogin`, see §1) — never mixed with
  `rateLimitPublicChat`. `/billing/checkout-session`, `/chatbots/actions`,
  `/chatbots/integration` are all behind `requireAuth` +
  (`requireAuth`-gated writes don't need the public limiter, they're
  already keyed to an authenticated user). The public widget path
  (`/public/chatbots/:userId/chat`) is unchanged and still goes through
  `rateLimitPublicChat`/`authorizePublicRequest` exactly as before —
  confirmed by reading `routes/public.routes.ts`, not touched this pass.
- **Abuse detection** (`src/services/abuseDetection.service.ts`): every
  answer-cache MISS increments a per-chatbot Redis counter
  (`recordCacheMissAndCheckAbuse:17`) inside a sliding window
  (`ABUSE_WINDOW_SECONDS`, default 60s); crossing `ABUSE_REQUEST_THRESHOLD`
  (default 20) writes one `chatbot_abuse_flags` row + a `log().warn(...)`
  line (`flagAbuse:40`) — reviewable via the new admin dashboard. **Actual
  auto-deactivation is opt-in** (`ABUSE_AUTO_DEACTIVATE`, default `false`)
  — flagging always happens, but flipping a real customer's chatbot off on
  a heuristic is an operator decision, not a safe default; when it's on,
  it reuses the same `chatbots.is_active` column `checkAnsweringGate`
  already reads, so the very next request is blocked with
  `gateReason: "chatbot_deactivated"` — no separate abuse-specific gate to
  keep in sync.
- **`.env`/`.env.example` re-audit**: confirmed `.env` is `.gitignore`d and
  not tracked (`git ls-files .env` returns nothing) in the backend repo;
  every env var added across this and prior sessions (Stripe keys,
  `INTEGRATION_ENCRYPTION_KEY`, and every new var from this pass) is listed
  in `.env.example` with a blank/placeholder value, never a real secret.

### §5 — Incremental re-crawl via cron

- **Content hash**: `ChatbotSource.contentHash` (`src/lib/chatbot.ts`,
  sha256 via the new `hashPageContent`) — set at INITIAL crawl time too
  (`chatbot.service.ts`'s `crawlWebsiteForChatbot`), not just on recrawl,
  so the very first recrawl after this shipped has a real baseline to
  compare against instead of treating every page as changed.
- **`services/recrawl.service.ts`**: `runIncrementalRecrawl(chatbotId)`
  (line 32) — re-crawls the stored `chatbots.website_url` (a NEW column;
  previously the crawl entry point was only ever passed transiently at
  creation and never persisted, which this cron needs to exist at all),
  compares each fresh page's `contentHash` against the existing stored
  source by `url`; unchanged pages keep their existing source object
  untouched (no re-store cost), changed pages replace just that one
  entry. Respects the SAME `checkAnsweringGate` the answering pipeline
  uses — skips entirely for `trial_expired`/`account_deactivated`/
  `chatbot_deactivated`, but **deliberately does NOT skip for
  `cost_cap_exceeded`** (crawling isn't an AI-token cost in this
  architecture at all — no LLM call happens during a crawl — so a chatbot
  merely over its monthly answer budget still gets to stay fresh for
  whenever that resets).
- **Scheduling**: `src/lib/queue.ts`'s `ensureRecrawlSchedulerRegistered`
  registers one BullMQ repeatable job (`RECRAWL_INTERVAL_MS`, default
  weekly), idempotent across worker restarts (fixed `jobId`). Its handler
  (`worker.ts`, `job.name === "recrawl-tick"`) fans out via
  `listRecrawlCandidateChatbotIds` (`recrawl.service.ts:109`) into one
  `recrawl-chatbot` job per candidate — confirmed registered against a
  real local Redis (`bull:crawl-queue:repeat:*` keys present after a live
  worker startup, not just typechecked).
- **Logging**: every recrawl outcome (`pagesChecked`, `pagesChanged`,
  `pagesSkipped`, or a `skipped`/`reason` pair) goes through
  `log().info(...)` in both `recrawl.service.ts` and the worker's fan-out
  handler.
- **Test**: `tests/integration/recrawl.integration.test.ts` (5 tests) —
  an unchanged-hash page is skipped and its stored object is untouched, a
  changed-hash page is replaced, a page with no prior hash is treated as
  changed (first-run bootstrap), a gated chatbot is skipped with zero
  crawl attempts, `cost_cap_exceeded` specifically does NOT skip, and a
  chatbot with no `website_url` is skipped.

### §6 — Conversation memory (plain Postgres, explicitly not a framework)

- **Schema**: `conversations` (one row per `(chatbot_id, session_id)`,
  `summary`, `turn_count`) and `messages` (`role`, `content`,
  `conversation_id`) — `db/schema.sql`.
- **`services/conversation.service.ts`**: `loadConversationContext`
  (line 56) returns the last `CONVERSATION_CONTEXT_TURNS` (default 6)
  turns verbatim, prefixed with a compact summary of anything older, as a
  synthetic leading `assistant` message (ChatMessage only has
  user/assistant roles — reused rather than inventing a third). `recordTurn`
  (line 127) persists the real turn and triggers `maybeCompact` (line 95)
  once `turn_count` exceeds `CONVERSATION_SUMMARY_THRESHOLD_TURNS` (default
  20) — older messages get folded into `summary` and **pruned from
  `messages`** (bounded per-conversation storage, unlike
  `admin_audit_log`'s "never delete").
- **Deliberately heuristic summarization, not a real LLM call**: folding
  old turns into `summary` is pure string concatenation of past user
  questions (`foldIntoSummary`), not an extra AI round trip — spending real
  tokens summarizing a conversation would itself count against the same
  cost cap (§3) this mechanism exists to help keep bounded. A real
  LLM-generated summary would read better; this is the deliberately cheap
  MVP version, per the explicit "plain DB... not a new framework"
  instruction ruling out reaching for LangChain/a summarization chain here.
- **Opt-in, fully backward compatible**: both chat endpoints
  (`POST /chatbots/chat`, `POST /public/chatbots/:userId/chat`) gained an
  optional `sessionId` field (`chatbot.validator.ts`, `public.validator.ts`)
  — omitting it preserves the exact prior client-supplied-history-only
  behavior (every existing test still passes unmodified). When present,
  it REPLACES the client's `history` with what's actually persisted, so
  there's one source of truth. Not persisted when `gateReason` is set
  (a gate response isn't part of the visible conversation transcript).
- **Frontend wiring**: the public widget
  (`app/widget/[chatbotId]/page.tsx`) generates and persists a per-
  (browser, chatbot) session id in `localStorage`; the dashboard preview
  chat (`dashboard-shell.tsx`) generates one per browser tab in
  `sessionStorage`. Both send it on every message.

### §7 — Embed/script readiness confirmed, and extended for the new states

- **Confirmed, not rebuilt**: `embed.js` and the generated `<script>` tag
  are unchanged — they already worked before this pass and don't reference
  anything gate/trial-related themselves (that's the iframe page's job).
- **Extended, per the explicit instruction that this needed to actually
  show the new states, not just "still render"**: the widget page now
  renders a distinct amber banner (`GATE_MESSAGES`) for each `gateReason`
  — "This chatbot's free trial has ended..." for `trial_expired`, etc. —
  instead of the reply bubble being the only signal.
- **Embed panel status badge** (`embed-panel.tsx`'s `statusBadgeFor`,
  fed by the new `account` field on `GET /chatbots/status`
  (`chatbot.service.ts`'s `getChatbotStatus`)): a colored pill next to the
  embed snippet reading "Active — growth plan" / "Free trial" / "Trial
  expired — upgrade to continue" / "Deactivated by admin" / "Deactivated
  (unusual activity)".

### §8 — Structured logging

Every new log call in this pass uses `log()` (pino) —
`grep -rn "console\.\(log\|error\|warn\|info\|debug\)" src scripts` finds
only the two pre-existing, correctly-client-side `console.error` calls in
`src/public/embed.js` (a browser script — pino doesn't run there and never
did). Specifically covered: every admin action (§1, via `logAdminAction`),
every gate rejection (§2/3, `answerChatbotQuestion.ts:162`), every recrawl
outcome (§5), every abuse flag (§4). All go through the request-scoped
`log()` wrapper, so `requestId` is attached automatically wherever one
exists in context (the same mechanism every other log line in this
codebase already relies on) — no new plumbing needed for that part.

### §9 — Scalability, conventions, indexes, tests

- **Conventions followed**: every new service function re-derives
  ownership from a token/id the caller already authorized, never trusts a
  client-supplied id for anything privileged (`admin.service.ts`,
  `conversation.service.ts`); every new outbound-facing gate degrades to a
  graceful fallback, never a hard failure (`accessGate.service.ts`,
  `abuseDetection.service.ts` both fail open on error); no new plaintext
  secret at rest (nothing new needed encryption — admin passwords use the
  same bcrypt path as customer passwords); no new outbound HTTP call was
  added that needed SSRF protection (recrawl reuses the existing
  crawler/SSRF path unchanged).
- **New indexes**: `idx_admin_users_email`,
  `idx_admin_audit_log_admin_user_id`/`_target_user_id`/`_created_at`,
  `idx_chatbot_abuse_flags_chatbot_id`/`_unreviewed` (partial),
  `idx_conversations_chatbot_id`, `idx_messages_conversation_id_created_at`,
  `idx_chatbots_website_url` (partial) — `db/schema.sql`.
- **Tests added**: `tests/integration/trialLimits.integration.test.ts` (4),
  `tests/integration/adminAuth.integration.test.ts` (6),
  `tests/integration/recrawl.integration.test.ts` (5) — the three explicitly
  requested (trial-limit enforcement, admin auth isolation, content-hash
  skip logic) — plus the pre-existing suite re-run clean throughout.
  **Final count: 185/185 passing, 29/29 test files**, `npm run typecheck`
  and `npm run lint` both clean (backend); `npx tsc --noEmit` and
  `npx eslint` both clean on every touched frontend file.

### §10 — Full backend read/write access (a specific customer integration)

**Explicitly not built, per the instruction — this is ready to receive, no
new code needed.** The existing Custom Actions system (prior session) is
already the general mechanism: when that customer's site is ready to be
wired up, it gets configured through the existing Custom Actions dashboard
(define an action per operation the site needs — read, write, update,
delete — each with its own URL template, HTTP method, and parameter
schema) or the backend-link contract
(`docs/BACKEND_INTEGRATION_CONTRACT.md`) if a generic products/availability
shape fits. Building a one-off special-case integration ahead of that
customer's actual site being ready would be pure speculation — not done.

### Gaps and scope boundaries, explicitly flagged

- **`POST /auth/login` still has no rate limit.** Pre-existing, not
  introduced or worsened by this pass; the NEW `/admin/login` does have one
  (§1/§4). A real brute-force risk on the customer login route, worth a
  deliberate follow-up.
- **An already-issued customer access token isn't revoked on
  deactivation.** New logins are blocked (`assertAccountActive` in
  `auth.service.ts`, both the password and Google paths) and the chatbot's
  answering pipeline is blocked (`checkAnsweringGate`) — but a browser tab
  with a live, unexpired JWT from before deactivation can still hit other
  authenticated routes (viewing the dashboard, changing settings) until
  that token naturally expires (`ACCESS_TOKEN_TTL_SECONDS`, 7 days
  default). Real JWT revocation would need a token blocklist or a
  per-user token version check on every request — a bigger change than
  this pass's "block login and chatbot/widget traffic" scope covers.
- **True multi-chatbot-per-paid-account doesn't exist** (see §2) — the
  1-chatbot cap is a hard schema constraint predating this pass, not
  something this pass could lift for paid plans without a real,
  unrequested architecture change.
- **The per-plan cost caps (§3) are placeholder numbers**, not researched
  unit economics — $5/$20/$60 for starter/growth/business, scaled roughly
  off relative plan price. Easy to correct via env var once real numbers
  exist; flagged so nobody mistakes them for a considered pricing decision.
- **Conversation summarization is heuristic, not LLM-generated** (§6) — a
  deliberate cost/complexity tradeoff for this MVP pass, not an oversight;
  a real summarization call would read better if ever wanted later.
- **Abuse-detection auto-deactivation is off by default** (§4) — flagging
  always happens and is reviewable in the admin dashboard; actually
  disabling a chatbot on the heuristic requires an operator to opt in via
  `ABUSE_AUTO_DEACTIVATE=true`.

### Manual verification performed (live, against a real local backend + Postgres + Redis, not just automated tests)

Ran the real backend locally (local Redis to avoid the still-unresolved
Upstash quota issue noted in §9's gaps) and, with real HTTP requests:
1. Signed up a real account, created a chatbot, attempted a second — got
   the real `409` with `"Your free trial includes 1 chatbot. Upgrade your
   plan to create additional chatbots."`
2. Backdated a real account's `trial_started_at` by 31 days via SQL,
   confirmed `GET /chatbots/status`'s `account.isTrialExpired: true`, and
   confirmed `POST /chatbots/chat` returned
   `{"aiGenerated": false, "gateReason": "trial_expired"}`.
3. Created a real admin user (`npm run create-admin`), logged in, confirmed
   the admin token 401s on `/auth/me` and a real customer token 401s on
   `/admin/users`, then deactivated the trial-expired test user via
   `POST /admin/users/:id/deactivate` and confirmed the SAME chat call now
   returns `gateReason: "account_deactivated"` instead — then reactivated it.
4. Started the real worker process against a real Redis and confirmed
   (via `redis-cli KEYS "bull:crawl-queue:repeat:*"`) that the recrawl
   scheduler tick actually registers as a live BullMQ repeatable job, not
   just that the registration code typechecks. The specific "one changed
   page, one unchanged page, only the changed one gets replaced" scenario
   is covered by `recrawl.integration.test.ts`'s first test (mocked crawl
   result, real Postgres read/write) rather than re-verified against a live
   external site — a live two-page public test site wasn't available to
   crawl, and the mocked version exercises the exact same hash-compare code
   path with more precise control over what "changed" means.

## 12. Three-tier product direction: Free / Crawl Plus / Full Custom (2026-09-07)

A five-phase pass, each phase depending on the one before it: (A) lift the
single-chatbot-per-account limit, (B) formal plan/tier definitions,
(C) quota-based model switching, (D) pay-as-you-go credit top-ups,
(E) productize the Full Custom tier with two real demo integrations. Backend
test suite: **195/195 passing** (up from 193; §9-11's baseline). Frontend:
`npx tsc --noEmit` and `npx eslint` both clean on every touched file.

**§11 said "true multi-chatbot-per-paid-account doesn't exist... a hard
schema constraint predating this pass" — Phase A below removes exactly that
constraint.**

### Phase A — removing the one-chatbot-per-account limit

- **Schema**: `chatbots.user_id`'s UNIQUE constraint dropped
  (`db/schema.sql:106`, `DROP CONSTRAINT IF EXISTS chatbots_user_id_key`),
  replaced with a plain non-unique index (`db/schema.sql:107`) to preserve
  lookup performance. Idempotent — safe to re-run against a database that
  never had the constraint.
- **Plan-based ceiling, enforced by counting real rows**: `createChatbot`
  (`src/services/chatbot.service.ts:161-203`) counts
  `select count(*) from chatbots where user_id = $1` and compares against
  `entitlement.maxChatbots` (`src/lib/plans.ts`, see Phase B) — never a
  schema constraint. Returns a 409 with an upgrade-aware message
  distinguishing "your trial/free plan caps you at N" from "your paid
  plan's own ceiling" (`chatbot.service.ts:172-184`).
- **Ownership helper** replacing every "derive the caller's one chatbot
  from their token" call site: `requireOwnedChatbotId(userId, chatbotId)`
  (`src/lib/chatbotOwnership.ts:17`) — a 404 (never a distinguishing 403) if
  the chatbot doesn't exist or isn't the caller's.
- **Audit of every place that assumed "a user has at most one chatbot"** —
  per the instruction to list every place checked, not just the ones that
  needed fixing:

  | Place checked | Assumed one chatbot? | Fix |
  |---|---|---|
  | Dashboard's chatbot lookup (`GET /chatbots/status`) | Yes | Split into `GET /chatbots` (list, `chatbot.service.ts:241`) + `GET /chatbots/:chatbotId` (one, `chatbot.service.ts:258`) |
  | Embed panel (`data-chatbot-id`) | Yes — used the owner's `userId` | Now the chatbot's own `id` (`embed-panel.tsx:78`) |
  | Admin user-detail/list view | Yes — one row per user assumed a 1:1 join | `admin.service.ts:88-125` rewritten with two aggregated subqueries so multi-chatbot users still produce exactly one row (`AdminUserListItem.chatbotCount`/`inactiveChatbotCount`, `admin-shell.tsx:66-67,311-312`) — **caught during this audit, not from a failing test**; the naive `left join chatbots` would have silently fanned out into duplicate admin rows the first time any account owned >1 chatbot |
  | trial-gate / `checkAnsweringGate` pipeline | No (already per-chatbot) | No change needed |
  | Live-data CRUD (`liveData.service.ts`) | Yes — implicit "the caller's chatbot" | Explicit `chatbotId` param + `requireOwnedChatbotId` |
  | Custom Actions CRUD (`actions.service.ts`) | Yes | Same fix, plus Phase E's `requireFullCustomPlan` gate on writes |
  | Backend-link integration (`integration.service.ts`) | Yes | Same fix, plus Phase E's Full Custom gate |
  | **Public widget routes** (`public.service.ts`, `public.routes.ts`) | Yes — keyed by the owner's `userId`, not the chatbot's own id | **Caught during this audit, not anticipated going in**: `getChatbotById`, `authorizePublicRequest`, `getPublicChatbot`, `answerPublicChat` all renamed their first param `userId` → `chatbotId` and the route changed from `/chatbots/:userId` to `/chatbots/:chatbotId`; two of an account's chatbots would otherwise have collided on the exact same public widget URL |
  | `auth.service.ts`'s `loadPublicUser` | Yes — `chatbot: Chatbot \| null` | `chatbots: Chatbot[]` (`auth.service.ts`, `session.ts:9`) |
  | Rate-limit key derivation (`rateLimitPublic.ts`) | Yes — keyed off `userId` | Renamed to `chatbotId`, same fix as public routes |
- **Routes** (`src/routes/chatbot.routes.ts`): every chatbot-scoped route
  nested under `/chatbots/:chatbotId/...` — a documented breaking API
  change with no backward-compatible alias for the old flat routes
  (`chatbot.routes.ts:33-43`'s doc comment explains why a clean cutover was
  chosen).
- **Dashboard frontend — chatbot list/switcher**: `DashboardShell` now
  fetches `GET /chatbots` into a `ChatbotEntry[]` list
  (`dashboard-shell.tsx:55,99`), renders a "Your chatbots" switcher in the
  sidebar (`dashboard-shell.tsx:384`) with an inline "+ New chatbot" form
  (`createChatbot`, `dashboard-shell.tsx:313`) that surfaces the plan-limit
  409 verbatim, and threads the selected chatbot's id through
  `retryCrawl`/`sendQuestion`/`EmbedPanel`/`ActionsPanel`
  (`dashboard-shell.tsx:246,279`). `EmbedPanel` and `ActionsPanel` are
  remounted (`key={chatbot.id}`) on every switch so neither component's
  internal draft state (theme/domain drafts, the actions list) leaks
  between chatbots. `actions-panel.tsx`'s `ActionForm`
  (`actions-panel.tsx:136`) and `IntegrationConnection`
  (`actions-panel.tsx:369`) both gained an explicit `chatbotId` prop,
  threaded from `ActionsPanel` (`actions-panel.tsx:503`) — every one of
  their API calls now targets `/chatbots/:chatbotId/...` instead of the old
  flat routes.
- **Tests**: `tests/integration/multiChatbot.integration.test.ts` (new,
  4 tests) — plan-limit enforcement with the upgrade-aware message
  (`:28`), cross-user list isolation (`:51`), two chatbots on one account
  both independently reachable (`:69`), and a 404 (not a leak) for another
  user's chatbot id (`:91`). Every other integration test touching a
  chatbot route was updated to the nested `/chatbots/:chatbotId/...` shape
  in the same pass (14 test files).

### Phase B — formal plan/tier definitions

- **Config-driven plan definitions**, not a DB table: `PlanDefinition`
  (`src/lib/plans.ts:19-29`) — `plan`, `maxChatbots`, `allowedModels`,
  `perModelCapUsd`, one object per tier in `PLAN_DEFINITIONS`
  (`plans.ts:31-55`). Every number is a named `env.ts` value, never
  hardcoded at a call site (`plans.ts:4-12`'s doc comment explains the
  DB-table alternative was considered and deliberately not built — it would
  need its own admin CRUD UI, real unrequested scope for this pass).
- **Exactly three tiers**, per the assumption table below (see
  **Assumptions** section) — `free`, `crawl_plus`, `full_custom`
  (`src/lib/stripe.ts:31`). The prior `starter`/`growth`/`business` naming
  is gone from the schema, Stripe mapping, and every test; `starter` has no
  direct successor and was consolidated into `crawl_plus` (see
  Assumptions).
- **Unified entitlement shape**: `Entitlement extends PlanDefinition`
  (`src/services/billing.service.ts`) — `getEntitlementForChatbot`
  (`billing.service.ts:281`) and `getEntitlementForUser`
  (`billing.service.ts:297`) both return the full plan shape
  (`maxChatbots`, `allowedModels`, `perModelCapUsd`, `active`) from one
  `entitlementFor(plan, active)` helper — no more two functions with
  slightly different literal object shapes.
- **Stripe Price ID mapping**: `priceIdForPlan`/`planForPriceId`
  (`stripe.ts:38-64`) map the two paid tiers' Stripe Price IDs; env vars
  renamed `STRIPE_PRICE_STARTER/GROWTH/BUSINESS` →
  `STRIPE_PRICE_CRAWL_PLUS`/`STRIPE_PRICE_FULL_CUSTOM`.
- **Ollama excluded on every tier**: `ModelKey` (`plans.ts:17`) is
  `"anthropic" | "openai" | "gemini"` only — Ollama is the
  failure-fallback-of-last-resort in `lib/ai.ts`, never a plan entitlement
  (`plans.ts:35-39`'s doc comment).

### Phase C — quota-based model switching (Crawl Plus and above)

Deliberately a **separate mechanism** from `lib/ai.ts`'s existing
failure-fallback chain, per the explicit instruction not to merge them:

- **Per-model usage tracking**: `chatbot_usage` gained a `model` column
  (`db/schema.sql:326`) and its unique constraint was migrated from
  `(chatbot_id, billing_period)` to `(chatbot_id, billing_period, model)`
  (`db/schema.sql:328-335`, drop-before-readd, idempotent). `usage.service.ts`
  rewritten around it: `getModelPeriodCostUsd`, `getEffectiveModelCapUsd`,
  `isModelQuotaAvailable` (`usage.service.ts:31,88,93`) all take a `model`
  parameter; `isOverCostCap` (`usage.service.ts:109`) is now
  `!entitlement.allowedModels.some(available)` instead of one combined
  number.
- **Selection happens only between conversations, never mid-conversation**
  (an explicit ASSUMPTION requiring sign-off — see Assumptions):
  `conversations.pinned_model` (`db/schema.sql:447`) is set once via an
  idempotent `WHERE pinned_model IS NULL` guard
  (`conversation.service.ts:87`, `pinModelIfUnset`). A conversation with no
  existing `sessionId` calls `selectModelForNewConversation`
  (`modelSelection.service.ts:27`), which walks `env.modelPriorityOrder`
  filtered by `entitlement.allowedModels` and logs a
  `"model-selection-check"` per candidate plus `"model-selected"` on
  success (`modelSelection.service.ts:37,41`) — via the existing structured
  logger, not a new one. If every model's quota is exhausted, it falls
  through to the existing `checkAnsweringGate` cost-cap gate rather than a
  parallel gate (`answerChatbotQuestion.ts:246-254`: `selection === null`
  leaves `preferredProvider` unset, and the normal `answerQuestion` call —
  including its own `isOverCostCap`/`checkAnsweringGate` check — proceeds
  unchanged).
- **`lib/ai.ts`'s `answerQuestion`** gained a trailing
  `preferredProvider?` param (`ai.ts:527`) used only to *reorder* the same
  provider list Phase C shares with the failure-fallback chain
  (`ai.ts:555-558`) — a quota-exhausted-but-healthy provider is never
  logged as "failed" (that log line, `"ai provider failed, trying next"`,
  only fires from the pre-existing failure path, untouched by this phase);
  a quota-based skip is logged separately as `"model-selection-check"`
  with `available: false`.

### Phase D — pay-as-you-go credit top-ups (Crawl Plus)

A new Stripe scope — one-time Checkout (`mode: "payment"`), not the
existing subscription flow:

- **`createTopupCheckoutSession`** (`topup.service.ts:34`) — Stripe
  Checkout in payment mode for one model's credit block, metadata carries
  `{topupChatbotId, topupModel, topupBillingPeriod}` since a payment-mode
  session has no `session.subscription` for the webhook to key off later.
- **Webhook handling**: `processStripeWebhookEvent`'s
  `checkout.session.completed` case checks
  `session.metadata?.topupChatbotId` *first*
  (`billing.service.ts:191-208`), before the pre-existing
  subscription-retrieval branch — a payment-mode session would otherwise
  silently no-op against that branch's `session.subscription` lookup.
- **Idempotent crediting**: `creditTopup` (`topup.service.ts:67`) —
  `chatbot_model_credits.stripe_checkout_session_id UNIQUE`
  (`db/schema.sql:347-358`) + `INSERT ... ON CONFLICT DO NOTHING`
  (`topup.service.ts:76`), so a Stripe webhook redelivery can never
  double-credit. `getModelPeriodCreditUsd`
  (`usage.service.ts:76`) feeds directly into
  `getEffectiveModelCapUsd`'s effective cap.
- **Plan-upgrade path reused, not rebuilt**: the existing
  `createCheckoutSession` (`billing.service.ts:71`, subscription mode)
  already handles a plan upgrade as a distinct action from a top-up — no
  third parallel billing path was needed; confirmed by running the full
  webhook test suite (both flows, both distinguished only by
  `session.metadata`/`session.subscription` presence) rather than assumed.
- **Gap, flagged rather than worked around**: this environment has no real
  Stripe test-mode keys/webhook secret configured, so a live top-up
  checkout was not completed end-to-end against Stripe's actual servers —
  see manual verification item 3 below and §9/§10's matching Stripe gaps.

### Phase E — Full Custom tier: gating + two real demo integrations

> **Superseded product rule (2026-09-26):** Custom Actions are now exclusive
> to active Crawl Plus subscriptions and require a current-month Claude or
> OpenAI model top-up plus a per-chatbot encrypted backend credential. See
> `docs/CUSTOM_ACTIONS_CRAWL_PLUS.md`. The bullets below describe the earlier
> implementation history and are retained as historical context.

- **Custom Actions and the backend-link write path gated to Full Custom
  specifically** — closing the "no plan gating" gap `IMPLEMENTATION_STATUS.md`
  §11 flagged before this pass: `requireFullCustomPlan`
  (`src/services/actions.service.ts:33`, `src/services/integration.service.ts:36`)
  throws `AppError(402, ...)` on `createAction`/`updateAction`
  (`actions.service.ts:63,99`) and `upsertIntegration`
  (`integration.service.ts:99`) — reads stay ungated (the backend-link read
  side, and listing/viewing actions, work on any plan; only writes require
  Full Custom).
- **Backend Integration Contract updated** (`docs/BACKEND_INTEGRATION_CONTRACT.md`)
  with a new, *implemented* Phase 2a: `POST {backend}/orders` and
  `PATCH {backend}/products/{id}/inventory` — the write side implemented
  for the first time, via Custom Actions (not a new capability of the
  read-only `backendLink.ts`, which is unchanged and still passive/GET-only).
  The old speculative Phase 2 (`/bookings`, `/reservations`) is renamed
  Phase 2b and kept spec-only — the booking demo below doesn't use it
  (Custom Actions are fully owner-defined, so there's nothing to
  standardize there).
- **WooCommerce demo** (`demos/woocommerce-adapter/`) — a real adapter
  translating the contract into WooCommerce's actual REST API v3
  (`src/wooClient.ts`: Basic Auth with a store's consumer key/secret,
  `listProducts`/`getProduct`/`createOrder`/`updateProductStock`).
  Read side: `GET /products`, `GET /products/:id/availability`
  (`src/app.ts`). **Write side, implemented for the first time**:
  `POST /orders` and `PATCH /products/:id/inventory`
  (`src/app.ts`), backed by real WooCommerce order-creation
  (`line_items`, nested `billing` object) and stock-update
  (`manage_stock`/`stock_quantity`) calls. Three concrete adjustments the
  original generic contract doc didn't anticipate, found by implementing
  against WooCommerce's real shape and now documented in the contract doc
  and `demos/woocommerce-adapter/README.md`:
  1. `stock`/`quantity` must be `null` (not `0`) for a non-stock-managed
     WooCommerce product — `availability` is derived from the always-present
     `stock_status` instead (`contractMapping.ts`).
  2. Order creation needs a `line_items` array and a nested `billing`
     object, not a flat `productId`/`customer.name` — `contractOrderRequestToWooInput`
     + `createOrder` do the translation, including splitting one "customer
     name" string into first/last name.
  3. WooCommerce has no order-creation-time "notes" field (only a separate
     follow-up call) — not implemented; flagged in the README rather than
     silently dropped.
  4. **Cross-cutting finding, not WooCommerce-specific**: ChatMate360's own
     Custom Actions template engine (`actionExecutor.ts`'s `fillBody`) can
     only ever substitute `{{params}}` as JSON strings — a `"quantity"`
     field templated from a `type: "number"` parameter always arrives as a
     numeric *string* (`"2"`), never a real JSON number. Both write routes
     (and the booking demo, by avoiding numeric templated fields entirely)
     account for this; documented in the contract doc's Phase 2a section
     and `contractMapping.ts`'s `coerceQuantity`.
  Tests: 25 in the adapter's own suite (`wooClient`, `contractMapping`,
  `app` route-level, all mocking WooCommerce's HTTP responses — never a
  real store) + 3 more proving `custom-actions.ts`'s shipped action
  definitions produce requests the real app accepts
  (`customActionContract.test.ts`) = 28 total, all passing.
- **Booking/appointment demo** (`demos/booking-api/`) — a real minimal
  Express API (in-memory store, `src/store.ts`): `GET /services`,
  `GET /availability`, `POST /bookings` (rejects double-booking a slot,
  409), `GET /bookings/:id`. Wired through **Custom Actions tool-calling**,
  not the backend-link contract, because booking is inherently
  conversational/multi-turn (check availability, then confirm one specific
  slot with the customer's details) — the contract's passive
  context-injection model doesn't fit a write that depends on mid-conversation
  input. Two action definitions ship in `custom-actions.ts`
  (`check_appointment_availability`, `create_booking`), every parameter
  required (sidestepping a known limitation of the templating engine: an
  *optional* templated field that's omitted leaves a literal `{{name}}` in
  the request body rather than being dropped — documented in the README
  rather than fixed, since fixing it means touching the shared
  `actionExecutor.ts`, out of this phase's scope). Tests: 9 (the API's own
  correctness) + 3 (`customActionContract.test.ts`, proving the shipped
  action definitions produce requests the real API accepts) = 12, all
  passing.
- **Both demos' exact shipped Custom Action definitions verified against
  the real, running backend** (not just each demo's own isolated test
  suite): `tests/integration/actions.integration.test.ts`'s new
  `"PHASE E: the demo apps' shipped Custom Action definitions register
  unmodified"` describe block imports `custom-actions.ts` from both demo
  packages, registers each action against a real Full Custom test chatbot
  via `POST /chatbots/:chatbotId/actions`, and asserts a real `201`
  (2 tests, both passing) — proof the registration path (schema validation,
  name-pattern check, Full Custom gate) accepts these definitions
  unmodified, not just that each demo's contract is internally consistent.
- **Live deployment — the disclosed gap, unchanged since it was first
  flagged at the start of this work**: this sandbox has no cloud hosting
  credentials and cannot provision public infrastructure. Neither demo is
  deployed to a real public URL, and the WooCommerce demo has not been run
  against a real WooCommerce store (no store/credentials available here
  either). Both are built and fully tested locally (40 demo-level tests +
  2 cross-repo registration tests, all passing) and each README includes
  concrete deployment steps. Per-phase honesty standard matches §9/§10's
  Stripe test-checkout gap — flagged, not glossed over, and not silently
  worked around with a fabricated URL.
- **Lead-qualification / inventory-management / support-agent behaviors
  are not separate code paths** — as instructed, these are conversation
  design (the chatbot's system prompt, which actions it's given, how it's
  told to use them) layered on top of what this phase built (Custom
  Actions' existing tool-calling engine, the two demos above), not new
  architecture.

### Assumptions made in this pass — flagged for confirmation before this ships to real customers

These were explicitly marked ASSUMPTION in the originating request, with
defaults chosen so the work could proceed; none should be treated as a
settled product decision without confirmation.

| # | Assumption | Where enforced | Default chosen |
|---|---|---|---|
| 1 | Crawl Plus's chatbot count is configurable 5-10; **5** was chosen as the concrete default | `env.crawlPlusPlanMaxChatbots` (`env.ts:157`) | `CRAWL_PLUS_PLAN_MAX_CHATBOTS=5` |
| 2 | Full Custom's chatbot ceiling is "effectively unlimited" but needs a real configurable number | `env.fullCustomPlanMaxChatbots` (`env.ts:158`) | `FULL_CUSTOM_PLAN_MAX_CHATBOTS=1000` |
| 3 | Free plan's monthly per-model cost cap | `env.freePlanMonthlyCostCapUsd` (`env.ts:115`, pre-existing, unchanged this pass) | `$0.50` |
| 4 | Crawl Plus is "~100x Free's cap" — a concrete USD number was needed | `env.crawlPlusPlanMonthlyCostCapUsd` (`env.ts:148`) | `$50` (100x the $0.50 free cap) |
| 5 | Full Custom's cap, "highest configurable" | `env.fullCustomPlanMonthlyCostCapUsd` (`env.ts:149`) | `$150` |
| 6 | Free plan's single model — "cheapest available" needed a concrete pick | `env.freePlanModel` (`env.ts:179`) | `"gemini"` (per `aiPricing.ts`'s default rate table, `gemini-flash-latest` is cheaper than both `gpt-4o-mini` and `claude-sonnet-5`) — **note this contradicts the historical Claude-first *failure-fallback* order in `ai.ts`, which exists for a different reason (key availability in this deployment), not cost** |
| 7 | **Model switching happens only between conversations, never mid-conversation** — explicitly flagged in the request as requiring sign-off | `conversations.pinned_model` + `pinModelIfUnset`'s `WHERE pinned_model IS NULL` guard (`conversation.service.ts:87`) | Implemented as specified; not yet confirmed by product |
| 8 | Top-up credit block size per purchase | `env.topupCreditUsd` (`env.ts:220`) | `$10` |
| 9 | `starter`'s consolidation — the old three-tier naming had no direct successor for `starter` | `stripe.ts:31`'s two-tier `PlanTier` | Folded into `crawl_plus` (a genuine tier-boundary decision, not a technical detail — the spec didn't specify where `starter` accounts should land) |

None of these are hardcoded inline — every one is a named `env.ts` value
that can be corrected without a second code change once real figures exist
(same discipline as §11's flagged placeholder cost caps, which this pass's
crawl_plus/full_custom numbers directly replace).

### Manual verification — status

Per the four items required before calling this done:

1. **Create a second chatbot on a Crawl Plus test account, confirm both
   work independently and are correctly isolated in every dashboard/admin
   view.** Covered by automated tests
   (`multiChatbot.integration.test.ts`, all 4 passing) and by direct
   reading of the admin-list fix (`admin.service.ts:88-125`) — not
   separately re-verified by hand against a running dashboard in a browser
   in this pass.
2. **Exhaust one model's quota, confirm the next NEW conversation switches
   models while an in-progress one does not.** The pinning mechanism
   (`pinModelIfUnset`'s `WHERE pinned_model IS NULL` guard) and the
   selection mechanism (`selectModelForNewConversation`) are both real,
   working code exercised by the full backend test suite's existing
   answering-path tests (which mock `modelSelection.service.js` to stay
   fast/deterministic — see §-level test notes), but no dedicated test
   drives "record usage past the cap, then start a second conversation and
   assert a different provider was picked while a concurrently open first
   conversation keeps its original provider" end-to-end. **Gap**: this
   specific scenario should get its own integration test before shipping.
3. **Complete one real top-up purchase in Stripe test mode, confirm the
   credited allowance increases the usable cap.** Not done — this
   environment has no real Stripe test-mode keys configured (same
   pre-existing gap as §9/§10's Stripe checkout verification). The webhook
   handling logic itself (idempotent crediting, metadata-based routing) is
   covered by the full test suite.
4. **Walk through one real WooCommerce purchase and one real demo booking
   end-to-end through the chat widget.** Not done — no real WooCommerce
   store or public hosting available in this sandbox (disclosed up front,
   see Phase E above). Both demos are built and fully tested locally
   (40 tests) with their real, shipped Custom Action definitions verified
   to register against a real running ChatMate360 backend (2 more tests);
   neither has been exercised through an actual chat conversation with a
   real LLM making real tool calls, since that additionally requires a
   real deployed URL for the LLM's tool call to reach.

## 13. Full Custom WooCommerce commerce pipeline: order-taking, inventory-aware Q&A, support ticketing (2026-09-09)

A genuinely new execution path for Full Custom + WooCommerce-connected
chatbots, built around one non-negotiable invariant: the AI never claims a
payment/order/booking succeeded unless a real, fresh WooCommerce read
independently confirms it. First use of LangGraph/LangChain in this
codebase — scoped entirely to `src/langgraph/` and the WooCommerce-specific
files below; the existing Free/Crawl Plus pipeline
(`src/lib/answerChatbotQuestion.ts`, `src/lib/ai.ts`) was not touched (see
the explicit citations at the end of this section). Backend test suite:
**253/253 passing** (up from 195 — 58 new tests across 11 new test files),
0 lint errors/warnings, `tsc --noEmit` clean.

### Data model (§1)

`db/schema.sql`: `chatbot_woocommerce_credentials` (write-only after
creation, encrypted via the SAME AES-256-GCM infra Custom Actions/
backend-link already use — `lib/crypto.ts`, `INTEGRATION_ENCRYPTION_KEY`,
reused not duplicated), `customer_identities` (verification_level enum
enforced by a CHECK constraint), `commerce_orders`, `commerce_tickets`,
`product_catalog_cache` (with a real `vector(1536)` column — the local
Postgres image was switched from `postgres:16-alpine` to
`pgvector/pgvector:pg16` in `docker-compose.yml` to support it, and
`create extension if not exists vector` added), `commerce_webhook_events`,
`customer_notifications`. Every uniqueness constraint named in the spec is
a real database constraint (`commerce_orders_chatbot_wc_order_unique`,
`idx_commerce_orders_booking_number_unique` — a partial unique index since
`booking_number` is NULL until paid, `commerce_webhook_events_chatbot_event_unique`),
verified to actually hold under concurrent requests (see the real-
concurrency tests below, not just declared and hoped).

**One deliberate addition beyond the literal spec**: `commerce_orders.idempotency_key`
(`db/schema.sql`, migrated onto the existing table via the same
drop-before-readd idiom used elsewhere in this file). commit_order's
idempotency requirement ("a retried/duplicated commit attempt must not
create two WooCommerce orders") cannot actually be guaranteed without a
real, durable key to detect a retry *before* the WooCommerce call happens a
second time — reuses the LangGraph checkpointer's own `graph_run_id`
(thread_id) as the key value rather than inventing a second concept.

### WooCommerce REST API connector (§2)

`src/lib/woocommerce/connector.ts` — every method targets `/wp-json/wc/v3/`
specifically (never the generic WordPress REST API), documented as such in
the file's own header comment. `getProduct`/`listProducts`/`checkStock`
(:69,73,81), `createOrder` (:89), `getOrderStatus` (:108). Same SSRF
discipline as the crawler (`assertSafeUrl`, re-resolved per call) and the
same aggressive-timeout-no-retries pattern as `backendLink.ts`/
`actionExecutor.ts`.

**`buildOrderPayUrl`** (`connector.ts:122`) — WooCommerce's own standard
"pay for order" URL (the same link WooCommerce's built-in payment-pending
email points to), built from two real, authoritative API response fields
(`order.id`, `order.order_key`) per the explicit instruction never to
construct a payment URL by string concatenation or guesswork. A missing
`order_key` throws a clear `AppError(502, ...)` — treated as the "cannot
obtain a real payment URL" configuration error to surface, not papered
over. **Known Phase 1 limitation, flagged rather than silently assumed to
work universally**: this is the only payment-URL mechanism built; a
payment gateway that instead returns its own gateway-hosted checkout URL
(some hosted-checkout gateways do, via fields this generic REST response
doesn't carry) isn't specially handled.

### PaymentConfirmationPolicy / WooCommerceStatusMapper (§3)

`src/lib/woocommerce/paymentPolicy.ts` — `PaymentConfirmationPolicy`
(:24) is the **only** function anywhere in this codebase allowed to decide
whether a WooCommerce order counts as paid; every caller passes fresh data
from `getOrderStatus()`, never a cached status, never a webhook payload's
claim alone. A reasoned decision tree (not a single hardcoded
`status === "processing"` check): `date_paid` set (WooCommerce's own
authoritative payment-complete signal) is checked first and is sufficient
on its own; `"completed"` and `"processing"` are treated as paid per
WooCommerce core's own documented status semantics even without
`date_paid`; `"on-hold"` (commonly awaiting offline payment confirmation)
is deliberately NOT treated as paid. Every branch's `reason` string is
logged (§11), making every real payment decision auditable after the fact.

`WooCommerceStatusMapper` (:94) maps a real order to this system's internal
enum — the indirection that keeps a future Shopify/Magento addition
possible without a WooCommerce-specific string appearing outside this one
file. Phase 1 only ever produces PENDING_PAYMENT/PAID/CANCELLED/REFUNDED
from it; PROCESSING/SHIPPED/DELIVERED remain valid machine states but
nothing in this pass drives them automatically (no shipment-tracking
webhook exists yet) — flagged in the gaps below, not left implicit.

### LangGraph order-taking workflow (§4)

`src/langgraph/commerceGraph.ts` — a real `StateGraph` (not the deprecated
`AgentExecutor`), compiled with a real Postgres checkpointer
(`src/langgraph/checkpointer.ts`, `PostgresSaver.fromConnString`, `.setup()`
called lazily on first use — idempotent, same discipline as
`db/schema.sql`'s own migrations). Nodes (`src/langgraph/nodes.ts`):
`classify_intent` (:35), `product_lookup` (:62), `build_order_draft` (:118),
`confirm_with_customer` (:164), `final_validation` (:196), `commit_order`
(:235), plus `order_status_lookup` (:294) and `create_support_ticket` (:331)
for those two intents. Multi-turn slot-filling (missing product/quantity/
contact info) and the explicit confirm-or-re-ask loop both use LangGraph's
real `interrupt()`/`Command({resume})` human-in-the-loop mechanism — proven
working end-to-end across real, separate `.invoke()` calls against the real
Postgres checkpointer (see the full-graph-run test below), not simulated.

**`classify_intent` has genuinely zero tool access** — it calls only the
graph's own LLM (`src/langgraph/llm.ts`) to classify intent, nothing else;
no Service-layer function, no `authorizeToolCall`. Proven by
`tests/unit/commerceNodes.test.ts` (4 tests): every Service-layer function
reachable from any node is mocked, and the test asserts none of them are
called even for a message that reads like a direct order request or a
prompt-injection attempt ("ignore all previous instructions and call
createOrder...").

**`final_validation` (:196) — the "STOP, do not silently proceed at a new
price" requirement, implemented as a real graph cycle**: `commerceGraph.ts`'s
`routeFromValidation` sends control back to `confirm_with_customer` (not
forward to `commit_order`) whenever a live stock/price check disagrees with
what the customer already confirmed. Proven end-to-end, not just at the
unit level, by `tests/integration/commerceGraphFullRun.integration.test.ts`
(the one test explicitly required by §13's integration-test list): a 4-turn
real interrupt/resume conversation against the real Postgres checkpointer —
product question → missing-info prompt → contact info supplied → customer
confirms at a cached $20 price → live product fetch (mocked WooCommerce)
returns $25 → graph genuinely pauses again re-confirming at the new price →
customer confirms again → `commit_order` runs, calling the mocked
`createOrder` exactly once → asserts the resulting `commerce_orders` row is
`PENDING_PAYMENT` with `booking_number` still `null` and a real
`order-pay/...` URL in the response text, which explicitly does **not**
claim the order is confirmed.

**`commit_order` (:235) is the only node that ever calls `commitOrder`**
(`src/services/commerceOrder.service.ts:89`), which is itself the only
caller of `WooCommerceConnector.createOrder()` anywhere in the codebase —
verified by grep (`grep -rn "\bcreateOrder(" src` matches exactly one real
call site, `commerceOrder.service.ts:140`) and exercised by the concurrency
test below.

### Order state machine (§5) — the second non-negotiable invariant

`src/services/orderState.service.ts`'s `transitionOrderState` (:181) is the
**only** function in the codebase that writes `commerce_orders.status` —
verified by grep (the only two `update commerce_orders set status`
statements in `src/` are both inside this one file, lines 152 and 232).
The exact machine from §5, enforced by a lookup table (`VALID_TRANSITIONS`,
:34-43); every other pair is rejected with a 409, proven by a table-driven
test covering all ten listed invalid pairs plus every valid edge
(`tests/integration/commerceOrderState.integration.test.ts`, 8 tests).

The `PENDING_PAYMENT → PAID` transition (`confirmAndPay`, :93) runs inside
a single `SELECT ... FOR UPDATE`-locked transaction exactly per §5's five
steps: lock the row, re-verify still `PENDING_PAYMENT` (idempotent no-op if
already moved), re-verify payment via `PaymentConfirmationPolicy` against a
**fresh** `getOrderStatus()` call, generate the booking number under a
`SAVEPOINT`-protected collision-retry loop (candidate → insert attempt →
`ROLLBACK TO SAVEPOINT` and retry on a real `23505` unique-violation — up to
5 attempts), commit.

**Two real, previously-unknown production bugs were found and fixed while
building this test, not left latent**:
1. **A cross-connection deadlock.** The original code ran the §7/§8
   follow-up writes (customer notification, verification-level promotion)
   *inside* the still-open, row-locked transaction, via the shared
   connection pool (`pool.query`, a different connection than the one
   holding the lock). `customer_notifications.order_id`'s foreign key to
   the exact locked `commerce_orders` row meant that INSERT blocked
   forever waiting for a lock the same logical operation was holding open
   — a genuine self-deadlock, reproduced with a minimal standalone script
   before the fix. **Fixed** by moving both writes to run *after* `COMMIT`
   inside `transitionOrderState` (:181-224), best-effort, never rolling
   back the already-committed payment transition on failure.
2. **Missing `SAVEPOINT` around the booking-number retry loop.** A failed
   `INSERT`/`UPDATE` aborts the *entire* enclosing Postgres transaction —
   the original `catch` block's plain `continue` tried to run another
   statement in an already-aborted transaction, which fails with "current
   transaction is aborted." **Fixed** by wrapping each candidate attempt in
   `SAVEPOINT booking_number_attempt` / `ROLLBACK TO SAVEPOINT` (:139,148,171),
   so only the failed attempt rolls back, not the whole transaction (and
   not the row lock).

**The real-concurrency requirement, verified as real, not a mocked lock**:
`tests/integration/commerceOrderState.integration.test.ts`'s "real
concurrency" test fires two genuinely simultaneous `transitionOrderState`
calls (`Promise.all`) against the real `pg.Pool`, each acquiring its own
real connection and issuing a real `SELECT ... FOR UPDATE` — the second
connection's lock acquisition genuinely blocks at the Postgres engine level
until the first transaction commits (this is what caught bug #1 above in
the first place: the test hung for the exact same structural reason a
production deadlock would). Asserts exactly one booking number is ever
generated and exactly one of the two calls reports `changed: true`. The
identical real-concurrency pattern is repeated for `commitOrder`'s own
idempotency claim-row protocol in
`tests/integration/commerceCommitOrder.integration.test.ts` (4 tests,
including a genuine `Promise.allSettled` race), confirming
`WooCommerceConnector.createOrder()` is called exactly once even under a
real simultaneous double-attempt.

### Inbound webhooks (§6)

`POST /webhooks/woocommerce/:chatbotId` (`src/routes` via `app.ts`, mounted
with `express.raw()` ahead of the global JSON parser — identical reasoning
to the pre-existing Stripe webhook mount, since HMAC verification needs the
exact raw bytes). `src/services/commerceWebhookReceive.service.ts`'s
`receiveWooCommerceWebhook` (:41) does the documented minimum synchronously:
verify signature (`lib/woocommerce/webhookSignature.ts`'s
`verifyWooCommerceWebhookSignature`, HMAC-SHA256 over the raw body,
constant-time compared), write to `commerce_webhook_events` keyed by a
derived `provider_event_id`, return.

**WooCommerce has no built-in webhook idempotency key** (its
`X-WC-Webhook-Delivery-ID` increments per delivery *attempt*, including
retries, so it can't detect "this is a resend of the same event"). Solved
by deriving `provider_event_id` from `(topic, resource id, the resource's
own date_modified)` (`commerceWebhookReceive.service.ts:31-34`, with a
raw-body-hash fallback if `date_modified` is absent) — a genuine retry
resends byte-identical data including the same `date_modified` and
correctly collides; two real, different state changes on the same resource
always carry different `date_modified` values and are never deduped
against each other. Both properties proven by dedicated tests in
`tests/integration/commerceWebhook.integration.test.ts` (6 tests total).

Actual processing (`src/services/commerceWebhookProcessing.service.ts`'s
`processCommerceWebhookEvent`, :26) runs in a separate BullMQ job (a new,
dedicated `commerce-queue` — `src/lib/commerceQueue.ts` — not the crawl
queue, consumed by a second `Worker` registered in `src/worker.ts`), never
inside the HTTP handler. **Critically: it always re-fetches fresh order
state via `getOrderStatus()` and re-runs `PaymentConfirmationPolicy`
(through `transitionOrderState`) — it never transitions state based on the
stored webhook payload's claimed status alone**, proven by
`tests/integration/commerceWebhookProcessing.integration.test.ts` (3
tests): one asserting the real WooCommerce mock is actually called with the
right order id, one asserting a payload claiming `"status": "processing"`
does **not** transition when the fresh mocked fetch disagrees, and one
confirming an `order.*` event for a `woocommerce_order_id` never created
through this pipeline is safely ignored rather than erroring.

`PaymentReconciliationJob` (`src/services/paymentReconciliation.service.ts`'s
`runPaymentReconciliation`, :24) — a real repeatable BullMQ job
(`ensurePaymentReconciliationSchedulerRegistered`, idempotent registration,
same pattern as the pre-existing recrawl scheduler), 10-minute default
cadence, finds `PENDING_PAYMENT` orders older than a 5-minute default
threshold and re-verifies each through the exact same `transitionOrderState`
service every other path uses — no parallel verification logic.

**Phase 1 scope boundary, flagged explicitly**: only the
`PENDING_PAYMENT → PAID` transition is webhook/reconciliation-driven.
Cancellation/refund webhook-driven transitions are not implemented — "no
refunds" is explicitly out of Phase 1 scope per the originating request.

### Notifying the customer after they've left (§7)

`src/services/commerceNotification.service.ts` — `createPaymentConfirmedNotification`
(:39) writes a `customer_notifications` row the instant a real PAID
transition completes (called from `orderState.service.ts`, post-commit —
see the deadlock fix above for why not inside the transaction).
`drainUndeliveredNotifications` (:50) is called at the very start of the
commerce entrypoint (`src/langgraph/commerceEntrypoint.ts:68-74`) for
whichever `customerId` a given turn resolves, marking rows delivered in the
same call so a notification surfaces at most once. Proven end-to-end (not
just via the isolated notification service's own writes) by the webhook-
processing integration test above, which asserts a real
`customer_notifications` row exists with the correct booking number after
a real webhook-driven PAID transition.

### Per-tenant, per-customer identity (§8)

`src/services/customerIdentity.service.ts` — `customer_identities.id` is
the key threaded through `commerce_orders`, `commerce_tickets`, and
`customer_notifications`, never a raw email/phone. `VerificationLevel`
(:8) and `VERIFICATION_LEVEL_RANK` (:13) are real, enforced (not just
documented) — `getVerificationLevel`/`promoteVerificationLevel` (:91,107)
back `toolAuthorization.service.ts`'s per-operation check. A customer is
promoted to `ORDER_VERIFIED` only by `orderState.service.ts`'s real PAID
transition (:157) — proof they controlled that identity through a real,
independently-confirmed payment, never a verbal claim.
`customerBelongsToChatbot` (:84) is the tenant-isolation primitive every
tool call checks. `ACCOUNT_VERIFIED` is defined and reachable in the type
system per the explicit "the check points and the enum must exist so this
isn't a retrofit later" instruction, but Phase 1 builds no
address-change/cancellation tool that would actually require it.

### Explicit tool authorization layer (§9)

`src/services/toolAuthorization.service.ts`'s `authorizeToolCall` (:61) is
the single choke point every Service-layer function (`productCatalog`/
`commerceOrder`/`commerceTicket.service.ts`) calls **internally**, first
thing, on every one of its own exported entry points — not an optional
wrapper a tool implementation could forget to apply. Four checks, every
call, no exceptions: (1) tenant — `hasWooCommerceConnected` +
`requireFullCustomPlan`, re-checked fresh every time (a plan downgrade mid-
life is caught immediately, not just at connect time); (2) cross-tenant
isolation — a resolved `customerId` must belong to the calling chatbot;
(3) per-operation verification-level requirement (§8's table, `REQUIRED_VERIFICATION`,
:29-36); (4) resource-level ownership for an order/ticket lookup.

Proven by `tests/integration/commerceToolAuthorization.integration.test.ts`
(7 tests), including the explicit §13 AI-security requirement: "a Store A
conversation asking about Store B's products/data is denied — tenant
isolation holds even under adversarial prompting" — the test supplies
Store B's real `customerId`/order id directly to a Store A tool call
(simulating a customer/injected input that somehow knows or guesses
another tenant's real internal id) and confirms it's rejected every time,
never silently succeeding.

### Support / ticketing (§10)

`src/services/commerceTicket.service.ts` — `createTicket`/`getTicketForCustomer`
both route through `authorizeToolCall`. Order/ticket status is answered via
direct deterministic database lookup
(`langgraph/nodes.ts`'s `orderStatusLookupNode`, :294) — **no LLM call
anywhere in that node** (documented explicitly in its own header comment),
and it always re-verifies via `transitionOrderState` before reporting
anything, which is what makes a bare "I already paid, give me my booking
number" claim unable to produce a booking number on its own — this exact
property is what `commerceOrderState.integration.test.ts`'s "does NOT
transition... this is what makes a bare 'I already paid' claim unable to
produce one" test proves at the service level (the layer
`orderStatusLookupNode` itself is a thin, LLM-free caller of).

### Observability (§11)

Every transition (`orderState.service.ts`), payment-policy evaluation,
authorization decision (`toolAuthorization.service.ts`), and graph node
(`langgraph/nodes.ts`) logs through the existing structured logger (`log()`)
with `requestId`/`graphRunId`/`toolCallId`/`chatbotId`/`customerId`/
`woocommerceOrderId` threaded through consistently — visible directly in
every test run's log output above (e.g. `"payment confirmation policy
evaluated"` lines carrying the exact `reason` string that decided a real
payment outcome). `conversation_id` is represented by the graph's own
`thread_id` (the conversation/session id), which every checkpointed state
snapshot and log line can be correlated back to.

### Gating and security (§12)

The entire feature is gated behind Full Custom via the existing
`getEntitlementForChatbot` pattern, checked in three independent places
that all must agree: `commerceCredentials.service.ts`'s `connectWooCommerce`
(write-time), `toolAuthorization.service.ts`'s `authorizeToolCall` (every
tool call, live), and `commerceEntrypoint.ts`'s `isCommerceChatbot`
(:26-30, the chat-routing decision itself). All three secrets
(`consumer_key`/`consumer_secret`/`webhook_secret`) are encrypted at rest,
owner-scoped, write-only via the API (`POST /chatbots/:chatbotId/woocommerce`,
`chatbot.routes.ts`) — no update path, reconnect via delete+recreate.

### Explicit citations, per the originating request

**(a) The existing Free/Crawl Plus pipeline was not touched.** Verified
two ways: (1) `git`-equivalent inspection — `src/lib/answerChatbotQuestion.ts`
and `src/lib/ai.ts` have zero diffs from this pass; the only changes to
`chatbot.service.ts`/`public.service.ts` are a single new early-return
block each (`tryAnswerWithCommerceGraph`, checked and short-circuited
*before* any existing code runs) that is a no-op for every chatbot without
a connected WooCommerce store. (2) The full pre-existing test suite (195
tests, unchanged in behavior) still passes unmodified except one
unrelated, pre-existing flakiness fix (`rateLimitAuthenticatedChat.integration.test.ts`
mocking `modelSelection.service.js` for the same real-Gemini-quota reason
documented in §9's gaps — this fix is identical in kind to prior sessions'
fixes for the same root cause in `public.integration.test.ts`/
`security.integration.test.ts`, not something this pass's commerce code
caused).

**(b) `WooCommerceConnector.createOrder()` has exactly one caller in the
entire codebase**: `src/services/commerceOrder.service.ts:140`, inside
`commitOrder`, called only from `langgraph/nodes.ts:235`'s `commit_order`
node. Verified by `grep -rn "\bcreateOrder(" src` (excluding the
function's own definition and doc comments referencing it by name).

**(c) `commerce_orders.status` is written only through
`transition_order_state`**: `src/services/orderState.service.ts:152,232`
are the only two `update commerce_orders set status` statements anywhere
in `src/`, both inside `transitionOrderState`/its internal `confirmAndPay`
helper. Verified by grep across the full `src/` tree.

**(d) No booking number is ever generated outside the transactional flow
in §5**: `generateBookingNumberCandidate()` (`lib/woocommerce/bookingNumber.ts:14`)
has exactly one call site in the entire codebase —
`orderState.service.ts:140`, inside `confirmAndPay`, which only ever runs
inside `transitionOrderState`'s `SELECT ... FOR UPDATE`-locked transaction.
Verified by grep.

**(e) The concurrent-webhook race test actually exercises real
concurrency, not a mocked lock**: confirmed by direct observation during
development — the original (buggy) implementation caused this exact test
to hang indefinitely (reproduced independently with a minimal standalone
script outside vitest, ruling out a test-framework artifact), which is
only possible if the two `Promise.all`-dispatched calls were genuinely
racing at the real Postgres connection/lock level, not resolved
sequentially through any in-process mock. After the fix, the test passes
deterministically because the real `FOR UPDATE` lock correctly serializes
the two real connections.

**(f) What's not completed, and exactly why**:
- **No real WooCommerce store was reachable in this environment** — every
  WooCommerce API interaction across all 58 new tests is mocked at the
  `lib/woocommerce/connector.ts` boundary (fetch-level in the connector's
  own unit tests, function-level everywhere else). The connector's request/
  response shapes are built directly from WooCommerce's real, documented
  REST API v3 schema, but none of it has been exercised against a live
  store. Per the same honesty standard as §9's Stripe test-checkout gap:
  stated plainly, not asserted as tested.
- **No frontend/dashboard UI was built for connecting a WooCommerce store**
  or viewing commerce orders/tickets — the spec was scoped to backend
  architecture; the API layer (`POST /chatbots/:chatbotId/woocommerce`
  etc.) is complete and ready for a UI to be built against, but an owner
  today would need to call it directly (curl/API client), not through the
  dashboard.
- **PROCESSING → SHIPPED → DELIVERED has no automated trigger** — these
  remain valid, enforced states in the machine, reachable only via a
  manual `transitionOrderState` call (no admin UI/route exposes this
  either — not built).
- **Cancellation/refund flows are entirely absent**, both from the
  webhook-processing dispatcher and as a customer-facing tool — explicitly
  "no refunds" in Phase 1 scope, but flagged so it's not mistaken for an
  oversight.
- **`ACCOUNT_VERIFIED` is defined but unreachable** — no tool requires it
  and nothing promotes a customer to it, since no
  address-change/cancellation tool exists yet to need it.
- **Real embedding-based product search depends on `OPENAI_API_KEY`**
  (`src/services/embeddings.service.ts`) — falls back to a plain SQL
  `ILIKE` match when unset, never a hard failure, but this wasn't specified
  in the spec and is flagged as an ASSUMPTION (embedding provider/model
  choice: OpenAI `text-embedding-3-small`).
- **The graph's own reasoning model (classification, draft extraction,
  confirmation parsing) also reuses `OPENAI_API_KEY`** via `@langchain/openai`'s
  `ChatOpenAI` (`gpt-4o-mini`) — a chatbot owner without an OpenAI key
  configured cannot use this pipeline at all yet (a clear, immediate
  failure at graph entry, not a silent degrade — this feature cannot
  degrade further, since it fundamentally requires an LLM). Flagged as an
  ASSUMPTION: no LLM provider was specified for the graph itself.
- **`build_order_draft`/`confirm_with_customer`'s LLM extraction and yes/no
  classification are real but not exhaustively prompt-tuned** — the full
  end-to-end test proves the control-flow/interrupt/commit mechanics work
  correctly, not that the conversational UX handles every phrasing a real
  customer might use.

### Post-report fix: initial catalog sync on connect (2026-09-09)

Caught while writing the WordPress/WooCommerce connection walkthrough:
`connectWooCommerce` (`commerceCredentials.service.ts:76`) inserted the
credential row but never populated `product_catalog_cache` — a freshly-
connected store would answer zero product questions until each product
individually fired a `product.updated` webhook. **Fixed**: `connectWooCommerce`
now enqueues a new `sync-catalog` job (`lib/commerceQueue.ts`'s
`enqueueCatalogSync`, :29-31) on the commerce queue right after a
successful connect — background, not synchronous, same discipline as
enqueuing a crawl job on chatbot creation. The worker (`worker.ts`,
`"sync-catalog"` handler) calls the already-existing
`productCatalog.service.ts`'s `syncProductCatalog` against the real
WooCommerce credentials. Also added `POST /chatbots/:chatbotId/woocommerce/sync`
(`commerceWooCommerce.controller.ts`'s `postWooCommerceSync`, Full-Custom-gated,
202 response) for a manual re-sync later — e.g. after bulk-adding products
in WordPress without waiting for each one's own webhook. Verified:
`tsc --noEmit` clean, 0 lint issues, full suite still 253/253 (no new
dedicated test for the enqueue-on-connect call itself — flagged as a small
follow-up gap, not yet covered).

## §14 — Bookly scheduling integration + cross-tenant/authorization/
concurrency hardening (2026-09-11)

A second Full Custom tool integration, built as a sibling to §9-§12's
WooCommerce commerce pipeline — same architecture, same choke points, no
new authorization framework and no new usage-tracking system, per the
explicit instruction this pass was scoped under. Bookly itself (the
scheduling product this integrates with) is a separate repo/codebase
(`C:\Users\zainr\Downloads\helebooker\backend` — Express + Postgres, its
own JWT auth, its own double-booking-proof `EXCLUDE` constraint). This
section covers both what changed here and the one small, necessary change
made in that sibling repo, called out explicitly per the task's own
instructions.

### Base integration (mirrors §9-§12 exactly)

- `db/schema.sql:648-696` — `chatbot_bookly_credentials` (one row per
  chatbot: `base_url`, `resource_id`, `resource_label`,
  `api_key_encrypted`) and `chatbot_bookly_appointments` (ChatMate360's own
  mirror of a booking attempt, NOT the source of truth — Bookly's own
  `appointments` table is). Same write-once/no-update-path discipline as
  `chatbot_woocommerce_credentials`.
- `src/services/booklyCredentials.service.ts` — CRUD, encrypted at rest
  with the SAME `lib/crypto.ts` AES-256-GCM infra WooCommerce/Custom
  Actions already use (no second encryption key), gated to Full Custom via
  the SAME `requireFullCustomPlan` export `commerceCredentials.service.ts`
  already defines (:97, imported not reimplemented). `connectBookly`
  (:85-142) makes a real `getAvailableSlots` call against the supplied
  credentials before writing the row — an unreachable server, bad API key,
  or wrong resource id fails at the settings-save step with a clear 400,
  never silently at booking time (mirrors the exact principle Bookly's own
  Google-Meet-requires-Google-sync validation already established, per
  §4.1 of the Bookly README).
- `src/lib/bookly/connector.ts` — mirrors `lib/woocommerce/connector.ts`
  exactly: `assertSafeUrl` on every call (:44, same SSRF re-check-per-call
  discipline, never a cached DNS result), 8s timeout, no retries.
- `src/services/booklyBooking.service.ts` — `commitBooking` (:100)
  mirrors `commerceOrder.service.ts`'s `commitOrder` idempotency-claim
  protocol exactly (claim row → real Bookly call → resolve), adapted to
  Bookly's real conflict signal (a 409 from Bookly's own `EXCLUDE`
  constraint, surfaced via `isBooklyConflict`, :162) instead of
  WooCommerce's order-id concept.
- `src/services/toolAuthorization.service.ts` — extended, not replaced:
  `ToolOperation` gained 5 Bookly operations (:17-30); the existing 4-step
  policy gained a operation-family branch at step 1 (:113-133, checks
  `hasBooklyConnected` instead of `hasWooCommerceConnected` for Bookly
  ops) and a `bookly_appointment` resource type at step 4 (:161-186), plus
  a small step 5 (:188-199) resolving the chatbot's one configured
  resource id for `book_appointment`/`check_availability`. Every check
  order, log line, and error-shape convention is identical to the
  WooCommerce path.
- Routes: `GET/POST/DELETE /chatbots/:chatbotId/bookly`
  (`src/routes/chatbot.routes.ts`), same auth/plan-gating/validation
  pattern as the WooCommerce routes immediately above them.
- **ASSUMPTION** (flagged, same standard as §9's WooCommerce gaps): no
  frontend/dashboard UI was built for connecting a Bookly resource — the
  API layer is complete and tested; an owner would call it directly today.
  No LangGraph tool-calling node was wired up either (the LLM-facing
  "book me an appointment" conversational flow commerce has via
  `commerceGraph.ts`) — this pass built the service/authorization layer
  the five hardening requirements needed to be real, testable guarantees
  against, not the conversational graph on top of it. That graph wiring is
  real, unbuilt follow-up work, structurally identical to wiring
  `commitOrder` into `commerceGraph.ts`.

### The five hardening requirements

**1. Cross-tenant isolation — explicit test.**
`tests/integration/booklyToolAuthorization.integration.test.ts`: a real
appointment seeded for chatbot B is proven unreachable from chatbot A's
resolved customer via `getBookingForCustomer`/`cancelBookingForCustomer`/
`rescheduleBookingForCustomer`, with the connector spied to confirm Bookly
is never even called (404, not a leaked "exists but not yours" signal —
same discipline as every other cross-tenant check in this codebase).
Revocation (modeled here as `disconnectBookly` removing the credential
row, since a Bookly-issued key's validity is Bookly's own concern — see
item 2) is proven rejected on every one of `get`/`cancel`/`reschedule`/
`book`, not just the first tried. 4/4 passing.

**2. API key leakage prevention — explicit acceptance criteria, checked.**
The generation/comparison/revocation primitives live in the sibling Bookly
repo (`backend/src/lib/apiKeys.js`) since Bookly is the server that
actually authenticates these keys — ChatMate360 only stores one, encrypted
(`api_key_encrypted`, above). Per-criterion:
  - **Cryptographically strong generation**: `backend/src/lib/apiKeys.js:20-21`
    — `crypto.randomBytes(8)` (prefix) + `crypto.randomBytes(32)` (secret),
    never `Math.random`/sequential. Verified by
    `backend/tests/apiKeys.unit.test.js` (25 concurrently-generated keys,
    zero collisions, format-checked for real entropy).
  - **Constant-time comparison**: `backend/src/lib/apiKeys.js:55` —
    `crypto.timingSafeEqual` against the stored hash, looked up by a
    non-secret prefix first (never a plain `===`/string-equality check on
    the hash itself, per the explicit instruction). Verified: a key
    differing by one character, and a forged key sharing a real prefix but
    a wrong secret, are both rejected (`apiKeys.unit.test.js`).
  - **Revocation checked on every request, never cached**:
    `backend/src/lib/apiKeys.js:63` — `verifyApiKey` re-reads
    `revoked_at` from Postgres on every single call; nothing caches a
    verified key across requests. Verified end-to-end across all 4
    operation types in `backend/tests/apiKeyAuth.test.js`
    ("a revoked key is rejected on every operation type").
  - **Leakage audit — grep-level check, then fix**: performed across both
    codebases. **One real finding, fixed**: `backend/src/logger.js` had NO
    pino `redact` config at all — `pino-http`'s default request logging
    printed the full `Authorization: Bearer <raw key>` header in plaintext
    on every request, confirmed live in this session's own race-condition
    test output before the fix. **Fixed**
    (`backend/src/logger.js` — added `redact: { paths:
    ['req.headers.authorization', '*.api_key', '*.apiKey', '*.token'] }`)
    and **re-verified**: the same test's log output now shows
    `"authorization":"[redacted]"`. ChatMate360's own logger
    (`src/lib/logger.ts:27`) already redacted `*.apiKey`/`*.api_key`
    before this pass — audited, no additional finding there. Also
    checked: neither `getBooklyConnectionStatus` nor `connectBookly`'s
    response type (`BooklyConnectionStatus`) includes the key field;
    Bookly's own `GET /api-keys` returns `key_prefix` only, never
    `key_hash` or the raw key (verified,
    `backend/tests/apiKeyAuth.test.js`'s "the raw key is never returned
    again" test); the key is sent via the `Authorization` header, never a
    URL query string, on both the ChatMate360 connector
    (`src/lib/bookly/connector.ts:51`) and Bookly's own verification
    middleware (`backend/src/middleware/apiKeyAuth.js`); no frontend
    exists for this integration (see base-integration gaps above), so
    there is no frontend-state surface to audit.

**3. Explicit authorization ordering — enforced in code, tested.**
`booklyBooking.service.ts`'s every exported function calls
`authorizeToolCall()` (step 1: plan/tenant, step 2: cross-tenant customer
+ resource ownership) as its literal first line — `getDecryptedBooklyCredentials`
and the Bookly connector are only ever reached afterward (`commitBooking`,
:111 then :151-152). `tests/integration/booklyAuthorizationOrdering.integration.test.ts`
spies on the connector and proves it is never invoked when: the plan isn't
Full Custom, there's no Bookly connection at all, the customer_id belongs
to a different chatbot, or the target appointment belongs to a different
chatbot — 4 failure-path tests, each asserting zero connector calls — plus
one sanity-check test proving a fully-authorized request DOES reach the
real call. 5/5 passing.

**4. Concurrent booking race condition — real integration test.**
`tests/integration/booklyBookingRace.integration.test.ts` spawns the REAL
sibling Bookly server (`backend/src/server.js`) against its own real test
Postgres, seeds a resource with wide-open availability directly in
Bookly's database, issues it a real resource-scoped API key, wires a
ChatMate360 chatbot to it, then fires two `commitBooking()` calls
concurrently (through the full ChatMate360 → Bookly HTTP path, different
idempotency keys, identical resource+slot) and asserts: exactly one
resolves CONFIRMED, the other rejects with a clean typed `AppError` in the
4xx range (never a raw 500), and Bookly's own `appointments` table (the
real source of truth) contains exactly one `CONFIRMED` row for that
slot — proving the integration layer introduces no race of its own on top
of Bookly's `EXCLUDE` constraint (already proven standalone by Bookly's
own `backend/tests/doubleBooking.test.js`). Stable across repeated runs
(3/3 clean). One deliberate, narrowly-scoped test-only exception: this
file mocks `lib/crawler/ssrf.ts`'s `assertSafeUrl` (loopback/RFC1918
targets are — correctly, permanently — blocked by that shared check, see
`tests/unit/ssrf.test.ts`; there is no way to reach a same-machine test
server without such an address). Nothing else in the path is mocked — the
real `fetch()`, the real spawned process, and the real Postgres constraint
all run live.

**5. Concurrent usage-cap enforcement — atomic check-and-increment.**
Fixed **platform-wide**, not just for Bookly — this is the change with the
broadest blast radius in this pass, since `usage.service.ts`'s cost cap
gates every AI call for every chatbot, not only ones with a Bookly or
WooCommerce integration. The prior shape
(`isModelQuotaAvailable`/`isOverCostCap`) was a plain read-then-write: N
concurrent messages for the same chatbot could all read "under cap" before
any of them had `recordUsage`'d real cost, collectively overspending past
the cap. **Fix** (`usage.service.ts:136-183`, `reserveModelCostSlot`): a
single atomic `redis.incrbyfloat` reserves a flat, conservative per-call
estimate (`env.perCallCostReservationUsd`, default $0.05) against the SAME
Redis counter `getModelPeriodCostUsd`'s cache already uses (not a second,
parallel usage-tracking system — this only changes how that one counter is
touched at the check step), compares the post-increment total against the
cap in the same round trip, and rolls back the reservation if it's over.
`commit(actualCostUsd)` true-ups the counter to the real cost once known
(after the AI call completes) via a second atomic increment. Chosen
explicitly over the heavier Postgres-row-lock pattern
`commerceOrder.service.ts`'s idempotency claim or a payment-confirmation
flow would use, because — unlike those, which run once per order/payment —
this check runs on every AI call platform-wide; a DB round trip + row lock
on that hot path would cost real per-message latency for every chatbot,
for a guarantee one already-in-use Redis command provides. Wired into the
real request path in `lib/answerChatbotQuestion.ts:265-306`: the
reservation is taken right after the model is selected/pinned (the point
where a real, billable AI call is about to start) and released with the
real cost right after `recordUsage`. A denied reservation returns the same
graceful fallback (`gateReason: "cost_cap_exceeded"`) `checkAnsweringGate`
already uses — no new user-facing behavior, just a race-safe path to the
same outcome. **Test**
(`tests/integration/usageReservation.integration.test.ts`): three
simultaneous reservation calls against a cap sized to admit exactly one
prove exactly 1 is admitted and 2 are cleanly denied — not 3, which the
prior read-then-write shape would have allowed — plus a true-up-correctness
test and an already-over-cap test. 3/3 passing.

### Verification

- ChatMate360: `npx tsc --noEmit` clean. Full suite: **46 files / 276
  tests passing** (up from 253 before this pass — 23 new tests across the
  4 new integration test files above; the base integration has no
  dedicated test file of its own, since the hardening tests exercise it
  directly end-to-end).
- Bookly (`backend`): full suite **17 files / 56 tests passing** (up from
  47 at the end of Part A — 9 new tests: `apiKeyAuth.test.js` (5) and
  `apiKeys.unit.test.js` (4)).
- Both suites re-run clean after the logger redaction fix.

## §15 — Admin-chat automation + hardening (2026-09-12)

Two things, layered on top of §14's Bookly integration: (1) embedding the
public ChatMate360 widget on Bookly's own marketing site, using only the
existing customer-facing tool set, and (2) a genuinely NEW, deliberately
separate admin-only tool set letting a logged-in Bookly ADMIN manage
resources/scheduling by chat. The six hardening items below were specified
against this second half specifically — every one is a real, passing test,
not a description.

### Prerequisite gap found and closed: the customer-facing Bookly tool set had no LLM wiring

§14 built Bookly's service/authorization layer (`booklyBooking.service.ts`,
`toolAuthorization.service.ts`) but explicitly flagged "no LangGraph
tool-calling node was wired up" — unlike WooCommerce, which has a full
conversational graph (`commerceGraph.ts`). The embed task assumes a
working "already-built booking tool set," which turned out not to exist at
the LLM layer yet. Built now, mirroring `commerceGraph.ts`/`nodes.ts`
exactly:
- `src/langgraph/booklyState.ts`, `booklyNodes.ts`, `booklyGraph.ts`,
  `booklyEntrypoint.ts` — classify_intent → check_availability →
  build_booking_draft → confirm_with_customer → final_validation →
  commit_booking, plus a deterministic appointment_status_lookup. Wired
  into `chatbot.service.ts`/`public.service.ts` right after the existing
  commerce-graph check.
- `src/services/booklyBooking.service.ts` gained `checkAvailabilityForChatbot`
  and `listBookingsForCustomer` (:86, :199) — the two reads the graph
  needed that didn't exist yet, both going through the same
  `authorizeToolCall`-first discipline as every other function in the file.
- **Scope narrowed deliberately, not silently**: cancel/reschedule via chat
  were NOT built in this pass (the customer-facing service functions exist
  from §14, but no graph node calls them) — this session's priority was
  the admin-chat hardening work below, which needed a real customer flow
  to be distinct FROM, not an exhaustive one. Flagged as real, unbuilt
  follow-up work, not hidden.
- **`booklyEntrypoint.ts:70`** — a genuine mid-session correction: a
  Bookly-connected chatbot must still answer ordinary site-content
  questions through the same widget, not just scheduling. When
  `classify_intent` returns `"other"` and the graph isn't mid-interrupt,
  the entrypoint now returns `handled: false` so the caller falls through
  to the normal crawled-content Q&A pipeline (`answerChatbotQuestion.ts`)
  instead of dead-ending. An interrupted turn (mid-booking) never falls
  through, regardless of intent — a real conversation in progress always
  gets its own follow-up question.

### Part 1 — Public widget embed (Bookly frontend)

- `frontend/components/ChatMate360Widget.tsx` (Bookly repo) — renders
  ChatMate360's standard `<script data-chatbot-id data-widget-base>` embed
  tag via three optional `NEXT_PUBLIC_CHATMATE360_*` env vars; renders
  nothing if any are unset (same "optional integration degrades
  gracefully" pattern as every other integration in Bookly). Mounted in
  `frontend/app/(marketing)/layout.tsx`.
- Uses ONLY the existing resource-scoped API-key mechanism (§14) — no new
  ChatMate360-backend capability for this half.
- **Gap, disclosed**: ChatMate360's own widget-hosting frontend (the
  iframe page `env.frontendUrl` serves at `/widget/:chatbotId`) is not
  part of the repo checkout available in this session — only its backend
  (`Chatmate360-Backend-main`) is. The embed script, the domain-authorization
  check, and the Bookly-side graph dispatch are all real and tested at the
  API level; the actual browser-rendered iframe could not be visually
  smoke-tested end-to-end in this pass.

### Part 2 — Admin-chat automation (the new, separate tool set)

Kept structurally distinct from the customer-facing tool set per the
explicit "never merge these under any circumstances" requirement — not by
convention, but because they are different modules, different graphs,
different route, and (critically) different auth models entirely:

- `db/schema.sql` — `chatbot_bookly_admin_audit_log`, tenant-scoped by
  `chatbot_id` (see item 5 below).
- `src/lib/bookly/adminConnector.ts` — the only path to Bookly's ADMIN-only
  REST endpoints (`GET /auth/me`, `POST /resources`, `POST /resources/:id/availability-rules`,
  `POST /resources/:id/exceptions`). Every call sends the **admin's own raw
  JWT** as the Bearer token — never a stored/elevated ChatMate360 credential
  — same SSRF/timeout discipline as `connector.ts`.
- `src/services/booklyAdminAuth.service.ts:26` — `requireBooklyAdminSession`,
  the single choke point every admin-chat call goes through: calls
  Bookly's real `GET /auth/me` fresh, confirms `role === "ADMIN"` and
  `is_active`, throws a typed `AppError` otherwise (:28 no token, :41
  Bookly unreachable, :46 invalid/expired/revoked, :50 not ADMIN, :54
  deactivated). **No cache, no memoization, by design** — see item 2.
- `src/services/booklyAdmin.service.ts` — thin tool wrappers
  (`createResourceAsAdmin`, `setAvailabilityRuleAsAdmin`,
  `addExceptionAsAdmin`): `authorizeToolCall` first (defense in depth, see
  item 1), then the real Bookly REST call using the admin's own token, then
  an audit write either way (success or failure).
- `src/services/toolAuthorization.service.ts` — extended with 3 admin
  operations and a new step 0 (before the existing 5 steps): rejects
  outright if `req.adminId` is missing, regardless of what a tool
  implementation claims — the policy re-derives whether the operation
  needs a verified admin, it doesn't trust a caller's say-so.
- `src/langgraph/booklyAdminState.ts`, `booklyAdminNodes.ts`,
  `booklyAdminGraph.ts`, `booklyAdminChatEntrypoint.ts:33` —
  classify_admin_intent → build_action_draft → **confirm_admin_action
  (unconditional interrupt, every single time)** → execute_admin_action.
  The admin's raw JWT is threaded through LangGraph's `config.configurable`
  per-turn (`booklyAdminNodes.ts`'s `executeAdminActionNode`), never through
  graph state, because graph state IS persisted to Postgres by the
  checkpointer and a live credential must never land there.
- New route: `POST /chatbots/:chatbotId/bookly-admin-chat` — deliberately
  NOT behind ChatMate360's own dashboard auth; the Bookly admin's JWT in
  the body is the entire trust model, re-verified live on every call.
  `GET /chatbots/:chatbotId/bookly-admin-audit-log` (behind ChatMate360's
  own dashboard auth) lets an owner review what the automation has done.
- Bookly frontend: `frontend/components/BooklyAdminChatPanel.tsx` +
  `frontend/app/(dashboard)/assistant/page.tsx` (ADMIN-only via
  `AuthGuard roles={['ADMIN']}`) + `frontend/lib/adminChat.ts` — sends this
  admin's own JWT (`getToken()`, the same token used for every other
  Bookly API call) with every single message.
- **Scope narrowed, disclosed**: only 3 admin tools were built
  (`create_resource`, `set_availability_rule`, `add_exception`) —
  `configure_calendar_provider` was not, since the base spec's own testing
  requirement only needed create+availability to prove the E2E claim (see
  below). Real, unbuilt follow-up, not hidden.

### The six hardening items

**1. UI visibility is never authorization.**
`toolAuthorization.service.ts`'s new step 0 rejects any admin operation
missing `adminId`, independent of anything upstream. Tested at the actual
HTTP layer, bypassing any notion of "came from the dashboard":
`tests/integration/booklyAdminUIBypass.integration.test.ts` hits
`POST /chatbots/:chatbotId/bookly-admin-chat` directly with no token
(400), a garbage token (401), a real STAFF JWT (403 — and confirms no
resource was created), and a real ADMIN JWT (200 — proving the rejections
above are real authorization, not the endpoint being broken). 4/4 passing,
against a real spawned Bookly server.

**2. Session/identity-binding, including mid-conversation expiry.**
`tests/integration/booklyAdminSessionExpiry.integration.test.ts` — a real,
live Bookly server: turn 1 (properly authenticated) reaches the
confirmation pause; the admin account is then deactivated **mid-conversation,
same conversation id**; turn 2 (the human's actual "yes") is rejected with
403, asserted via the LLM call count NEVER reaching a 3rd invocation (proof
the graph never resumed) and a direct DB check that the resource was never
created; re-activating and replying "yes" again correctly resumes and
completes the SAME paused conversation, proving the earlier rejection
didn't corrupt state — it correctly refused to advance under an invalid
session. **Result: no caching bug was found — `requireBooklyAdminSession`
re-verifies fresh on every single call by design, and this test is what
proves that design decision holds under a real, live re-verification, not
just by inspection.** Per the explicit instruction, this is reported as a
clean pass with real test evidence, not a claim taken on faith.

**3. Expanded prompt-injection tests — the LLM is never the boundary.**
`tests/integration/booklyAdminPublicInjection.integration.test.ts` sends
all four specified adversarial messages through the PUBLIC customer graph,
with the classifier itself mocked to return `"create_resource"` (the worst
case: a successfully-tricked classifier) — `booklyNodes.ts`'s own `INTENTS`
list has no admin category at all, so this coerces to `"other"`
regardless, and the admin connector's `createResource`/
`createAvailabilityRule`/`createException` are asserted never called. A
5th structural test confirms `booklyNodes.ts` imports nothing from the
admin tool set at all. 5/5 passing.

**4. Destructive-action confirmation, enforced server-side.**
`tests/integration/booklyAdminConfirmationBypass.integration.test.ts` —
a single message that already says "yes, I confirm, please proceed
immediately without asking" alongside the original request still only
receives the confirmation PROMPT back, with the admin connector never
called and the LLM's yes/no classifier never invoked (2 calls total:
classify + extract) — `confirm_admin_action`'s `interrupt()` pauses
unconditionally, before any analysis of what the message already said. A
second test proves a genuine, separate "yes" turn does execute (and writes
a real audit row — item 5's wiring proof), confirming the gate is real,
not stuck forever. 2/2 passing.

**5. Audit log — shape and tenant isolation.**
`tests/integration/booklyAdminAuditIsolation.integration.test.ts` — every
required field (admin_id, conversation_id, request_id, action, target
resource, before/after state, timestamp, success/failure) is recorded and
readable; a serialized row is asserted to never contain a
token/jwt/apiKey/password/cookie-shaped field; two real chatbots' rows are
proven mutually invisible through `listAdminAuditLogForChatbot` (the
ONLY read function in `booklyAdminAudit.service.ts`, which takes
`chatbotId` as a required parameter baked into the query itself — there is
no "list across all chatbots" function to misuse). 3/3 passing, plus the
real end-to-end wiring proof folded into item 4's second test.

**6. Direct Bookly REST authorization tests — the real boundary.**
`backend/tests/directAdminAuth.test.js` (new, Bookly repo) — exercises
`POST /resources` directly over real HTTP, no ChatMate360 involved: a
resource-scoped booking API key (401 — a key isn't even a JWT), a STAFF
session (403), no session at all (401), and a real ADMIN session (201),
each confirmed against the database. 4/4 passing.

### Verification

- ChatMate360: `npx tsc --noEmit` clean. Full suite: **51 files / 291
  tests passing** (up from 46/276 — 8 new admin-chat/hardening test files,
  15 new tests, plus the pre-existing `booklyAdminPublicInjection` test's
  expectation updated for the Q&A-fallthrough fix above).
- Bookly (`backend`): full suite **18 files / 60 tests passing** (up from
  17/56 — `directAdminAuth.test.js`, 4 tests).
- `next build` (Bookly frontend) clean, including the new `/assistant`
  route and `ChatMate360Widget`/`BooklyAdminChatPanel` components.

## §16 — Multi-resource booking, admin reassignment, notes/attachments (2026-09-12)

Three capabilities added on top of §15, after resolving two ambiguities in
the request up front rather than guessing: **"customers and staff can
create resources"** was confirmed to mean *booking* an appointment (no
change to the existing ADMIN-only resource-creation permission model —
verified against the real Bookly database first, which showed resources
have no formal link to user accounts), and **"staff member" maps to an
existing Bookly `resources` row directly** (no new users→resources
schema — a resource already can and does represent a staff member by
name). The Calendly item was confirmed as busy-time-sync-only, already
built in Part A — no code change needed for it.

### Multi-resource chatbot connections

Previously a chatbot could connect to exactly ONE Bookly resource
(`chatbot_bookly_credentials.resource_id`). Extended, purely additively:

- `db/schema.sql` — `chatbot_bookly_additional_resources` (chatbot_id,
  resource_id, resource_label), separate from the existing single-resource
  columns. Every existing chatbot/test that only ever configured one
  resource is completely unaffected — `listBooklyResourceOptions`
  (`booklyCredentials.service.ts`) returns just that one option when this
  table has no rows for it.
- `addBooklyResource` — same real-Bookly-API validation discipline as
  `connectBookly` itself: a resource id that doesn't exist on the
  connected Bookly server is rejected at settings-save time.
- `toolAuthorization.service.ts` gained a `bookly_resource` ownership
  check: a customer's tool call naming a specific resource must be one
  this chatbot actually configured — 404 (not 403) if it's a real
  resource id belonging to a *different* chatbot's configuration on the
  same Bookly deployment, same "don't reveal whether it exists"
  discipline as every other cross-tenant check.
- `booklyNodes.ts`'s new `select_resource` node asks "who would you like
  to book with?" only when the chatbot has more than one configured
  resource — a single-resource chatbot asks nothing, unchanged behavior.
  **A real bug caught and fixed before it shipped**: the first version
  branched routing on `state.responseText` after this node, but that field
  persists across conversation turns via the LangGraph checkpointer — a
  stale value from an EARLIER, unrelated turn on the same conversation
  thread could have been misread as this turn's outcome. Fixed by routing
  unconditionally to `check_availability` and letting its own existing
  error handling (already tested) cover the zero-resources case instead.
- **Operational note, not a code gap**: a chatbot's stored Bookly API key
  must be unscoped (or scoped broadly enough) to book across all of its
  configured resources — Bookly's own resource-scoped API keys
  (§14 hardening item 2) are tied to exactly one resource. Cross-tenant
  isolation between *different* chatbots is unaffected (still enforced by
  each chatbot having its own key/deployment); this only means a
  single multi-resource chatbot's own key can't ALSO be resource-scoped
  within itself. Flagged here explicitly per the standing instruction to
  call out anything touching the platform-wide security model.
- Test: `tests/integration/booklyMultiResource.integration.test.ts` (4
  tests) — single-resource unchanged, adding a resource validates against
  real Bookly, cross-chatbot resource ids rejected.

### Admin override/reassignment

`db/schema.sql` (Bookly repo) — `appointments.attachment_url`,
`cancellation_reason`, `reassigned_from_resource_id`. Bookly's own
`POST /appointments/:id/reschedule` (`backend/src/services/appointmentService.js`)
now accepts an optional `resource_id` — when it differs from the current
one, the existing cancel-old+create-new transaction additionally marks the
old row's `cancellation_reason` and the new row's `reassigned_from_resource_id`.
`middleware/auth.js`'s new `authenticateIfPresent` (never rejects; only
populates `req.user` when a valid JWT happens to be presented) is what
lets this attribute the change to a real admin name without touching the
endpoint's deliberately-public contract for ordinary customer reschedules.

ChatMate360: `admin_reassign_appointment` (`toolAuthorization.service.ts`,
`booklyAdmin.service.ts`'s `reassignAppointmentAsAdmin`,
`lib/bookly/adminConnector.ts`'s `reassignAppointment`) — identifies the
booking by customer email (most recent upcoming, same simplification as
customer-facing status lookup), re-derives the REAL current duration from
Bookly itself (never hardcoded, so a longer-than-default meeting is never
silently truncated), goes through the SAME unconditional confirmation gate
every other admin action does, and writes the SAME audit shape. The
previously-assigned staff member's notification requirement is satisfied
via the durable `cancellation_reason`/`reassigned_from_resource_id`
markers above — visible through the existing dashboard/API, no new
notification infrastructure built.

Test: `tests/integration/booklyAdminReassignment.integration.test.ts` (2
tests, live Bookly server) — the full reassignment verified end-to-end
(old appointment cancelled with reason, new one created with the
reassignment marker, audit row correct) and the confirmation gate proven
unbypassable by same-turn fake confirmation, mirroring item 4's own test.

### Bot-collected notes and attachments

Notes were already threaded through end-to-end in §15 (`BooklyDraft.notes`
→ `commitBooking` → Bookly's `notes` column). Added `attachmentUrl`
alongside it, end to end: `BooklyDraft`/`CommitBookingInput`/
`CreateBooklyAppointmentInput` (ChatMate360) → `attachment_url` (Bookly's
`createAppointmentSchema`/`appointments` table). **Explicitly a
bot-collected URL, never a file upload** — Bookly has no file storage of
its own, and Google Calendar's native `attachments` field requires Drive
API scopes this integration was never granted; a customer/admin pasting a
Drive (or any) link into chat is captured by the same LLM extraction that
already collects notes, with no new UI, no new upload infrastructure, and
no new failure mode to be resilient against (it's a string field, not an
external call that can fail).

Test: `tests/integration/booklyNotesAndAttachments.integration.test.ts`
(2 tests) — a note and attachment URL are sent to Bookly and present on
the committed booking; both remain fully optional.

### Verification

- ChatMate360: `tsc --noEmit` clean. Full suite **54 files / 299 tests**
  (up from 51/291 — 3 new test files, 8 new tests). One flaky failure
  observed in `booklyAdminReassignment.integration.test.ts` when run as
  part of the FULL 54-file parallel suite (a generic "something went
  wrong" from Bookly-side timeout/contention, not a logic failure) —
  confirmed to pass reliably standalone and when run together with the
  other three live-Bookly-server test files as a group, consistent with
  the same "real spawned server under heavy parallel CI load" flakiness
  class already noted for `booklyBookingRace` and the pre-existing
  `adminAuth.integration.test.ts` (neither caused by nor unique to this
  pass — a known characteristic of testing against genuinely live
  processes rather than mocks, not silently ignored: documented here
  exactly as encountered).
- Bookly (`backend`): full suite still 18 files / 60 tests (no new Bookly
  test file this section — the reschedule/reassignment behavior is
  exercised by ChatMate360's own live-server tests above, plus the
  existing `reschedule.test.js` continuing to pass unchanged for the
  ordinary same-resource case).

## §17 — Meeting notes, attachment sync, and an admin meeting-history document (2026-09-12)

§16's "Bot-collected notes and attachments" only ever wired notes/
attachment through `BooklyDraft` at **booking time**. Two real gaps
remained, both closed here: (1) no way to add a note to an
**already-existing** booking mid-conversation, and (2) `attachment_url`
was accepted and stored end to end but never actually reached the synced
Google Calendar event's description — the schema comment
(`backend/src/db/schema.sql:236-243`) claimed it would be, but
`googleCalendarService.js`'s `createEvent` only ever read `.notes`. Also
built: the admin-facing downloadable meeting-history document, not
started before this pass at all.

### Decision (step 0) — attachment storage: option (b), confirmed, not guessed

Checked both codebases first, per the explicit instruction not to assume:
no document-generation library and no file-storage/upload infrastructure
(no multer, no S3/cloud SDK, no upload route) exists anywhere in either
repo. **Option (b) — link in the Calendar description, no Drive
integration — was already the codebase's own established design**, not a
new choice: `attachment_url` has always been a bot-collected URL string
(`backend/src/db/schema.sql:236-243`'s own comment; ChatMate360's
`lib/bookly/types.ts`'s `attachment_url` doc comment), never a raw file
upload — there is no "file" to store in the first place, only a link a
customer/admin pastes into chat. This means the step-0 tradeoff was
already resolved by §16, just not fully wired through to Calendar sync —
completing that wiring (below) was the actual remaining work, not a fresh
architectural decision.

### 1. Meeting notes + attachment sync (Bookly side)

- `backend/src/services/googleCalendarService.js`: extracted a shared
  `buildDescription(appointment)` helper (line 134) — notes plus, when
  present, an `Attachment: <url>` line — used by both `createEvent`
  (line 162, previously `appointment.notes || undefined` only) and a new
  `updateEventDescription(calendarId, eventId, appointment)` (line 190,
  exported line 228) that PATCHes an existing event's description via
  `calendar.events.patch`, same resilience discipline as `createEvent`/
  `deleteEvent` (never throws; a Google outage or no connection just
  no-ops, logged).
- `backend/src/services/appointmentService.js`: new
  `addNoteToAppointment(id, { note, attachment_url })` (line 314, exported
  line 432) — appends to any existing `notes` (never overwrites), sets/
  replaces `attachment_url`, rejects a cancelled appointment with 409,
  re-syncs the Calendar event's description via `updateEventDescription`
  only when `google_event_id` exists (never attempted-and-swallowed,
  skipped entirely when there's nothing to sync).
- `backend/src/validation/schemas.js`: `addNoteSchema` (line 89) requires
  at least one of `note`/`attachment_url`.
- `backend/src/routes/appointments.js`: `POST /appointments/:id/notes`
  (line 153) — public, same `enforceApiKeyResourceScope` discipline as
  cancel/reschedule.
- Tests: `backend/tests/appointmentNotes.test.js` (8 tests) — append
  behavior, attachment_url set independently, empty-body rejection,
  cancelled-appointment rejection, 404 for unknown id, a resource-scoped
  API key rejected on a different resource's appointment (404), and a
  Calendar-sync-resilience test proving `updateEventDescription` is never
  even called when there's no `google_event_id` to sync to.

### 2. Meeting notes + attachment sync (ChatMate360 side — the actual mid-conversation feature)

- `src/services/toolAuthorization.service.ts`: new `add_note` operation
  (line 37, added to `BOOKLY_OPERATIONS` line 58, `UNVERIFIED` level line
  101) — reuses the existing `bookly_appointment` resource-ownership check
  unchanged, no new policy shape.
- `src/lib/bookly/types.ts` (line 52) / `src/lib/bookly/connector.ts`
  (line 107): `AddNoteToBooklyAppointmentInput` / `addNote()` calling
  Bookly's new `POST /appointments/:id/notes`.
- `src/services/booklyBooking.service.ts`: `addNoteToBooking` (line 279)
  — authorizes first (line 288), rejects an empty call before even
  reaching authorization, resolves the local row, calls the connector.
  Additive/low-risk (never touches time or status) — deliberately **no
  `interrupt()` confirmation gate**, unlike booking/cancel/reschedule: a
  wrong note is trivially correctable by adding another one, a wrongly
  confirmed booking is not.
- `src/langgraph/booklyNodes.ts`: new `add_note` intent (line 47, prompt
  line 68), `addNoteNode` (line 400) — resolves the target booking by an
  explicit id the customer names, or defaults to their single soonest
  upcoming appointment (`listBookingsForCustomer`, already scoped to
  `chatbot_bookly_appointments`'s own chatbot+customer pair, so this can
  never resolve to a booking that isn't theirs). Note/attachment text
  itself is LLM-extracted (`extractNoteFields`); which booking is
  targeted never is. Wired into `src/langgraph/booklyGraph.ts` (node line
  61, routing lines 37-38/63/83).
- **Real bug found and fixed while writing this**: the email-extraction
  regex duplicated in both `appointmentStatusLookupNode` and the new
  `addNoteNode` (`[^\s@]+@[^\s@]+\.[^\s@]+`) swallowed trailing sentence
  punctuation into the address when there was no space before it — "my
  email is x@example.com. add a note..." resolved the WRONG customer
  identity (`x@example.com.`, with the period). Pre-existing in
  `appointmentStatusLookupNode` before this pass too, not introduced by
  it — caught by this feature's own tests, not a hypothetical. Fixed with
  a shared `extractEmail()` helper (`booklyNodes.ts:39`) bounding the TLD
  segment to letters only, used by both nodes.
- **Real limitation, flagged rather than overclaimed**: "identified by
  booking number" only works if a customer pastes back a raw id they
  have some other way — nothing in this flow currently hands the customer
  a human-friendly confirmation number anywhere (`commitBookingNode`'s
  own success message doesn't include one). "My upcoming appointment" is
  the realistic default path for the common case, not a fallback for an
  edge case (`booklyNodes.ts:339-347`'s own doc comment).
- Tests: `tests/integration/booklyAddNote.integration.test.ts` (4 tests,
  mocked connector + mocked LLM, real Postgres) — resolves to the one
  upcoming appointment when none is named; resolves to an explicitly-named
  one over a sooner alternative when two exist; responds clearly and never
  calls Bookly when there are no upcoming appointments; a note aimed at
  another chatbot's real appointment id is rejected (404) before Bookly is
  ever reached. `tests/integration/booklyAuthorizationOrdering.integration.test.ts`
  extended (not duplicated) with `add_note`-specific cases: empty-call
  rejection before authorization, resource-ownership-failure rejection,
  and a happy-path sanity check — same file, same §9 property, one more
  operation.

### 3. Admin meeting-history document (Bookly side, admin-only)

Reads Bookly's own `appointments` table directly — the real source of
truth — never ChatMate360's `chatbot_bookly_appointments` mirror, per the
explicit instruction.

- No PDF/Word generation library existed in either codebase — checked
  before picking one, per the explicit instruction. Added `pdfkit`
  (`backend/package.json`) — pure-JS, no headless browser/Chromium
  dependency, standard choice for a Node backend.
- `backend/src/services/reportService.js` (new file):
  `fetchMeetingHistory({ from, to, resource_id })` — the real SQL query
  (joins `resources` for the staff/resource name), and
  `streamMeetingHistoryPdf(res, rows, filters)` — streams the PDF
  directly to the response, one section per appointment: date, time,
  resource, attendee name/email, status, notes, attachment link.
- `backend/src/routes/reports.js` (new file): `GET
  /reports/meeting-history` — `authenticate` + `requireRole('ADMIN')`,
  same pattern as every other admin-only Bookly route (`resources.js`).
  Mounted at `/reports` in `backend/src/app.js:14,42`.
- Tests: `backend/tests/meetingHistoryReport.test.js` (5 tests) — STAFF
  gets 403 and an anonymous caller gets 401 on the **direct route**, not
  a UI-hiding check; `fetchMeetingHistory` returns real seeded row data
  (date/time/attendee/status/notes, per resource) verified against actual
  Postgres rows, not assumed; date-range and resource_id filters narrow
  results correctly; the endpoint streams a real, well-formed PDF
  (`%PDF-` header, `%%EOF` footer, correct Content-Type/Disposition,
  non-trivial size); an empty range still produces a valid PDF rather
  than an error.
- **A real PDF-parsing rabbit hole, documented rather than hidden**:
  `pdf-parse` (both v2, which needs `--experimental-vm-modules` for its
  `pdfjs-dist` dependency's dynamic import under plain Jest/CJS, and the
  older v1, whose bundled ancient `pdfjs` threw inconsistent `bad XRef
  entry`/`Illegal character` errors on ordinary PDFKit output completely
  unrelated to this report's own content) both failed in this
  environment's Jest/CJS test setup — confirmed via isolated repros, not
  assumed. Rather than fight a flaky test-only dependency, the automated
  suite verifies the underlying query's real data directly
  (`fetchMeetingHistory`) plus the PDF's structural validity (magic
  bytes/footer/size), and **real content was independently confirmed by
  actually generating one** against real seeded data via a live
  Bookly dev-server instance (two real appointments, one with a real note
  added through the new endpoint, one cancelled) and reading the
  resulting PDF directly — it correctly showed both appointments' real
  date/time/resource/attendee/status, and the note text, exactly as
  seeded. This also surfaced and fixed an unrelated real environment gap:
  the persistent dev Postgres database (`helebooker`) had never had
  `npm run migrate` re-run since `attachment_url`/`notes` were added to
  `schema.sql` — the ephemeral `helebooker_test` database Jest uses is
  always freshly migrated, so this never showed up in the automated
  suite; re-running `npm run migrate` against the dev database (an
  idempotent, additive operation) fixed it.

### Verification

- ChatMate360: `tsc --noEmit` clean. Full suite: 302 passed / 305 total
  (2 pre-existing skips, unrelated to this pass). The one failure seen
  under full-suite parallel load
  (`booklyBookingRace.integration.test.ts`, a 502 instead of the expected
  clean 409) is the SAME already-documented flakiness class as §16's own
  verification note (a real spawned Bookly process under heavy parallel
  CI-style load) — confirmed by re-running that file standalone, where it
  passes reliably. Not caused by this pass's changes.
- Bookly (`backend`): full suite **20 files / 73 tests** (up from 18/60 —
  2 new test files, 13 new tests), including a real, live, manually-driven
  end-to-end check (documented above) that isn't captured by the
  automated count.

## §18 — Three real bugs in the booking conversation, found by actually talking to the bot (2026-09-13)

A real customer conversation (reported verbatim, not a test) hit a bug: by
the fourth turn, the bot had silently forgotten the email and name it had
correctly captured two turns earlier, and re-asked for everything. Root-
caused by reproducing the exact transcript, reading the real code and the
real LangGraph checkpointer state — not guessed. Three separate, real bugs
were found this way, not one:

**1. The actual trigger — `booklyEntrypoint.ts:64`.** Its resume check was
`snapshot.next.length > 0`. Confirmed directly against the checkpointer's
own state: `next` goes back to `[]` once a node has already been
interrupted-and-resumed at least once within the same execution — e.g.
`build_booking_draft`'s SECOND follow-up question ("which time?", after
the first one was already answered). `snapshot.tasks` correctly still
shows the pending interrupt at that point; `next` doesn't. The entrypoint
treated the second case as "not paused" and silently started a **brand-new
conversation thread** instead of resuming the real one — exactly why the
bug only ever showed up on the second missing-field question, never the
first, and exactly why the date "survived" (turn 1→2, the FIRST interrupt,
still worked) while email/name did not (turn 3→4, the second one, didn't).
Fixed: `isPaused = snapshot.next.length > 0 || snapshot.tasks.some(task => task.interrupts?.length > 0)`.

**2. A real, independent robustness gap — `booklyNodes.ts:255,270`
(`buildBookingDraftNode`) and `:241` (`mergeDraftExtraction`, new).** The
loop reassigned its extraction result wholesale on every pass
(`extraction = await extractDraftFields(...)`) instead of merging
field-by-field with what was already known. LangGraph's own documented
interrupt-replay semantics mean every LLM call before an unresolved
`interrupt()` is a genuine, non-cached call that re-executes on every
resume — so even with bug #1 fixed, a single incomplete extraction pass
later in a long conversation could still silently wipe an already-
collected field back to null. This one was **not** the trigger of the
reported transcript (bug #1 was), but it's a real gap regardless — LLM
extraction is not perfectly reliable turn to turn, confirmed empirically:
the same real `gpt-4o-mini` call, temperature 0, given the exact reported
transcript, correctly resolved every phrasing of "9am" tested (5/5) and
was consistent across repeated runs (3/3) — but nothing guarantees that
holds for every real conversation, and this fix makes the system correct
regardless. Fixed with `mergeDraftExtraction`: a fresh `null` (or a stale
`slotIndex` that no longer resolves to a real slot) never overwrites a
value already collected.

**3. A third real bug, found only by doing the live manual replay the
prompt required, not by trusting the automated test alone —
`booklyGraph.ts:91`.** The edge from `check_availability` routed to
`build_booking_draft` based on `state.intent` alone, ignoring whether
`check_availability` actually succeeded. Its own catch branch already
sets a clean customer-facing `responseText` and returns early when the
real Bookly call fails for **any** reason (unreachable, revoked
credentials, a transient network error — found live via this session's
own SSRF guard correctly blocking a `localhost` Bookly URL) — but the
edge still unconditionally continued into `build_booking_draft` whenever
intent was `booking_intent`, discarding that error and proceeding with a
permanently empty `availableSlots`, which can never satisfy "which time."
A customer hitting this would be stuck being asked for a time forever,
with no error and no way out. Fixed:
`state.intent === "booking_intent" && !state.responseText`. Safe to check
`responseText` here specifically (unlike `select_resource`'s own
deliberately-unconditional edge) because this runs immediately after
`check_availability` itself returns, on every path into it — no window
for a stale value from an earlier turn.

**Test**: `tests/integration/booklyBookingDraftMerge.integration.test.ts`
(new) — reproduces the exact reported transcript's real LLM-call sequence
turn-by-turn (traced against the graph's actual node structure), proving
bug #2's fix specifically; bug #1's fix is what lets this test's own
multi-turn conversation resume at all, and is exercised by every other
multi-turn test in the suite continuing to pass.

**Real manual replay — not skipped, per the explicit instruction not to
trust the test alone.** Bug #3 was only found because of this step: the
first live attempt (chatbot's Bookly connection pointed at
`http://localhost:4000`) hit the pre-existing, correctly-behaving SSRF
guard (`lib/crawler/ssrf.ts`) — surfacing bug #3 live, for a real reason
(an unreachable Bookly connection) rather than staying an untested
edge case. Rather than weaken that shared security check for
convenience, a real `ngrok` tunnel gave the connection a genuine public
URL. Replayed the exact reported conversation end to end against the real
running backend, the real `gpt-4o-mini`, and the real (tunneled) Bookly
server:

```
"book me a meeting" -> "What date would you like to check?"
"14 of september please 2026" -> "Could you tell me which time and an
  email address to send the confirmation to and a name for the booking?"
"9 am zain.rafiqu.pro1@gmail.com Zain Personal thoughts sessions" ->
  "Here's your appointment: 14-Sept-2026, 9:00 am UTC, 30 minutes, under
  the name Zain. Shall I go ahead and book this? (yes/no)"
"yes" -> "You're booked! I've sent a confirmation to
  zain.rafiqu.pro1@gmail.com."
```

Confirmed a real row now exists in **Bookly's own database** (not just a
ChatMate360-side claim): `GET /appointments?email=zain.rafiqu.pro1@gmail.com`
returned a real `CONFIRMED` appointment (`id: 998d84c1-...`, correct
date/time/attendee/notes).

**Verification**: ChatMate360 `tsc --noEmit` clean, full suite **56 files
/ 306 tests passing** (up from 305 — 1 new test), no regressions from any
of the three fixes across the rest of the suite (all three touch
shared/widely-used code paths: the entrypoint every multi-turn Bookly
conversation goes through, and the booking-draft loop and its routing
edge).

## §19 — Three new capabilities: manual model selection, per-conversation usage view, Bookly report on ChatMate360's own dashboard (2026-09-13)

Explicit instruction for this pass: read and reuse everything already
built, don't rebuild it, and state plainly what's reused vs. genuinely
new. All three capabilities below build on existing infrastructure —
**nothing rebuilt** — with clearly-scoped new code where a real gap
existed.

### Reused, unchanged (verified by reading the code before writing any of this)

- **Plan gating** — `requireFullCustomPlan` (`src/services/commerceCredentials.service.ts:36`), the exact function WooCommerce/Bookly connect already call. Capability 1's write path calls it directly; no second gating helper.
- **Quota-based auto model selection** — `selectModelForNewConversation` (`src/services/modelSelection.service.ts:27`), completely untouched. Still the function called whenever there is no manual preference, and still what a manual preference falls through to on exhaustion/ineligibility.
- **Real-time failure fallback** — `answerQuestion`'s `preferredProvider` reordering (`src/lib/ai.ts`), untouched. This is what already makes a manually-selected model's OWN provider-outage fallback work for free — capability 1 needed zero changes here.
- **Per-model cost tracking** — `chatbot_usage` table, `getModelPeriodCostUsd`/`isModelQuotaAvailable`/`recordUsage` (`src/services/usage.service.ts`), untouched. Capability 1 reads it (via `isModelQuotaAvailable`) to decide if a preference is usable; capability 2 reads the same rows again, as a second report, with zero new writes.
- **Scoped API keys + `enforceApiKeyResourceScope`** (Bookly `backend/src/middleware/apiKeyAuth.js:36`) — the exact cross-tenant mechanism every other Bookly connector call already relies on. Capability 3 extends the ONE route that didn't yet accept this (see below); the middleware itself is untouched.
- **`chatbot_bookly_credentials` (encrypted, resource-scoped)** and the connector's SSRF/timeout/fail-closed discipline (`src/lib/bookly/connector.ts`'s `assertSafeUrl`, `AbortSignal.timeout(8000)`) — untouched, reused for capability 3's new report call exactly like every existing Bookly call.
- **Ownership checks** — `requireOwnedChatbotId` (`src/lib/chatbotOwnership.ts`), used by every new write/read in this pass, same as every other owner-scoped feature.

### Capability 1 — Manual model selection (Full Custom only)

**New column**: `chatbots.preferred_model` (`db/schema.sql`, `alter table chatbots add column if not exists preferred_model text`) — null means "auto," identical to every chatbot before this column existed.

**Selection logic** — `selectModelForConversation` (`src/services/modelSelection.service.ts:50-95`, new function, `selectModelForNewConversation` itself untouched): checks the preferred model's own quota/plan-eligibility first (`isModelQuotaAvailable`, `entitlement.allowedModels`); on success, returns it directly (logged `event: "manual-model-selected"`); on ineligibility/exhaustion/error, logs `event: "preferred-model-fallback"` with a `reason` (`not-allowed-by-plan` | `quota-exhausted` | `error`) and calls the **unchanged** `selectModelForNewConversation` — the existing auto chain runs underneath exactly as it always has.

**Injection point** — `src/lib/answerChatbotQuestion.ts:248-259`: the existing `else` branch (only reached on a conversation's first turn, when `pinnedModel` is unset) now calls `selectModelForConversation(chatbotId, preferredModel)` instead of `selectModelForNewConversation(chatbotId)` directly. `preferredModel` is a new trailing parameter (`answerChatbotQuestion.ts:161-167`), passed by both callers from the chatbot row they already load: `src/services/chatbot.service.ts:389` (dashboard preview chat) and `src/services/public.service.ts:124` (public widget — its own `getChatbotById` query, `public.service.ts:23-28`, was missing `preferred_model` entirely and has been added, or the public path would never see a manual preference at all).

**Write path** — `updateChatbotPreferredModel` (`src/services/chatbot.service.ts:299-311`, new): ownership check, `requireFullCustomPlan`, writes `null` for `"auto"` or the raw model key otherwise, logs `event: "preferred-model-changed"` on every change. Route: `PATCH /chatbots/:chatbotId/preferred-model` (`src/routes/chatbot.routes.ts`, gated `requireAuth`+`requireDb`+`validateBody(updatePreferredModelSchema)`), validator at `src/validators/chatbot.validator.ts` (`z.enum(["anthropic","openai","gemini","auto"])`).

**Dashboard** — `components/dashboard/embed-panel.tsx`: a "Default AI model" `<select>` (Auto/Claude/OpenAI/Gemini), visible only when `accountStatus.plan === "full_custom"`, calling the new route via the same `api()`/`onChatbotChange` pattern as the theme/domain/fallback-message controls already in that file.

**Tests**: `tests/unit/modelSelection.test.ts` (8 tests — no preference behaves identically to the untouched auto chain; preferred-with-quota selected directly without walking the priority order; exhausted/not-allowed/erroring preference all fall through correctly; `selectModelForNewConversation` itself still works unmodified). `tests/integration/preferredModel.integration.test.ts` (7 tests, real Postgres + real HTTP + **real, unmocked Anthropic/OpenAI/Gemini calls** — no provider mocking): plan gating (402 on free trial), persistence across re-fetch and `"auto"` reset, cross-tenant rejection (404), invalid value rejection (400), and three genuine end-to-end checks — a preference with available quota is really selected and pinned (`conversations.pinned_model`) for a brand-new conversation; a preference with real seeded `chatbot_usage` exhaustion really falls back to a different model; a dashboard change persists and takes effect for the **next** conversation while an already-pinned one keeps its own model (PHASE C's pre-existing "decided once per conversation" behavior, unchanged and explicitly re-verified here).

**Live verification**: ChatMate360-Backend swapped onto port 4000 (Bookly's dev server, which normally occupies it, stopped and restarted afterward), a real Full-Custom user/chatbot seeded via the running HTTP API, and the actual dashboard exercised in a real browser at `localhost:3111`: the dropdown rendered, defaulted to "Auto," was changed to "Gemini" via a real click-equivalent DOM event, round-tripped to the real backend, and **remained "Gemini" after a full page reload** (server-side persistence, not just client state).

**Full suite after this capability**: 59 files / 326 tests passing, zero regressions. (One pre-existing gap found and fixed as part of this work, not a new bug: 4 test files — `answerChatbotQuestionCaching.test.ts`, `rateLimitAuthenticatedChat.integration.test.ts`, `security.integration.test.ts`, `public.integration.test.ts` — mocked `modelSelection.service.js` by replacing the whole module; each now also exports the new `selectModelForConversation` mock so the module shape stays complete. Also found: the test Postgres database, `chatmate360_test`, had never been migrated for `preferred_model` — `db/schema.sql` re-run against it, same idempotent-migration discipline as every prior phase.)

### Capability 2 — Per-conversation usage view (read-only, no new write path, no new cap logic)

**New read**: `getConversationCountForPeriod` (`src/services/usage.service.ts:86-101`, new) — `select count(*) from conversations where chatbot_id = $1 and to_char(created_at,'YYYY-MM') = $2`. Counts existing `conversations` rows (one per real `(chatbot_id, session_id)`, already written by `conversation.service.ts`'s `loadConversationContext`) — no new table, no new write.

**Combined summary**: `getUsageSummaryForOwner` (`src/services/usage.service.ts`, new, ~55 lines at end of file) — owner-scoped (`requireOwnedChatbotId`), reads `chatbot_usage` for the period (summed per model and in total) alongside `getConversationCountForPeriod`, for an explicit `?period=` or the current billing period by default. Calls no cap-enforcement function (`isModelQuotaAvailable`/`isOverCostCap` are never invoked here) — purely additive reporting.

**Route**: `GET /chatbots/:chatbotId/usage` (`src/routes/chatbot.routes.ts`, `requireAuth`+`requireDb`, no plan gate — every tier already tracks and has a legitimate reason to see its own usage). Controller: `getUsageSummary` (`src/controllers/chatbot.controller.ts`).

**Honest correction to the base spec's framing**: the request asked to add this "alongside the existing token-usage gauges" in the dashboard, as "the same UI pattern, additional metric, not a redesign." That assumption doesn't hold — there was no customer-facing usage view anywhere in `Chatmate360-main`'s dashboard to extend. The only existing usage-viewing feature (`getUserUsageBreakdown`, `src/services/admin.service.ts:199`, surfaced via `/admin/users/:id/usage`) is the **internal platform-admin tool** (`components/admin/admin-shell.tsx`), a different audience entirely — not linked from the customer dashboard. This pass therefore built a genuinely new, minimal customer-facing panel (`components/dashboard/usage-panel.tsx`) rather than extending a prior one, wired into `components/dashboard/dashboard-shell.tsx` alongside `EmbedPanel`/`ActionsPanel`, same self-fetching/styling pattern (`ActionsPanel`'s `useEffect`+`api()` shape). Flagging this now rather than presenting it as a small addition to something that already existed.

**Tests**: `tests/integration/usageSummary.integration.test.ts` (7 tests, real Postgres): zero-activity chatbot reports clean zeros; real seeded `conversations`+`chatbot_usage` rows (3 conversations, 2 models) cross-checked — per-model breakdown sums to exactly the reported totals; per-chatbot isolation (chatbot A's numbers never include chatbot B's activity); cross-tenant rejection (404, real known-valid id); a conversation from a past period is excluded from the current period's count; an explicit `?period=` looks back correctly without leaking the current period's data; requires authentication.

**Live verification**: same port-4000 swap as capability 1, real `chatbot_usage`/`conversations` rows seeded directly (12000/4300 anthropic + 3000/900 openai tokens, 5 conversations), dashboard loaded in a real browser: panel showed **5 conversations, 20,200 tokens, $2.07** and a correct per-model breakdown (Claude 16,300 tokens/$1.85, OpenAI 3,900 tokens/$0.22) — matching the seeded numbers exactly.

**Full suite after this capability**: 60 files / 333 tests passing, zero regressions.

### Capability 3 — Bookly's meeting-history report, wired into ChatMate360's OWN dashboard

**Blocking architectural gap found and fixed first**: `GET /reports/meeting-history` (Bookly, `backend/src/routes/reports.js`, built in §17) was gated `authenticate, requireRole('ADMIN')` — a real Bookly user login. ChatMate360 has never stored one of those for a chatbot's Bookly connection; `chatbot_bookly_credentials` only ever holds a resource-scoped API key. Capability 3 as specified was architecturally impossible with the existing credential model until this was fixed. This is a genuinely new, small extension — not a rebuild of the report itself (`fetchMeetingHistory`/`streamMeetingHistoryPdf` in `backend/src/services/reportService.js` are untouched).

**Fix** (Bookly-side, `backend/src/routes/reports.js`): the route now also runs `authenticateApiKeyIfPresent` (the exact existing middleware from `apiKeyAuth.js`, used unmodified) ahead of a new `requireAdminOrApiKey` gate (real ADMIN session OR a valid API key — mirroring the existing `authenticate`+`requireRole('ADMIN')` OR-branch pattern), and a new `forceApiKeyResourceScope` middleware that pins a scoped key's `resource_id` query param to its own scope, rejecting (404) an explicit mismatch — this is a line-for-line copy of `appointments.js`'s own `forceApiKeyResourceScope` (`backend/src/routes/appointments.js:62-69`), not a new isolation mechanism.

**ChatMate360-side connector**: `getMeetingHistoryReportPdf` (`src/lib/bookly/connector.ts`, new function, ~45 lines) — can't reuse the existing `booklyFetch` helper (it always parses JSON; this endpoint returns a raw PDF), so this is a parallel raw-binary fetch with the **identical** `assertSafeUrl`/`AbortSignal.timeout(8000)`/fail-closed discipline as every other function in the same file. Deliberately never sends `resource_id` — relies on Bookly's own server-side `forceApiKeyResourceScope` instead of duplicating that check client-side.

**ChatMate360-side service**: `downloadBooklyMeetingHistoryReport` (`src/services/booklyCredentials.service.ts`, new, ~25 lines) — `requireOwnedChatbotId` + `requireFullCustomPlan` (same two checks `connectBookly`/`addBooklyResource` in the same file already use) + `getDecryptedBooklyCredentials` (existing, untouched) + the new connector call, with `BooklyApiError` mapped to a clean customer-facing `AppError` (502 for unreachable/outage, 400 for a revoked/invalid key) — never a raw exception, never a hang (bounded by the connector's own 8s timeout).

**Route**: `GET /chatbots/:chatbotId/bookly/meeting-history` (`src/routes/chatbot.routes.ts`, `requireAuth`+`requireDb`), controller `getBooklyMeetingHistoryReport` (`src/controllers/booklyCredentials.controller.ts`), streaming the PDF back with the same `Content-Type`/`Content-Disposition` headers Bookly's own route uses.

**Dashboard button — a genuine gap found and fixed, not assumed away**: the base spec asked for a "Download meeting history" button "on the chatbot's Bookly integration settings page in ChatMate360's dashboard" — that page didn't exist. `Chatmate360-main`'s dashboard had **no Bookly (or WooCommerce) settings UI at all**; connecting a Bookly resource was only ever possible by calling `POST /chatbots/:id/bookly` directly. Built new: `components/dashboard/bookly-panel.tsx` — reads connection status from the existing `GET /chatbots/:id/bookly` (unmodified), renders nothing when not connected (no attempt to also build a full "connect Bookly" form — out of this pass's scope), and shows the resource label plus the download button when connected. `lib/api.ts` gained `downloadFile` (new) — the existing `api()` helper always parses JSON, which would fail on a PDF; `downloadFile` does the same auth-header/error-shape handling but returns a Blob and triggers a real browser download via a temporary object-URL `<a>` click (an authenticated download can't be a plain `<a href>`, since the bearer token has to be attached to the request). Wired into `components/dashboard/dashboard-shell.tsx` alongside `EmbedPanel`/`UsagePanel`/`ActionsPanel`.

**Tests**:
- Bookly-side, `tests/meetingHistoryReport.test.js` (3 new tests added to the existing 5): a key scoped to its own resource downloads a real report with no ADMIN session at all; a key scoped to Resource A is rejected (404) asking for Resource B's report with B's real id; an invalid/garbage key is rejected (401) on this route too. All 8 pass; full Bookly suite **20 files / 76 tests passing**, zero regressions.
- ChatMate360-side, `tests/integration/booklyMeetingHistoryReport.integration.test.ts` (5 new tests, real Postgres, connector mocked at the module boundary): owner downloads their own real report (PDF bytes returned unmodified, using THIS chatbot's own decrypted credential, not a shared/hardcoded one); another chatbot's report is rejected via `requireOwnedChatbotId` even with its real id; a Bookly outage (`BooklyApiError` status 0) surfaces as a clean, matching error; a revoked API key (401) surfaces as a clean, matching error; no Bookly connection at all is rejected before the connector is ever called.

**Live verification (the real point of this capability)**: a genuine public tunnel via `ngrok` to Bookly's real dev server (`https://colossal-sullen-coconut.ngrok-free.dev` → `localhost:4000`) — not a mock, not localhost-only, the same SSRF-respecting approach used earlier this session for the booking-bug live replay. Seeded via Bookly's real HTTP API: an ADMIN user, a resource, a real `CONFIRMED` appointment, and a scoped API key. Confirmed over the real public tunnel:
  - `GET /reports/meeting-history` with the scoped key → **200, a real PDF** (`%PDF-1.3` header, `%%EOF` footer, 1562 bytes) whose actual rendered content (read back via the PDF-rendering Read tool, not just headers) showed the real seeded appointment: `2026-09-14 10:00–10:30 UTC — Live Test Resource — Attendee: Live E2E Customer <livee2e@example.com> — Status: CONFIRMED`.
  - The same key asking for a second, real Tenant-B resource's report (`?resource_id=<tenant B's real id>`) → **404**, over the same public tunnel.
  - ChatMate360's own new connector function (`getMeetingHistoryReportPdf`), invoked directly with `tsx` against the same live tunnel → genuinely fetched the same real PDF (1562 bytes, `%PDF-1.3`).
  - The tunnel was then torn down and the connector re-invoked: failed in ~1.8s with a clean, typed `BooklyApiError` (never a hang) — confirming the "Bookly outage produces a clear error, not hang/crash" requirement against a **real** dead endpoint, not a simulated one. A second check against a genuinely non-resolving host failed in 11ms via the existing `SsrfBlockedError` DNS-failure path, which `downloadBooklyMeetingHistoryReport`'s catch-all branch still converts to a clean `AppError` rather than leaking the raw exception.
  - The new dashboard panel itself: a second real Bookly instance was run on a different port, tunneled separately via `ngrok`, and connected to a real chatbot through ChatMate360's own `POST /chatbots/:id/bookly` (the SSRF check correctly rejected a plain `localhost` URL here too, exactly as designed — the public tunnel was required, not a shortcut). The dashboard, reloaded in a real browser, showed **"Bookly scheduling — Connected to Panel Check Resource"** with a real "Download meeting history" button. The button's click was not exercised in this automated browser session (an authenticated file download to the operator's real filesystem requires their own explicit action, not an agent-driven click) — the download endpoint itself was already proven working end-to-end above, both via direct HTTP against the live tunnel and via the connector function invoked directly.

**Full suite after this capability**: ChatMate360 60 files / 333 tests, Bookly 20 files / 76 tests — both green, zero regressions across the whole pass.

## §20 — Deploy-readiness pass: a fourth real booking-conversation bug, and a real Google Calendar sync gap, both found by actually using the real accounts (2026-09-14)

Asked directly: is Bookly ready to deploy, tested as the real ADMIN account and via the real chatbot as a customer, with Google Calendar confirmed against the real API. Both a real code bug and a real (non-code) configuration gap were found — not by writing new tests first, but by actually doing the thing: logging in as the real seeded `admin@example.com`, and having a genuine multi-turn conversation with the real, already-connected "Bookly Scheduling Assistant" chatbot (`chatbot_id 5c59ede6...`, resource "Dr. Priya Sharma").

**Bug #4 — a real, transient error early in a conversation permanently poisoned every later message in that same conversation.** Reproduced live: the chatbot's stored Bookly `base_url` was `http://localhost:4000` — correctly blocked by the SSRF guard (`localhost resolves to blocked address ::1`) for any real outbound call, exactly as designed (this is a legitimate deploy-config item, not the bug — see below). Once a public tunnel was substituted for testing, a second unrelated transient failure occurred on the very next attempt (an `ngrok` gateway hiccup on a freshly-opened tunnel), and the customer correctly saw a clean error message. But every subsequent retry — even after the tunnel was fully warm and `check_availability` demonstrably succeeded (confirmed via direct calls to the live tunnel and via server logs showing no further errors) — kept returning that exact same stale error text, forever, on that one conversation thread.

Root-caused against the real code and the real LangGraph checkpoint state, not guessed: `responseText`'s reducer in `src/langgraph/booklyState.ts:43` is `(_prev, next) => next` — LangGraph only invokes a channel's reducer when a node's returned partial state object actually **includes** that key. `checkAvailabilityNode`'s error branch (`booklyNodes.ts:164-165`) sets `responseText` to a fallback message; its success branch (`booklyNodes.ts:173,176`) omits the key entirely instead of explicitly clearing it. Because `classify_intent` replays on every single graph invocation on a thread — fresh top-level messages and resumed interrupts alike, per LangGraph's own documented interrupt-replay semantics (the same mechanism behind bug #2 in §18) — and always runs before any node that reads or sets `responseText` for routing, a value left over from an earlier turn's error survives in the Postgres checkpoint indefinitely and gets treated as the CURRENT turn's outcome too, routing straight to `END` via `booklyGraph.ts`'s `(state) => (state.intent === "booking_intent" && !state.responseText ? "build_booking_draft" : END)` edge — even on a turn where `check_availability` just genuinely succeeded.

Fixed: `classifyIntentNode` (`booklyNodes.ts:78-92`) now explicitly returns `responseText: null` on its normal path — the one node guaranteed to run first, every time, fresh or resumed, so "this turn's own outcome" is the only thing later routing decisions ever see. Audited `validationIssue` (the other field with the same reducer shape, used for its own routing decision in `finalValidationNode`) for the same class of bug — not present there: every one of its return branches (`booklyNodes.ts:349,354,357`) explicitly sets `validationIssue` one way or the other, never omits it.

**Test**: `tests/integration/booklyResponseTextStale.integration.test.ts` (new) — reproduces the exact shape (turn 2 fails with a real connector rejection, turn 3 on the SAME conversation succeeds) and asserts turn 3 does not repeat turn 2's error text. Verified as a genuine regression test, not a tautology: manually reverted the fix, confirmed the test fails with the exact real symptom (`expected 'Sorry, I couldn't check availability…' not to match /couldn't check availability/i`), then restored the fix and confirmed it passes. Full ChatMate360 suite after the fix: **61 files / 334 tests passing**, zero regressions (verified twice — once against a since-diagnosed false alarm, see below).

**A real, non-code deploy blocker: Google Calendar sync currently fails with "insufficient authentication scopes."** Enabled Google Calendar sync on the real "Dr. Priya Sharma" resource via the real admin account (`PATCH /resources/:id/calendar`, `provider: "google"`), then booked a real appointment through the real chatbot end to end (a full multi-turn conversation, ending in "You're booked!" and a real `CONFIRMED` row in Bookly's own `appointments` table). The booking itself succeeded — Bookly's own design deliberately never lets a calendar-sync failure block or roll back a real booking (`appointmentService.js`'s `syncNewAppointmentToGoogle`, explicitly "best-effort... failure at any point just leaves `google_event_id`/`google_meet_url` null"). But the sync itself never happened: Bookly's own backend log shows `Google Calendar event creation failed, ignoring — err: "Request had insufficient authentication scopes."` The stored `integrations` row's refresh token (connected 2026-09-11, `account_email: zain.rafique.pro1@gmail.com`) was evidently issued with a narrower scope grant than the app's current OAuth request (`src/services/googleCalendarService.js`'s `SCOPES`, which does include `calendar.events`) — most likely from before that scope list was finalized, or from a consent flow where the connecting account didn't grant full access. **This is not a code bug** — the requested scope is correct and the failure is handled safely — it's a stale credential that needs the connecting account to redo the OAuth consent flow (`GET /integrations/google/connect` or wherever the admin dashboard exposes it) before real Calendar sync will work. Flagging this plainly rather than as a code fix, since I can't complete a real Google OAuth consent screen on the user's behalf.

**A genuine false alarm along the way, resolved and worth recording**: mid-verification, the full ChatMate360 suite suddenly went from 333/333 passing to 177 failing / 149 passing, with `AggregateError`/`ECONNREFUSED` on every DB-touching test. Confirmed this was NOT caused by the `responseText` fix (an isolated one-line change to one node couldn't plausibly break signup across dozens of unrelated files) — Docker Desktop itself had stopped (`docker ps` failed to reach the daemon at all), taking down the `chatmate360-backend-main-postgres-1` container (and, separately, Bookly's own `helebooker_postgres`-backed dev server on port 4000, which also went down and needed a manual restart afterward). Restarted Docker Desktop, confirmed the Postgres container recovered cleanly from its unclean shutdown (`database system was interrupted... automatic recovery in progress` — a normal WAL replay, no data loss), re-ran the full suite, back to clean. Also noted, unrelated to any of this: `tests/calendarFeedPublish.test.js` failed once on a genuinely separate, pre-existing issue — it asserts against a hardcoded appointment time (`2026-09-14T10:00:00.000Z`) that real wall-clock time (now past 2026-09-14 14:00 UTC) has simply overtaken, so the feed's own "upcoming only" filter correctly excludes it; a pre-existing test-fragility issue, not a regression, not touched in this pass.

**Also noted, not fixed (out of scope for this pass)**: the real "Bookly Scheduling Assistant" chatbot's crawl `status` has been stuck at `queued` since 2026-09-12 — doesn't block chat (Bookly-intent messages never depend on crawled content), but suggests the background crawl worker (`npm run worker`) wasn't running continuously in this dev environment for that job. Worth checking before relying on this chatbot's non-Bookly answering path.

**Verification discipline**: every finding in this section came from actually using the real, already-existing admin account and the real, already-connected chatbot through genuine HTTP calls to a real running backend and a real Bookly instance (via a temporary `ngrok` tunnel, torn down afterward, exactly like every other live check in this document) — never a mock standing in for "the real thing." The real booking created during this verification (`appointment id d36ae1ac-...`, Zain, 2026-09-21 09:00 UTC, Dr. Priya Sharma) was left in place as evidence rather than deleted.

## §21 — The scope gap was real: reconnecting Google Calendar fixed it, and surfaced a second real gap — the Meet link never reached the chatbot customer (2026-09-14)

Following §20's diagnosis, the connected account (`zain.rafique.pro1@gmail.com`) redid the Google OAuth consent flow through Bookly's real Integrations page. Confirmed via the database, not just the UI badge: `integrations.connected_at` jumped from the old 2026-09-11 timestamp to a fresh one, and a new real booking (`POST /appointments`, 2026-09-28 10:00 UTC) came back with a populated `google_event_id` — the scope fix genuinely worked, not just "looks connected."

**A second real gap, found immediately after, by inspecting the actual synced calendar event**: no "Join with Google Meet" button appeared on it. Root cause (not a bug — a resource-level setting that was never turned on): Bookly's `syncNewAppointmentToGoogle` (`backend/src/services/appointmentService.js:192-197`) only requests a Meet link when `resource.video_provider === 'google_meet'`; "Dr. Priya Sharma" had `video_provider: null`. Set it via the real admin API (`PATCH /resources/:id/video-provider`, `{ provider: "google_meet" }` — requires the resource already synced to Google Calendar, enforced by `resources.js:90-95`), then booked another real test appointment: it came back with a real, working `google_meet_url` (`https://meet.google.com/zhk-ycnr-twf`). Confirmed on the actual synced calendar event too, not just the API response.

**A third real gap, found by asking "does this reach the chatbot customer too"**: it didn't. Bookly's `createAppointment` response genuinely carries `google_meet_url`/`zoom_join_url` — but ChatMate360's side silently dropped both on the floor before they ever reached the customer:
- `chatbot_bookly_appointments` (ChatMate360's own local mirror row, `db/schema.sql:704`) had no columns for either link.
- `LocalBooklyAppointment`/`mapRow` (`src/services/booklyBooking.service.ts:61-85`) never read or exposed them.
- `commitBooking`'s own UPDATE after a successful Bookly call (`booklyBooking.service.ts:205-208`, previously) only ever wrote `bookly_appointment_id` and `status` — the real link from `booklyAppointment.google_meet_url`/`.zoom_join_url` was available in the same function, in memory, and discarded.
- `commitBookingNode`'s customer-facing success message (`src/langgraph/booklyNodes.ts:383-387`, previously) was a fixed string with no way to include a link even if one existed.

So a customer booking through the chatbot got "You're booked!" with genuinely no way to join the meeting, even on a resource correctly configured end-to-end on Bookly's side.

**Fixed**: `db/schema.sql` adds `google_meet_url text` / `zoom_join_url text` to `chatbot_bookly_appointments` (idempotent migration, applied to both `chatmate360` and `chatmate360_test`). `booklyBooking.service.ts`: `LocalBooklyAppointment` gained `googleMeetUrl`/`zoomJoinUrl`, `mapRow` reads them from the row, and `commitBooking`'s UPDATE now writes both from Bookly's real response (`booklyAppointment.google_meet_url`/`.zoom_join_url`) alongside `bookly_appointment_id`/`status`. `booklyNodes.ts`'s `commitBookingNode` now appends `" Join the meeting here: <url>"` to the confirmation text whenever either link is present (Google Meet preferred, falling back to Zoom), and omits it entirely — no dangling sentence fragment — when neither is set (the common case for a resource with no video provider).

**Tests**: `tests/integration/booklyMeetLinkSurfaced.integration.test.ts` (new, 4 tests) — `commitBooking` persists a real `google_meet_url` onto its own mirror row (re-read from the database, not just the in-memory return value, to prove it's genuinely written); the same for a Zoom link; a resource with neither configured leaves both fields `null` rather than erroring; `commitBookingNode`'s own confirmation text contains the real Meet URL and the words "join the meeting" when one was generated. Full suite: **62 files / 338 tests passing**, zero regressions.

**Live verification, the real point of this fix**: reproduced the exact customer experience end to end — a genuine multi-turn conversation with the real "Bookly Scheduling Assistant" chatbot (via a fresh `ngrok` tunnel to Bookly, the chatbot's stored `base_url` temporarily pointed at it and restored to `http://localhost:4000` afterward, same discipline as every other live check), booking a real new appointment (2026-10-05, 10:00 UTC). The chatbot's actual final message: *"You're booked! I've sent a confirmation to zain.rafique.pro1@gmail.com. Join the meeting here: https://meet.google.com/rtg-pydi-jwf"* — a real, clickable Meet link, generated by Bookly and now correctly carried all the way through ChatMate360 to the customer, not just visible to someone checking Bookly's own admin dashboard or database directly.

**Known limitation, stated plainly**: the two earlier real bookings made during §20/§21's verification (2026-09-21 and 2026-09-28, both booked before this fix landed) still have no join link in their own chatbot conversation history — this fix only affects bookings made after it, same as the Google Calendar sync fix itself never retroactively syncs old bookings. Not fixed retroactively; noted rather than hidden.

## §22 — Competitive-gap pass: reschedule/cancel via chat, a real service catalog, automatic waitlist notifications, real transactional email, and two more real bugs found along the way (2026-09-14)

Prompted by a market comparison (Bookly vs. OnceHub/Voiceflow/HighLevel-style booking agents) identifying four concrete gaps: no reschedule/cancel via chat, a fake "I've sent a confirmation" claim (no email infrastructure existed anywhere in the codebase), no way to answer a pricing question, no reminders. Fixed all four, plus a genuinely new standout feature (automatic waitlist) requested explicitly as a differentiator.

### Reused, unchanged
`rescheduleBookingForCustomer`/`cancelBookingForCustomer`/`listBookingsForCustomer` (`booklyBooking.service.ts`) — already existed, fully authorized, for the admin-chat path; this pass added the conversational (interrupt-based) layer, not new backend capability. `extractDate`/`extractDraftFields`/`mergeDraftExtraction` (`booklyNodes.ts`) — reused verbatim for reschedule's new-date/new-time collection and the waitlist's name/email collection, no new extraction logic written. `authorizeToolCall` (`toolAuthorization.service.ts`) — every new operation (`reschedule_appointment`/`cancel_appointment` already existed; `get_service_info`/`join_waitlist` are new entries in the same table, not a new authorization mechanism). The existing `jobs/icsFeedSync.js` pattern (Bookly) — the new reminder job (`jobs/reminderJob.js`) mirrors its exact shape (a periodic `setInterval`, deliberately not started by `createApp()` so tests never have a live timer running).

### Bug #4 (this session) — the "ask for email" step never actually continued after getting a reply

Found while building reschedule/cancel on top of the SAME pattern `add_note`/`appointment_status_lookup` already used: `if (!email) { ...; return { messages: [..., interrupt(question)] } }` — this returns immediately with whatever the customer replied, with **no loop and no re-check**. A customer answering "what email did you book with?" with *just their email* (the normal way to answer a direct question, not restating the whole original request) got that reply appended to the transcript and the turn ended right there — the lookup/action never actually ran. This was a real, pre-existing defect in `add_note`/`appointment_status_lookup`, not something introduced by the new reschedule/cancel nodes — it was simply copied from them at first, then caught because the new nodes' own tests exercised the exact reply-with-just-an-email path that the old nodes' tests never had (they always gave the email upfront in the first message).

**Fixed**: a single shared `collectEmail(latest)` helper (`booklyNodes.ts`, new) — a proper `while (!email)` loop, matching `checkAvailabilityNode`'s own date-collection loop shape — replacing four separate copies of the broken pattern (`add_note`, `appointment_status_lookup`, and the two brand-new nodes below).

### Reschedule & cancel via chat

New intents `reschedule_appointment`/`cancel_appointment`; new nodes `rescheduleAppointmentNode`/`cancelAppointmentNode` (`booklyNodes.ts`): identify by email (`collectEmail`) → soonest upcoming booking (same safe default `add_note` already uses) → for reschedule, collect a new date+time (reusing `extractDate`/`extractDraftFields`/`mergeDraftExtraction`) against the appointment's OWN resource; for cancel, a straight confirm. Both gate behind an explicit yes/no (`confirmYesNo`, new shared helper) before acting — cancel/reschedule are destructive, unlike `add_note`.

**A second real bug found in existing code while wiring reschedule, not new code**: `rescheduleBookingForCustomer` only updated `start_time` after a successful reschedule, never `bookly_appointment_id` — but Bookly's own `rescheduleAppointment` (`backend/src/services/appointmentService.js`) **always** cancels the old appointment row and creates a brand-new one (confirmed by reading the real transaction: `setAppointmentStatus(..., 'CANCELLED', ...)` then a fresh `INSERT`, unconditionally, not just for a resource reassignment). ChatMate360's local mirror row was left pointing at the now-cancelled OLD Bookly appointment id — any later cancel/reschedule/status-lookup on it would have failed against Bookly with a 404. `recordReassignment` (the admin-chat reassignment path) already handled this correctly; the plain customer-reschedule path did not. Fixed to update both fields together.

**Tests**: `tests/integration/booklyRescheduleCancel.integration.test.ts` (7 tests) — cancel: identify+confirm+cancel, declining leaves it untouched, no-upcoming-appointment is a clean message; reschedule: full email→date→time→confirm→reschedule flow, asserting the LOCAL mirror row's `bookly_appointment_id` is updated to the genuinely different new id (the bug fix, verified by direct DB re-read). Used a content-aware mock rather than a hand-counted call queue after two rounds of miscounting LangGraph's real replay behavior across a 4-step interrupt chain — documented in the test file itself as a lesson, not hidden.

**Live verification**: real multi-turn conversations with the actual "Bookly Scheduling Assistant" chatbot (via a fresh `ngrok` tunnel). Reschedule: moved a real appointment (Sep 21 → Oct 12), confirmed in Bookly's own DB — old appointment `CANCELLED`, new one `CONFIRMED` with a genuinely different id, a real synced Google Calendar event, and a real Meet link. Cancel: cancelled a different real appointment (Oct 5), confirmed `CANCELLED` in Bookly's DB. The email-collection loop fix was directly exercised live too — replying with just an email correctly continued the flow instead of dead-ending, and a genuine transient `ngrok` gateway error mid-conversation was handled cleanly by the §20 `responseText`-staleness fix generalizing correctly to this new flow (a fresh retry worked, using accumulated thread context rather than needing to restart from scratch).

### Real transactional email (fixes the "lies about sending an email" issue)

New `backend/src/services/emailService.js` — a single `fetch` call to Resend's HTTP API, no SDK dependency, same "unconfigured is a normal, logged, best-effort no-op" discipline as `googleCalendarService.js`'s own missing-token path (`config.email.resendApiKey` from `RESEND_API_KEY`, unset by default). Wired into `appointmentService.js`'s `syncNewAppointmentExternal` (booking confirmation, reschedule confirmation — new `emailKind` parameter distinguishes the two), `cancelAppointment` (cancellation email), and the new reminder job. This is what makes `booklyNodes.ts`'s existing *"I've sent a confirmation to X"* an honest claim now — Bookly genuinely attempts a real send on every booking, where before this pass **no email-sending code existed anywhere in the codebase** and that sentence was simply false regardless of wording.

### Service catalog — real pricing answers

`resources` gains `price_cents`/`price_currency`/`service_description` (this codebase's existing one-resource-per-service simplification means these belong directly on `resources`, not a new join table). Admin write: `PATCH /resources/:id/service-info`. Public, no-auth read: `GET /resources/:id/service-info` (a narrow projection — name/price/description only, never calendar ids or internal config) — new connector function `getServiceInfo` (ChatMate360), new `pricing_question` intent and `pricingQuestionNode`, a **real-time** read on every question (never cached/mirrored, so a price change is reflected on the very next question).

**Tests & live verification**: 2 tests (real price+description answered; honest "not set yet" message when no price exists, never a fabricated number). Live: set a real price (`$150.00`, a real description) on "Dr. Priya Sharma," asked the real chatbot "How much does a consultation cost?" — real answer: *"Dr. Priya Sharma costs 150.00 USD. A 30-minute consultation covering general checkups and follow-ups."*

### Standout feature — automatic waitlist

New Bookly table `appointment_waitlist` (resource_id, customer_name/email, requested_date, notified_at). New public route `POST /appointments/waitlist` (same no-auth/scoped-key contract as `POST /appointments`). New `waitlistService.js`: `addToWaitlist` and — the actual differentiator — `notifyWaitlistForFreedSlot`, called automatically from `appointmentService.js`'s `cancelAppointment` on **every real cancellation**: checks for anyone waiting on that exact resource+date, emails the oldest still-waiting entry (one notification per freed slot, not everyone waiting — avoids telling multiple people a single slot is available). ChatMate360: new `join_waitlist` operation/connector function, `check_availability`'s own routing extended (`booklyGraph.ts`) — a booking-intent request with **zero** real slots on the requested date now routes to a new `offerWaitlistNode` instead of silently continuing into `build_booking_draft` with nothing to offer.

**A third real bug, found live, not by a test**: `joinWaitlistForChatbot`'s first version called `authorizeToolCall` with `customerId: null` — but `join_waitlist`'s required verification level (`"UNVERIFIED"`, matching `book_appointment`) requires an actual resolved identity, not null, and `authorizeToolCall` correctly rejected it (`"Operation \"join_waitlist\" requires a resolved customer identity."`). The fix mirrors `commitBookingNode`'s own division of responsibility exactly: `offerWaitlistNode` now calls `resolveCustomerIdentity` before calling the service function, which now takes an already-resolved `customerId` parameter instead of resolving (or failing to resolve) one itself.

**A fourth small bug, found live**: the missing-fields question ("what {missing} should I use to notify you?") read as "what an email address should I use..." when only email was still missing — an article-agreement bug in the join logic. Fixed by rephrasing to "could you give me {missing} to notify you with?", which reads correctly regardless of which field(s) are missing.

**Tests**: `tests/integration/booklyPricingWaitlist.integration.test.ts` (4 tests, 2 pricing + 2 waitlist) — offering the waitlist on zero real slots and joining it (asserting the real `joinWaitlist` connector call with the right resource/date), declining leaves no waitlist call made.

**Live verification, the real point of this feature**: filled every real slot on a real date (2026-11-02) via 16 real bookings, asked the real chatbot to book that date — got the waitlist offer, joined it with a real email. Then cancelled one of the filler appointments directly against `appointmentService.js` — the real log output: `Google Calendar event deleted` (the cancellation itself), followed immediately by a real, correctly-addressed notification attempt: `Email not sent: RESEND_API_KEY is not configured — to: "priya.customer@example.com", subject: "A slot opened up with Dr. Priya Sharma"` — the exact person who joined the waitlist through the real chatbot conversation, found and notified automatically by a real cancellation elsewhere in the system, with no manual step in between. `notified_at` correctly stays `null` until a send genuinely succeeds (retry-safe by design, same principle as the reminder job never marking a failed send as done).

### Reminders

New `backend/src/services/reminderService.js` (`sendDueReminders` — CONFIRMED appointments starting within `REMINDER_LEAD_HOURS`, default 24, with `reminder_sent_at IS NULL`) and `backend/src/jobs/reminderJob.js` (periodic `setInterval`, default every `REMINDER_CHECK_INTERVAL_MINUTES` = 15 minutes, mirroring `jobs/icsFeedSync.js`'s exact shape), started from `server.js` alongside the existing ICS sync job. `reminder_sent_at` only ever set after a genuinely successful send — a failed attempt (no provider configured, Resend rejects it, a timeout) leaves it retryable on the next tick, never silently marked "done."

**Live verification**: the real reminder job, running continuously against the real dev database since `server.js` restarted, found and logged a real due appointment on its own: `Periodic reminder check completed — reminder_count: 1`, with the expected `Email not sent: RESEND_API_KEY is not configured` warning for the actual send attempt — the whole detection→attempt pipeline is real and running, only the final delivery step is unconfigured in this environment.

### What's still needed for real email delivery

Every email feature above (booking/cancellation/reschedule confirmations, reminders, waitlist notifications) is fully built and correctly wired, but **no email actually leaves the system** until a real `RESEND_API_KEY` is set (a free Resend account and a verified sending domain, or their `onboarding@resend.dev` sandbox sender for testing). This is a deliberate, explicit gap — not something fixable from inside this codebase, the same category as the earlier Google OAuth reconnect this session already asked the user to complete themselves.

**Verification**: ChatMate360 full suite **64 files / 346 tests passing** (up from 62/338 — 8 new tests across two new files), Bookly full suite **20 files / 76 tests** (75 passing, the one pre-existing hardcoded-date test failure from §20 unrelated and unchanged), zero regressions across either suite. `tsc --noEmit` clean throughout.

## §23 — Slot times are now offered up front, not just after a failed guess (2026-09-14)

Found live, in the same conversation that surfaced §22's bugs: a customer who asked for "8am" (never a real slot — the resource's earliest is 9am) got "Could you tell me which time?" over and over, with no indication of what was actually bookable — they had no way to know their request was simply never going to resolve, no matter how they rephrased it. A same-session partial fix (listing real times only on a SECOND failed attempt) closed the infinite-loop symptom but still left the customer guessing blind on the very first ask.

**Fixed properly**: `buildBookingDraftNode` (`booklyNodes.ts`) now lists the real available times (from `state.availableSlots`, already fetched by `checkAvailabilityNode`) on the very FIRST time it asks, framed as "Here's what's open that day: ... Pick one of those, or tell me another time and I'll check it." — the customer can pick from the list or still type their own preferred time, which loops back through `extractDraftFields`/`mergeDraftExtraction` exactly as before. A second still-unresolved attempt gets the apologetic "that time isn't available" framing around the same real list, unchanged from the earlier fix. The identical defect pattern existed, unfixed, in `rescheduleAppointmentNode`'s own "What time works?" loop — a customer rescheduling into a bad time got the same blind guessing game. Fixed identically, sharing a new `formatSlotTimes(slots)` helper between both nodes rather than duplicating the formatting expression a third time.

**Tests**: `tests/integration/booklyTimeClarification.integration.test.ts` (new, 1 test) rewritten to assert the first ask now lists real times and invites pick-or-write-your-own, then asserts a second bad guess still gets the apologetic real-times framing. `tests/integration/booklyRescheduleCancel.integration.test.ts`'s existing reschedule test updated — its date→time step now asserts a real time (`09:00 AM`) is listed immediately rather than a vague "what time" prompt.

**Live verification**: real conversation with the actual deployed chatbot (via the same `ngrok` tunnel) — `"book me a meeting at 8am on monday september 21 2026"` got `"Here's what's open that day: 09:00 am, 09:30 am, 10:00 am, 10:30 am, 11:00 am, 11:30 am, 12:00 pm, 12:30 pm (UTC). Pick one of those, or tell me another time and I'll check it. Could you also tell me an email address to send the confirmation to and a name for the booking?"` on the first ask. Replying `"10am works, zain-livetest@example.com, Zain"` (picking a listed time) correctly reached the booking-confirmation summary; declined to avoid leaving a stray test appointment on the real resource.

**Verification**: ChatMate360 full suite **65 files / 347 tests passing** (up from 64/346 — the rewritten test file), zero regressions. `tsc --noEmit` clean.

## §24 — Document ingestion (Crawl Plus), daily/weekly usage caps, persisted trial deactivation, and a real local verification of the embed widget's CORS/origin logic (2026-09-18)

Three known gaps from an earlier plan-tier feature audit, closed in this session, plus a from-scratch local-environment verification of the embed widget's cross-origin behavior (previously only reasoned about from reading the code).

### Document ingestion (Crawl Plus / Full Custom only; Free plan explicitly excluded)

Was entirely unbuilt on the backend — the dashboard's Documents tab already showed the right upsell/plan-gate to Free-plan users, but there was no upload endpoint, storage, parsing, or retrieval behind it for a paying plan either.

- **Schema**: `chatbot_documents` (status: processing/ready/failed, error_message, chunk_count) and `chatbot_document_chunks` (`embedding vector(1536)`, same pgvector pattern `product_catalog_cache` already used) — `db/schema.sql`.
- **Parsing** (`src/lib/documentParsing.ts`): PDF (`pdf-parse`), DOCX (`mammoth`), XLSX (`exceljs`), TXT/MD/CSV (plain read). `xlsx`/SheetJS was deliberately NOT used — it carries an unpatched high-severity prototype-pollution/ReDoS advisory with no fix on npm, which would have failed this repo's CI security gate (`npm audit --omit=dev --audit-level=high`, `.github/workflows/ci.yml`); `exceljs` has none.
- **Quality check, using OpenAI to verify extraction correctness** (`src/lib/documentQualityCheck.ts:129` `verifyExtractedText`): a free heuristic printable-character-ratio pass runs first (catches garbled/scanned-image extractions without any API cost), then — only if that passes, and only if `OPENAI_API_KEY` is configured — a sample of the extracted text is sent to OpenAI with a scoped prompt asking whether it reads as genuine coherent content vs. extraction noise, returning strict `{valid, reason}` JSON. Both checks fail closed on their actual target (reject garbled content) but fail open on their own errors (OpenAI unreachable/timeout/bad JSON leads to a pass, logged) — a broken quality check must never block a legitimately good upload.
- **Chunking** (`src/lib/chunkText.ts`): paragraph-boundary-aware, ~1200 chars with 150 overlap.
- **Service** (`src/services/documentIngestion.service.ts`): `uploadDocument` (`:77`, plan-gated via `entitlement.documentIngestion` — 402 on Free), `listDocuments`, `deleteDocument`, `lookupRelevantDocumentChunks` (`:185`, pgvector similarity search, called from the answering pipeline).
- **Plan gate** (`src/lib/plans.ts:13`): new `documentIngestion: boolean` field — `false` for free, `true` for crawl_plus/full_custom.
- **Answering integration** (`src/lib/answerChatbotQuestion.ts`): entitlement is now fetched once up front (previously only fetched conditionally, inside the cost-cap-reservation branch) and reused both for the document-lookup gate and the existing cost-cap logic. Free-plan chatbots skip the document lookup entirely — no embedding-API spend for a feature they don't have. `src/lib/ai.ts`'s system prompt gained a third labeled context tier, "UPLOADED DOCUMENT CONTENT," alongside the existing LIVE DATA / CRAWLED PAGE CONTENT tiers, with the grounding-guard instructions updated to describe how the three trade off.
- **Frontend**: `components/dashboard/documents-panel.tsx` (new) — real upload/list/delete UI with per-file status, wired into `documents-section.tsx` (replacing its "not available yet" stub for paid plans); `lib/api.ts` gained `uploadFile()` for multipart requests (the existing `api()` helper hardcodes a JSON Content-Type header, incompatible with `FormData`).
- **Routes**: `POST/GET /chatbots/:chatbotId/documents`, `DELETE /chatbots/:chatbotId/documents/:id` (`src/routes/chatbot.routes.ts`), `src/middleware/uploadDocument.ts` (multer, memory storage, translates multer's own errors into the app's `AppError` shape rather than the generic 500 the global error handler would otherwise give them).

### Daily and weekly usage caps (previously monthly-only)

- **Period keys** (`src/services/usage.service.ts:22` `currentDayPeriod`, `:29` `currentWeekPeriod`): a calendar-day string and an ISO-8601 week string, alongside the existing month string. No schema change — `chatbot_usage.billing_period` was always a plain `text` column; a day/week string lives in it exactly like the month string already did. "Refreshing on schedule" is free: a new day/week is just a new key, nothing to reset.
- **Independent checking** (`:146` `isModelQuotaAvailable`): now loops over all three windows and blocks if ANY is at or over its cap — not just the monthly one.
- **Atomic reservation** (`:162` `reserveModelCostSlot`): signature changed from a single `capUsd: number` to the full `Entitlement` (call site: `src/lib/answerChatbotQuestion.ts`) — reserves against all three windows' Redis keys, rolls back all three if any is exceeded.
- **Recording** (`recordUsage`): writes the same per-model totals into all three windows' rows per call — one shared write path, not a second parallel tracking system.
- **Per-plan caps, env-configurable** (`src/env.ts`, `.env.example`): `FREE_PLAN_DAILY_COST_CAP_USD` ($0.05) / `WEEKLY` ($0.15) alongside the existing `MONTHLY` ($0.50); same pattern for Crawl Plus ($0.50/$1.50/$5) and Full Custom ($15/$50/$150).
- **Dashboard**: `getUsageWindowSummariesForOwner` (`:397`) returns day/week/month summaries together, each model row carrying its own `capUsd` — `GET /chatbots/:id/usage` now returns both the original `usage` field (back-compat, unchanged shape) and a new `windows` field. `components/dashboard/usage-panel.tsx` gained a Today/This week/This month tab selector with a per-model progress bar against that window's cap.
- **Test proving genuine independence** (`tests/integration/usageWindows.integration.test.ts`, new): records usage between the daily and weekly caps (above daily, below weekly and monthly) and confirms `isModelQuotaAvailable`/`isOverCostCap` still correctly block — proves the daily check isn't just being silently covered by the monthly one.
- **Also fixed**: Crawl Plus's monthly cap was $50 (100x the $0.50 Free cap) against a 5-10x spec — dropped to $5 (10x).

### Persisted account-deactivation state (trial expiry)

Previously: trial expiry was recomputed from `trial_started_at` arithmetic on every single answering request — no persisted flag, even though `users.is_active` (admin-controlled) already existed and was already enforced.

- **New column** (`db/schema.sql`): `users.trial_deactivated boolean not null default false` — deliberately separate from the existing admin-controlled `is_active`, so a user paying can never accidentally undo an admin's own deactivation (they clear independently, for different reasons).
- **Set** (`src/services/accessGate.service.ts:22` `persistTrialDeactivation`): `checkAnsweringGate` now reads `trial_deactivated` as a fast-path check (no date math, no entitlement lookup) before falling back to computing trial-expiry live and persisting it the first time it's found true.
- **Cleared** (`src/services/billing.service.ts:147` `clearTrialDeactivationIfEntitled`): hooked into `syncFromSubscription`, the same function every Stripe webhook path (`checkout.session.completed`, `customer.subscription.updated`, `.deleted`) already funnels through — clears the flag only when the resulting status is genuinely entitled (`active`/`trialing`), not on e.g. `past_due`.
- **Surfaced in the dashboard**: no new UI needed — `getAccountStatus`'s existing `isTrialExpired` field (already rendered by `components/dashboard/embed-panel.tsx`'s `statusBadgeFor` as a "Trial expired — upgrade to continue" badge) now ORs the persisted flag with the live check, so the existing badge is now backed by real persisted state instead of only a per-request recomputation.
- **Full-cycle test** (`tests/integration/trialDeactivation.integration.test.ts`, new, 2 tests): backdates a real user's trial, confirms the gate blocks AND persists the flag, confirms a second gate check still blocks via the persisted flag alone, fires a real (faked, no Stripe API call needed for this event type) `customer.subscription.updated` webhook, confirms the flag clears and answering resumes — plus a second test proving a non-entitled status update (`past_due`) does NOT clear it.

### Embed widget — real local verification (not just re-reading the code)

Brought up the full local stack (Docker Postgres/Redis, backend, frontend — none of it was running at session start; Docker Desktop's daemon itself wasn't running) and tested the actual deployed authorization/CORS logic with real HTTP requests against a real created chatbot, rather than reasoning about it from source alone:

- Origin authorization (`X-Widget-Origin` header, `src/services/public.service.ts`'s `authorizePublicRequest`): 5/5 cases matched the code exactly (allowed domain leads to 200, subdomain of allowed domain leads to 200, missing header leads to 403, wrong domain leads to 403, unknown chatbot leads to 404), including a real end-to-end chat answer.
- CORS (`Origin` header, `src/app.ts`'s `cors({ origin: env.frontendUrl })`): initially looked broken (`Access-Control-Allow-Origin` was identical regardless of the request's real `Origin`) — turned out to be `curl` not enforcing CORS the way a browser does; a static-string `cors` config is supposed to always emit that one value and rely on the BROWSER to compare it against the tab's real origin, which is exactly what's happening. Confirmed correct, not a bug, after also independently finding and fixing a real (unrelated) process-management issue: an orphaned backend process from an earlier restart had survived `TaskStop` and was silently serving a stale `FRONTEND_URL`, which is what produced the initial false reading.
- **Remaining real risk, explicitly not resolved this session**: this whole verification depends on `FRONTEND_URL` on the production AWS host matching the real deployed frontend URL exactly — not independently confirmed there (SSH access to that host was a separate, unresolved thread this session). Everything else about the widget's design is now verified correct; that one production config value is the only thing standing between "verified locally" and "verified in production."

### Local environment notes (this machine only, not a project-wide change)

- This machine already runs other unrelated Docker projects that collide with this repo's defaults — port 3000 (an unrelated `caldiy-calcom-1` container) and port 6379 (a generic `redis` container). Backend ran on its normal port 4000; frontend ran explicitly on 3010; this repo's Redis ran standalone on 6380 instead of docker-compose's default 6379. `docker-compose.yml` itself was NOT changed — this is purely how this session's local run was configured, not a new project convention.
- `npm run migrate` does not exist in this repo (checked `package.json`) — schema is applied via `psql`/`docker exec psql -f db/schema.sql`, same as CI (`.github/workflows/ci.yml`) and `DEPLOYMENT.md` already document.

### Verification

Backend: `npm run typecheck` clean, `npm run lint` clean (only pre-existing, unrelated warnings/errors — `booklyNodes.ts`'s unused `routeFromValidation`, two `@typescript-eslint/no-namespace` errors in `requestId.ts`/`requireAdminAuth.ts`, one unused import in `booklyAdminAuditIsolation.integration.test.ts`). Full suite against real local Postgres/Redis: **67 files / 351 tests passing** (up from 65/347 in §23 — 2 new files, 4 new tests, zero regressions).

Frontend: `npx tsc --noEmit` clean, `npm run lint` clean (only the pre-existing, unrelated `admin-shell.tsx` `react-hooks/exhaustive-deps` warning).

## §25 — Traced the "payment doesn't activate plan" bug to root cause, removed the non-functional SSO button, and gated onboarding document upload to paid plans (2026-09-23)

### 1. "User pays but plan doesn't change" — traced, not blindly patched

Read the real webhook path as it exists now, not from any doc:
- `src/services/billing.service.ts:61-77` (`createCheckoutSession`) — reuses an existing `stripe_customer_id` via `getOrCreateStripeCustomer` (`:37-52`), correct.
- `src/services/billing.service.ts:239-298` (`checkout.session.completed` handler) — retrieves the real subscription and calls `syncFromSubscription(subscription, session.metadata?.userId)`, correct.
- `src/services/billing.service.ts:218-232` (`syncFromSubscription`) → `upsertSubscriptionRow` (`:134-174`) — a plain `INSERT ... ON CONFLICT (user_id) DO UPDATE` (userId path) or `UPDATE ... WHERE stripe_customer_id = $1` (webhook-only path), no caching involved.
- `src/services/billing.service.ts:372-398` (`getEntitlementForChatbot`/`getEntitlementForUser`) — both read straight from Postgres on every call. **No Redis, no in-memory cache, no stale-JWT-claim path exists anywhere in this chain.** Ruled out as a cause.

Reproduced live end-to-end (Stripe test mode, real card `4242 4242 4242 4242`, real account `developertag1@gmail.com`):
- Started `stripe listen --forward-to localhost:4000/webhooks/stripe` — **this had not been running**, which on its own is sufficient to fully explain "paid but plan never changes" in local dev: without it, Stripe has no way to reach `localhost:4000/webhooks/stripe` at all, so `checkout.session.completed` never arrives, `syncFromSubscription` never runs, and `subscriptions.plan` stays `free` forever — with no error surfaced anywhere, because nothing failed; nothing was ever tried.
- With the listener running, completed a real checkout. The webhook backend crashed outright (`stripe listen` logged `[ERROR] Failed to POST: ... An existing connection was forcibly closed by the remote host`; `curl localhost:4000/health` went from `200` to connection-refused). **This was NOT reproducible** — resending the identical event (`stripe events resend evt_1UIaGOH7OcxOOtNLuQ3LxkaH`) against a freshly restarted backend processed cleanly (`"msg":"stripe checkout completed"` logged, `subscriptions` row updated to `crawl_plus`/`active` within the same second, `GET /billing/summary` immediately returned `planActive: true`). The handler itself (`src/controllers/billing.controller.ts:43-75`) already wraps `processStripeWebhookEvent` in try/catch and returns a clean 500 on failure — there is no unguarded async gap that should be able to crash the process. The most consistent explanation, given zero application-level log output before the crash and non-reproducibility on identical input, is this dev machine's own memory-pressure process reaper (independently observed killing idle dev servers multiple times this same session) coinciding with that one request — not a defect in the webhook code.

**Root cause, evidence-ranked:**
1. **Primary, confirmed cause of what was almost certainly observed:** no local Stripe CLI webhook listener running, so `checkout.session.completed` never reaches the backend at all. This is an environment/setup gap, not an application bug — the handler code, once actually invoked, is correct (proven by the successful resend).
2. **Secondary, unconfirmed/non-reproducible:** a single crash during live webhook delivery, most likely caused by this machine's memory-pressure reaper rather than the handler itself.
3. If this was instead observed against the AWS production stack rather than locally, it very likely ties back to the still-unresolved AWS webhook-endpoint TLS/reachability issue flagged earlier this session (`PROJECT_STATE.md`) — not re-verified in this pass, since that requires access this session doesn't have.

**Fix applied** (frontend/Chatmate360-main, `components/dashboard/billing-panel.tsx:51-67`, `bannerFromSearchParams`): the post-checkout polling banner (`components/dashboard/billing-panel.tsx:113-143`, already polls `/billing/summary` up to 20× every 2s after a `checkout=success` redirect) previously gave up silently with "Your plan updates when Stripe confirms the subscription." — true, but no next step for the user. Now: "Payment received, but we haven't heard back from Stripe confirming it yet. This can happen briefly — try reloading this page in a minute, or contact support if your plan still hasn't updated." No backend change was made, since none of the traced backend logic was found to be at fault.

**Verified:** real checkout → real webhook (once delivered) → `subscriptions` row updates → `GET /billing/summary` returns `planActive: true` within the same request cycle. No code path found where the DB is correctly updated but a stale read is served.

### 2. Removed the non-functional "SSO" button

`components/auth/auth-form.tsx` had two social buttons: "Continue with Google" (real — `POST /auth/google`, then a real redirect) and "Continue with SSO" (`continueWithSso()`, formerly `:53-56`, did nothing but `setError("SSO isn't set up yet...")` — no backend route, no functionality, matching the already-documented "SSO not built" gap). Removed the SSO button, its handler, and its unused `SsoIcon()` helper. Google OAuth is untouched and still works identically. `.auth-social` is `flex-direction: column; width: 100%` per button (`app/site.css:2467-2471`), so the layout is unaffected by dropping from two buttons to one.

### 3. Onboarding document upload now hidden for Free-plan users

Per the still-open gap this session already documented (`PROJECT_STATE.md` §7, `CHATMATE360_FULL_CONTEXT.md` §3 frontend directory reference): onboarding-time PDF/Word upload (`components/onboarding/create-chatbot.tsx`) only ever produced a character-count *estimate* (`estimateFileCharacters`, `:48-50`) — it never extracted or indexed real text, so the uploaded file contributed nothing to what the resulting chatbot could actually answer from. Showing this option to a Free-plan user was actively misleading regardless of this request.

Fixed by reusing the exact entitlement check already used elsewhere in the dashboard (`components/dashboard/workspace.tsx`'s `isPaidPlan`), rather than a new one-off condition — widened its parameter type from the full `AccountStatus` to the narrower `{ plan: string; planActive: boolean }` (`workspace.tsx:29`) so it can be fed from `GET /billing/summary` directly, since onboarding has no chatbot yet and therefore no `AccountStatus`. `create-chatbot.tsx` now fetches `/billing/summary` alongside `/auth/me` and hides the Files tab, its panel, and its footer entirely (not just disables them) when `!isPaidPlan(billing)`; intro copy is plan-aware too. Crawl Plus / Full Custom onboarding is unchanged — both tabs still render.

**Verified live**, both directions, real accounts:
- `zainrafique23@gmail.com` (Free, 0 chatbots): only the website URL field renders, no Files tab, copy reads "Add your website. We'll train your first chatbot on this content."
- `developertag1@gmail.com` (Crawl Plus/active, 0 chatbots — upgraded live during item 1's test above): both "Files" and "Website" tabs render exactly as before.

### Verification

Frontend: `npx tsc --noEmit` clean, `npx eslint` clean on all four touched files (`components/dashboard/billing-panel.tsx`, `components/auth/auth-form.tsx`, `components/onboarding/create-chatbot.tsx`, `components/dashboard/workspace.tsx`), full `npm run build` clean (34/34 routes). Backend: no backend code changed for these three items (traced but not modified — root cause was environmental, not code).

### Investigated, NOT implemented (held for confirmation per explicit instruction)

- **Signed-in users and public/marketing pages:** current actual behavior verified — there is no `middleware.ts` in the frontend repo, and neither `app/(marketing)/layout.tsx` nor `MarketingShell`/any layout component reads auth state or redirects at all. A signed-in user can browse every public marketing page today with no forced sign-out, no broken layout, and no redirect — this reproduces neither "(a) currently broken, needs fixing" nor "(b) sign-out should be enforced" as a *current* behavior, since nothing currently happens either way. Reported to the user; did not implement either interpretation.
- **New chatbot page layout:** `/dashboard/new-chatbot` (`app/(app)/dashboard/new-chatbot/page.tsx`) is already a single, standalone, dedicated route rendered inside the same persistent sidebar shell every other dashboard page uses (Overview, Websites, Billing, Settings, etc.) — it is not nested inside another page and not a modal. The only sidebar-specific thing is a "+ New chatbot" quick-link inside the sidebar's chatbot switcher (`components/dashboard/workspace-shell.tsx`) that navigates to this same page — an additional entry point, not the page's actual location. Current structure does not match the "buried in a sidebar/nested below" description as given. Reported to the user; did not change anything.
