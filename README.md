# Chatmate360 Backend

Backend for Chatmate360: authentication, chatbot creation/crawling/answering,
the embeddable public chat widget, per-chatbot live data, waitlist/trial/
contact forms, and a sandboxed live-demo chat.

Runs on **plain, self-hosted PostgreSQL** — there is no Supabase dependency
anywhere in this codebase. The demo chat (`POST /demo/chat`) never reads or
writes the database at all; it serves preloaded replies from
`src/data/demo-replies.json`.

## Structure

```
src/
  routes/         HTTP paths only
  controllers/    request/response
  services/       business logic + Postgres
  validators/     Zod schemas
  middleware/     auth, rate limiting, request-id, error handling
  lib/            crawler, AI answering, caching, logging, and other
                   framework-independent logic
db/
  schema.sql      full schema — idempotent, safe to re-run
```

The `demo` service does not import the database at all.

## Architecture at a glance

- **Auth**: real, revocable session auth (bcrypt + JWT access/refresh tokens,
  rotated on every refresh), plus optional Google OAuth. No Supabase Auth.
- **Website crawler** (`src/lib/crawler/`): SSRF-hardened, bounded (page
  count, depth, timeouts), falls back to a headless-Chromium (Playwright)
  render for JS-rendered pages. Runs as a **background job**, not inline in
  a request — `POST /chatbots` enqueues via BullMQ (`src/lib/queue.ts`) and
  returns immediately; the crawl itself runs in a separate worker process
  (`src/worker.ts`, started with `npm run worker:start`).
- **Chat answering** (`src/lib/ai.ts`, `src/lib/answerChatbotQuestion.ts`):
  tries Claude → OpenAI → Gemini → Ollama (skipping any provider whose key
  isn't set), grounded in crawled page content **and** per-chatbot live data
  (`chatbot_live_data` — see below), with a regex-based post-generation
  check that swaps out any AI answer containing a checkable claim (price,
  date, phone, email) that doesn't actually appear in the context it was
  given. Falls back to a plain keyword matcher if no AI provider is
  configured or every provider fails.
- **Live data**: a generic per-chatbot key-value store
  (`chatbot_live_data` table) chatbot owners manage via
  `/chatbots/live-data`, for facts that change faster than a re-crawl
  (current stock, price, availability). Merged into the AI's context ahead
  of crawled content and treated as authoritative on conflict.
- **Public embeddable widget**: served from `/embed/v1/embed.js`
  (`src/public/embed.js`), identifies its chatbot via a `data-chatbot-id`
  attribute, and is gated by a per-chatbot allowed-domain check
  (`src/lib/originAllowed.ts`) backed by Redis rate limiting — see
  `RISK_LOG.md` and `PRODUCTION_READINESS_REPORT.md` for the exact trust
  model (the domain header is a spoofable client-supplied signal, backed by
  a stricter rate-limit tier on mismatch, not a hard security boundary).
- **Caching & rate limiting**: Redis-backed (`src/lib/cache.ts`,
  `src/middleware/rateLimitPublic.ts`, `src/middleware/rateLimitAuthenticatedChat.ts`),
  one shared connection (`src/lib/redis.ts`) also used by the BullMQ crawl
  queue.
- **Logging**: structured (pino, `src/lib/logger.ts`), every request carries
  an id (`src/middleware/requestId.ts`) that's included in every log line
  for that request, including across the crawl-queue → worker-process
  boundary.

See `IMPLEMENTATION_STATUS.md` for what's actually been verified working and
what's still a known gap, and `PRODUCTION_READINESS_REPORT.md` /
`RISK_LOG.md` for the most recent hardening pass and its accepted risks.

## Setup

Requires Node.js 20+, Docker (for local Postgres + Redis).

```bash
cp .env.example .env
npm install
```

Start local Postgres and Redis:

```bash
docker compose up -d
```

Apply the schema (safe to re-run any time — every statement is
idempotent):

```bash
docker exec -i <postgres-container-name> psql -U postgres -d chatmate360 < db/schema.sql
```

Fill in `.env` — at minimum:

- `DATABASE_URL` — defaults to the docker-compose Postgres on port `5435`
  (`5432`/`5433` are commonly already taken by another local Postgres
  instance, hence the non-default port)
- `JWT_SECRET` — required for auth to work at all (`openssl rand -hex 32`
  for anything beyond local dev)
- At least one of `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` /
  `OLLAMA_BASE_URL` — chatbots fall back to a plain keyword matcher with none
  configured
- `REDIS_URL` — defaults to the docker-compose Redis on the standard port

Everything else in `.env.example` has a working default and is documented
inline (rate limits, cache TTLs, crawler concurrency, log level).

For Google login, create an OAuth client in Google Cloud Console, set
`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_REDIRECT_URI`, and register
this exact redirect URI on the OAuth client:

`http://localhost:4000/auth/google/callback`

Run the API:

```bash
npm run dev
```

API: `http://localhost:4000`

Run the crawl worker **in a separate terminal** — chatbots created with a
`websiteUrl` will stay `queued` forever without it:

```bash
npm run worker
```

### Tests

```bash
npm test
```

Needs a separate `chatmate360_test` database (same Postgres instance, see
`.env.test.example`) and the same local Redis — see `vitest.config.ts` for
exact defaults and `.env.test.example` for how to point them elsewhere.

### Lint & typecheck

```bash
npm run lint
npm run typecheck
```

## Endpoints

Full request/response shapes are in each route's Zod validator
(`src/validators/`); this is the map of what exists.

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/health` | — | |
| `POST` | `/auth/signup` | — | `{ name, email, password }` |
| `POST` | `/auth/login` | — | `{ email, password }` |
| `POST` | `/auth/google` | — | Returns the Google OAuth consent URL |
| `GET` | `/auth/google/callback` | — | Google redirects the browser here; not an API call |
| `GET` | `/auth/me` | Bearer | |
| `POST` | `/auth/refresh` | — | `{ refreshToken }`, rotates it |
| `POST` | `/auth/logout` | — | `{ refreshToken }`, revokes it |
| `POST` | `/chatbots` | Bearer | Create the caller's one chatbot; `websiteUrl` enqueues a background crawl |
| `GET` | `/chatbots/status` | Bearer | Poll crawl status: `queued`/`crawling`/`processing`/`ready`/`failed` |
| `PATCH` | `/chatbots/theme` \| `/domain` \| `/fallback-message` | Bearer | |
| `POST` | `/chatbots/chat` | Bearer | Owner's preview chat — rate limited per user (`AUTHENTICATED_CHAT_RATE_LIMIT_PER_MIN`) |
| `GET`/`POST` | `/chatbots/live-data` | Bearer | List/create live-data rows for the caller's own chatbot |
| `PATCH`/`DELETE` | `/chatbots/live-data/:id` | Bearer | Ownership re-verified server-side on every call, never trusts the id alone |
| `GET` | `/public/chatbots/:userId` | Widget-origin | Public widget config (theme, name) |
| `POST` | `/public/chatbots/:userId/chat` | Widget-origin | Public widget chat — rate limited per chatbot+IP (`PUBLIC_CHAT_RATE_LIMIT_PER_MIN`) |
| `POST` | `/waitlist` | — | `{ email }` |
| `POST` | `/trial` | — | `{ name, email, company?, plan? }` |
| `POST` | `/contact` | — | `{ name, email, message }` |
| `POST` | `/demo/chat` | — | `{ message }` — sandboxed, never touches the database |
| `GET` | `/embed/v1/embed.js` | — | The embeddable widget script |

Demo example:

```bash
curl -X POST http://localhost:4000/demo/chat ^
  -H "Content-Type: application/json" ^
  -d "{\"message\":\"Where is my order?\"}"
```
