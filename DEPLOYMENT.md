# Deploying ChatMate360 — from localhost to a real public domain

Covers both repos — this backend and `Chatmate360-main` (the Next.js
frontend). This version rewrites the original deployment doc around one
concrete goal: **get off `localhost:4000`/`localhost:3000` and onto a real
public domain, on free or near-free hosting, so the embed widget actually
works when a customer pastes it onto their own live site.** Every claim below
was re-verified against the current code (`src/env.ts`, `src/app.ts`,
`docker-compose.yml`, `Dockerfile`, both repos' `.github/workflows/`,
`Chatmate360-main`'s `lib/api.ts`/`embed-panel.tsx`/`vercel.json`) and every
price against the providers' current pricing pages/docs, not remembered or
assumed numbers — sources are named inline. Anything that needs a human
clicking through a web dashboard is marked **MANUAL STEP**; everything else
is an exact command or file to copy.

---

## 1. Recommended free/cheap hosting for each piece

| Piece | Recommendation | Why |
|---|---|---|
| Backend API + crawl worker | **Railway** | The worker (`src/worker.ts`) has to stay running continuously — it holds a persistent BullMQ/Redis connection and picks up crawl jobs as they're enqueued, not on a schedule. That rules out anything serverless/functions-based. Between the two realistic "always-on process" hosts: **Render has no free tier for background workers at all** — its free tier only covers web services, static sites, Postgres, and its Key Value product; a background worker needs a paid plan starting at **$7/month**, and that's on top of another $7/month for the API itself if it also needs to stay always-on rather than sleep (Render's free *web services* spin down after 15 minutes of no inbound traffic — fine for a hobby site, not for an API a live chat widget depends on). Railway has no such worker restriction: both the API and the worker are just services in one project, billed per-second for actual CPU/memory/disk used, with the **Hobby plan ($5/month) including $5/month of usage credit** — for a low-traffic setup, actual usage-based billing is likely to land at or near that $5 baseline rather than the $14/month Render's fixed-per-service pricing would guarantee. Railway also deploys straight from this repo's existing `Dockerfile` with no changes needed. |
| Database (Postgres) | **Neon** | Genuinely free tier (100 CU-hours/month, 0.5 GB storage/project, up to 100 projects, 10 branches/project) with **scale-to-zero** — it suspends after 5 minutes idle and costs nothing while suspended, only storage is billed. It's real Postgres (the `pg` driver already used here works unmodified — see `src/lib/db.ts`), not a proprietary API, so there's no code change and no lock-in. Using Railway's own bundled Postgres instead would work too, but it's billed from the same always-on CPU/memory pool as the API/worker services (no scale-to-zero), so it doesn't save anything over just running Neon alongside it for free. |
| Redis (BullMQ + rate limiting + caching) | **Upstash** | Needs to support real Redis TCP (blocking commands), not just a REST API — BullMQ requires it. Upstash exposes both a REST API *and* the standard Redis TCP protocol, so `ioredis` (`src/lib/redis.ts`) connects exactly as it does locally. Free tier: 256 MB, 500K commands/month, 10 GB bandwidth/month, one database. Same reasoning as Neon over Railway's own Redis: Upstash's free allowance is separate from Railway's usage-based compute budget, so using it doesn't eat into the $5 Hobby credit the API/worker are billed from. |
| Frontend (Next.js) | **Vercel** (already the right default — confirmed, not changed) | `Chatmate360-main` already has `vercel.json` and a GitHub Actions pipeline configured for a specific Vercel project (`chatmate360-wwdr`) — see §2.4, this is not a fresh choice, it's already built. Hobby (free) tier: 1M edge requests/month, 100 GB fast data transfer/month, 1M function invocations + 4 hours active CPU/month, 5 hours Vercel Sandbox/month — comfortably enough for a dashboard app with this traffic profile. |
| Object storage / CDN for `embed.js` | **Not needed as a separate service.** | `embed.js` is already served directly by the Express backend at `/embed/v1/embed.js` with a `Cache-Control: public, max-age=86400, immutable` header (`src/app.ts`) — that's correct, working static-file serving with cache headers already, no S3/object-storage bucket required. If you want real CDN edge-caching later (optional, not required for the widget to work): put the backend's domain behind **Cloudflare's free plan** (DNS + CDN proxy, $0) — that's a DNS change, not a code or hosting change, and most people end up doing it for the whole domain anyway. |

**Sources** (fetched live, not from training-data memory): Railway pricing —
[railway.com/pricing](https://railway.com/pricing); Render free-tier limits
and worker/spin-down behavior —
[render.com/docs/free](https://render.com/docs/free); Neon free-tier limits
and 2026 pricing changes — aggregated from
[agentdeals.dev/vendor/neon](https://agentdeals.dev/vendor/neon) and
[selfhost.dev](https://selfhost.dev/blog/neon-pricing-cost-of-serverless-postgres/);
Upstash Redis pricing —
[upstash.com/pricing/redis](https://upstash.com/pricing/redis); Vercel
Hobby/Pro pricing —
[vercel.com/pricing](https://vercel.com/pricing).

---

## 2. Step-by-step deployment, in order

Order matters: the database and Redis need to exist first so the backend has
somewhere to connect on its very first boot; the backend needs to be live
(with a real public URL) before the frontend is deployed, since the
frontend's build bakes that URL in (see §3).

### 2.1 Database — Neon (Postgres)

**MANUAL STEP** — do this yourself:
1. Go to [neon.com](https://neon.com) → **Sign up** (GitHub sign-in is the
   fastest option) → **Create a project**. Name it `chatmate360` (or
   anything — the name doesn't matter to the app).
2. On the project's dashboard, find the **Connection string** panel. Select
   the `neondb` database (or create a new one — either works, just note the
   name). Copy the connection string — it looks like:
   `postgresql://<user>:<password>@<host>.neon.tech/<dbname>?sslmode=require`

Apply the schema (from your own machine, needs the `psql` client — already
on your PATH if you've run the local dev setup, since `docker exec ... psql`
implies Postgres client tooling is reachable; if `psql` isn't installed
locally, `psql --version` will tell you, and the Postgres.app / `apt install
postgresql-client` / `brew install libpq` installers all provide it):

```sh
psql "postgresql://<user>:<password>@<host>.neon.tech/<dbname>?sslmode=require" -f db/schema.sql
```

This is the exact same idempotent `db/schema.sql` used locally — safe to
re-run if you ever need to.

**Verify before moving on:**

```sh
psql "postgresql://<user>:<password>@<host>.neon.tech/<dbname>?sslmode=require" -c "\dt"
```

Should list `users`, `chatbots`, `refresh_tokens`, `chatbot_live_data`,
`waitlist`, `trial_signups`, `contact_submissions`. If this comes back
empty, the schema didn't apply — re-run the `psql -f db/schema.sql` command
above and check for errors in its output before continuing.

### 2.2 Redis — Upstash

**MANUAL STEP** — do this yourself:
1. Go to [upstash.com](https://upstash.com) → **Sign up** (GitHub sign-in
   again is fastest) → **Create Database**.
2. Name it `chatmate360`, pick a region close to wherever you'll deploy the
   backend (Railway lets you pick a region too — see §2.3; matching regions
   keeps latency low between the backend and Redis).
3. On the database's detail page, find **TCP** connection details (not the
   REST API section — this app needs real Redis TCP, not the REST API).
   Copy the connection string shown there — it looks like:
   `rediss://default:<password>@<host>.upstash.io:<port>`
   (note: `rediss://`, with two S's — TLS-enabled Redis. `ioredis`, already
   used in `src/lib/redis.ts`, handles this transparently — no code change.)

**Verify before moving on** (needs `redis-cli` locally — optional, skip this
specific check if you don't have it installed; the backend startup itself
will fail loudly in its logs if this connection string is wrong, so it's not
a hard blocker to continue):

```sh
redis-cli -u "rediss://default:<password>@<host>.upstash.io:<port>" PING
```

Should return `PONG`.

### 2.3 Backend API + crawl worker — Railway

**MANUAL STEP** — do this yourself:
1. Go to [railway.com](https://railway.com) → **Sign up** (GitHub sign-in) →
   **New Project** → **Deploy from GitHub repo** → select the
   `Chatmate360-Backend-main` repo (Railway will ask for GitHub App access
   to your repos the first time — grant it access to this one repo, or all
   repos if you'd rather not manage that list).
2. Railway will detect the `Dockerfile` in this repo automatically and use
   it — no build configuration needed. It creates one service; this becomes
   your **API** service. Rename it to `chatmate360-api` (Settings → Service
   Name) so the next step is unambiguous.
3. **Add a second service for the worker**, same repo: in the project,
   **+ New** → **GitHub Repo** → the same `Chatmate360-Backend-main` repo
   again. Rename this one `chatmate360-worker`. Go to its **Settings →
   Deploy** section and set **Custom Start Command** to:
   ```
   npm run worker:start
   ```
   This overrides the `Dockerfile`'s default `CMD ["npm", "run", "start"]`
   for this service only — same image, same code, different process, exactly
   matching the two-container pattern the original version of this doc
   already described for a generic Docker host.
4. On the **API** service (`chatmate360-api`), go to **Settings → Networking**
   → **Generate Domain**. Railway gives you a free `*.up.railway.app`
   subdomain immediately (e.g. `chatmate360-api-production.up.railway.app`)
   — this is your backend's real public URL. You can point a custom domain
   at it later (Settings → Networking → Custom Domain) once you own one;
   the free subdomain works fully in the meantime, including for the embed
   widget.
5. **Environment variables** — on **both** services (API and worker need the
   same `DATABASE_URL`/`REDIS_URL`/`JWT_SECRET`; the worker specifically
   also needs the AI provider keys since it doesn't call them directly but
   inherits the same `.env` shape — simplest to just set the same variables
   on both rather than track which service needs which), go to **Variables**
   and add:

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | the Neon connection string from §2.1 |
   | `REDIS_URL` | the Upstash `rediss://...` string from §2.2 |
   | `JWT_SECRET` | a real secret — generate one locally: `openssl rand -hex 32` |
   | `FRONTEND_URL` | your Vercel frontend's URL (§2.4) — you won't have this yet on first deploy; set it to a placeholder like `https://placeholder.vercel.app` for now and come back to update it once §2.4 gives you the real one (Railway redeploys automatically when a variable changes) |
   | `TRUST_PROXY_HOPS` | `1` — Railway sits behind its own edge proxy, so this must be `1`, not the local-dev default of `0` (see §3 for why this matters) |
   | `NODE_ENV` | `production` |
   | `PORT` | `4000` (Railway auto-injects its own `PORT` and expects the app to bind to it — this app already reads `process.env.PORT` via `env.port` in `src/env.ts`, so Railway's injected value is used automatically; setting it explicitly here is just to be safe/explicit) |
   | At least one of: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` | your real key(s) — without at least one, chatbots fall back to the plain keyword matcher, not real AI answers |

   Leave everything else at `.env.example`'s defaults unless you have a
   specific reason to change it (rate limits, cache TTLs, etc. — all
   documented inline in that file).

**Verify before moving on:**

```sh
curl https://<your-railway-api-domain>/health
```

Should return `{"ok":true,"service":"chatmate360-backend","demo":"sandbox"}`.
Then check the **worker** service's logs (Railway dashboard → worker service
→ Deployments → View Logs) for a line like `"worker listening"` with the
queue name and concurrency — confirms it connected to Redis and is actually
picking up jobs, not just that the container started.

### 2.4 Frontend — Vercel

`Chatmate360-main` already has a Vercel project (`chatmate360-wwdr`,
`vercel.json`) and a GitHub Actions pipeline
(`.github/workflows/ci.yml`) that deploys to it — **but only for commits
authored by `developertag1@gmail.com`**, and Vercel's own git-push
auto-deploy is deliberately disabled (`vercel.json`'s `ignoreCommand` always
skips it) so a broken push can't bypass the CI gates. If that's your email
and your existing project, here's what's actually left to do:

**MANUAL STEP** — do this yourself:
1. Get a Vercel token: [vercel.com/account/tokens](https://vercel.com/account/tokens)
   → **Create Token** → name it anything (e.g. `github-actions-deploy`) →
   copy the token immediately (shown once).
2. Get your Vercel Org/Team ID: Vercel dashboard → your account or team →
   **Settings → General** → copy the **Team ID** (or **User ID** if this is
   a personal account, not a team).
3. In the `Chatmate360-main` GitHub repo: **Settings → Secrets and variables
   → Actions → New repository secret**, add both:
   - `VERCEL_TOKEN` = the token from step 1
   - `VERCEL_ORG_ID` = the ID from step 2
   (`VERCEL_PROJECT_ID` is already hardcoded in `.github/workflows/ci.yml` —
   `prj_u9HjXdWhTXGDBu1OqwAIHD94hmKM` — no need to set it as a secret.)
4. **Set the frontend's environment variables in Vercel itself** (not
   GitHub) — Vercel dashboard → `chatmate360-wwdr` project → **Settings →
   Environment Variables**, add for the **Production** environment:
   - `NEXT_PUBLIC_API_URL` = your Railway API's public URL from §2.3 (e.g.
     `https://chatmate360-api-production.up.railway.app`) — **no trailing
     slash**
   - `NEXT_PUBLIC_SITE_URL` = the frontend's own production URL (Vercel
     shows this once the project has deployed at least once — a
     `*.vercel.app` URL is fine, or your own custom domain if you've added
     one under **Settings → Domains**)
5. Commit and push to `main` as `developertag1@gmail.com` (or however your
   git config is already set for this repo — check with `git config
   user.email`). The pipeline runs the email gate → `pnpm lint` → `pnpm
   build` → deploys to `chatmate360-wwdr` automatically. No manual "deploy"
   click needed once the secrets above are set — that's the point of the
   existing pipeline.

**Verify before moving on:**

```sh
curl -I https://<your-vercel-domain>
```

Should return `HTTP/2 200`. Then open it in a browser and confirm the
landing page loads.

---

## 3. Switching off localhost — the actual blocker

Every place `localhost` currently appears as a default, found by grepping
both repos' source and env-example files directly (not assumed):

### Backend (`Chatmate360-Backend-main`)

| Variable | Where it defaults to localhost | What breaks if left on localhost in production | Set it to |
|---|---|---|---|
| `FRONTEND_URL` | `src/env.ts:12` — `"http://localhost:3000"` | CORS (`src/app.ts`: `cors({ origin: env.frontendUrl })`) rejects every request from your real Vercel domain — the dashboard silently fails to load any data. Also the redirect target after Google OAuth (`src/services/auth.service.ts`) — sign-in would redirect back to `localhost`. | Your real Vercel frontend URL, e.g. `https://chatmate360-wwdr.vercel.app` or your custom domain |
| `REDIS_URL` | `src/env.ts:56` — `"redis://localhost:6379"` | Backend can't reach Redis at all in production (nothing is listening on `localhost` inside Railway's container) — crawl jobs never get enqueued, rate limiting and caching silently no-op or error. | Your Upstash `rediss://...` string from §2.2 |
| `DATABASE_URL` | no in-code default — `.env.example:15` shows the local docker-compose value `postgresql://postgres:postgres@localhost:5435/chatmate360` as an *example*, not a fallback the app uses if unset (an unset `DATABASE_URL` makes `hasDatabase` false — the app runs, but every DB-backed route returns a 503) | Every authenticated/chatbot/live-data route returns `503 Database is not configured` | Your Neon connection string from §2.1 |
| `OLLAMA_BASE_URL` | `.env.example:44` — `http://localhost:11434` | Only relevant if you're actually running a local Ollama model — this is meant to stay unset/blank in production unless you're separately hosting Ollama somewhere reachable from the backend. Not a blocker either way. | Leave blank unless you're hosting Ollama yourself |

**CORS is already correctly configured** — a single static origin
(`env.frontendUrl`), not a wildcard (`src/app.ts:56-60`, confirmed by
re-reading the current file: `cors({ origin: env.frontendUrl })`). No code
change needed here; it's entirely driven by the `FRONTEND_URL` env var
above — get that variable right and CORS is right.

### Frontend (`Chatmate360-main`)

| Variable | Where it defaults to localhost | What breaks if left on localhost | Set it to |
|---|---|---|---|
| `NEXT_PUBLIC_API_URL` | `lib/api.ts:1` — `"http://localhost:4000"` | Every API call from the dashboard (`lib/api.ts`'s `api()` helper) and, critically, **the embed snippet's `<script src="...">` itself** (`components/dashboard/embed-panel.tsx:49`) points at `localhost` — completely unreachable from a real visitor's browser on a customer's live site. **This is the actual blocker the whole point of this document is fixing.** | Your Railway API URL from §2.3 |
| `NEXT_PUBLIC_SITE_URL` | `app/layout.tsx:25` — `"http://localhost:3000"` | Only affects `metadataBase` — Open Graph/Twitter share-preview image URLs resolve to `localhost` instead of your real domain. Cosmetic (broken social share previews), not functional. | Your real Vercel frontend URL |

### Does the embed snippet actually update automatically once `NEXT_PUBLIC_API_URL` is fixed?

**Confirmed by reading `embed-panel.tsx` directly — yes, automatically, for
every chatbot, with one nuance worth understanding, not a bug to fix:**

The snippet (`embed-panel.tsx:46-58`) is built from a module-level constant,
`API_URL` (`lib/api.ts:1`), which is *not* stored per-chatbot in the
database — every chatbot's dashboard reads the exact same constant. So once
that constant is correct, every existing and future chatbot's generated
snippet is correct too, with no per-chatbot migration or "regenerate" step.

The one thing to understand: `NEXT_PUBLIC_*` variables in Next.js are baked
into the JavaScript bundle **at build time**, not read from the server at
request time. That means changing `NEXT_PUBLIC_API_URL` in the Vercel
dashboard alone does nothing until the next build — which is exactly what
step 5 of §2.4 already does (push → CI runs `pnpm build` with that variable
set → deploys the bundle that has it baked in). If you ever change
`NEXT_PUBLIC_API_URL` again later (e.g. moving off Railway), you need a new
build+deploy for it to take effect — an env var change alone, without a
redeploy, will not update already-built pages.

**Nothing to fix in code here** — this already works correctly once the env
var is set and a build runs.

---

## 4. Post-deployment verification checklist

Run through all of these, in order, before pointing any real customer at
this:

- [ ] **Backend health**: `curl https://<railway-api-domain>/health` →
  `{"ok":true,...}`
- [ ] **Worker is alive**: Railway dashboard → worker service logs show
  `"worker listening"` with a queue name and concurrency, not a crash loop
  or restart cycle
- [ ] **Frontend loads**: `curl -I https://<vercel-domain>` → `200`, and the
  landing page actually renders in a browser (not a blank page — a build
  succeeding doesn't guarantee runtime env vars are wired right)
- [ ] **Real end-to-end test, through the deployed backend, not localhost**:
  1. Sign up a test account on the live frontend
  2. Create a chatbot with a real `websiteUrl` (something small/fast to
     crawl)
  3. Poll `GET /chatbots/status` (via the dashboard, or
     `curl -H "Authorization: Bearer <token>" https://<railway-api-domain>/chatbots/status`)
     until `status` is `"ready"`, not stuck on `"queued"` (stuck = the
     worker isn't actually processing jobs — check its logs)
  4. Ask it a real question via the dashboard's preview chat
     (`POST /chatbots/chat`) and confirm a real, grounded answer comes back
     — not the fixed fallback message (unless the question genuinely isn't
     covered), and not an error
- [ ] **Embed tag points at the real domain, not localhost**: open the
  dashboard's embed panel, confirm the generated `<script src="...">` shows
  your Railway URL, not `localhost:4000`
- [ ] **Paste-test on one real external page**: create a throwaway static
  HTML page (or use a free service like a GitHub Pages test repo) hosted on
  an actual different domain than the backend or frontend, paste the embed
  snippet in, set that domain as the chatbot's **Allowed domain** in the
  dashboard first (the widget is rejected everywhere until this is set — see
  `embed-panel.tsx`'s own UI warning), then load the test page and confirm
  the chat bubble appears and answers correctly from that real external
  origin
- [ ] **Secrets are in the hosting platform's env management, not the
  repo**: `git log --all --source -- .env` (backend) and the same for
  `Chatmate360-main`'s `.env.local` should show these files were never
  committed (`.gitignore` already excludes them — confirm they're not
  tracked: `git status --ignored`); double-check the actual live values
  (API keys, `DATABASE_URL`, `JWT_SECRET`) exist only in Railway's and
  Vercel's respective **Variables**/**Environment Variables** panels, never
  pasted into a commit, a `README`, or a Slack message

---

## 5. Cost estimate

| Service | Free-tier limit | Realistic cost once you exceed it |
|---|---|---|
| Railway (API + worker) | $0/month tier exists but is capped at $1/month of usage credit — enough for light testing, not two continuously-running services | **Hobby plan, $5/month**, includes $5/month of usage credit; for a low-traffic setup (a handful of chatbots, occasional crawls) actual usage-based billing (CPU $0.00000772/vCPU-sec, memory $0.00000386/GB-sec, egress $0.05/GB) is likely to land at or near that $5 baseline. Budget **$5-15/month** realistically as traffic grows past "just launched." |
| Neon (Postgres) | 100 CU-hours/month, 0.5 GB storage, scale-to-zero (free while idle) | Launch plan compute: **$0.106/CU-hour**; storage **$0.35/GB-month**. A small production database staying mostly idle between requests is likely to stay free or near-free for a long time given scale-to-zero. |
| Upstash (Redis) | 256 MB, 500K commands/month, 10 GB bandwidth/month | Pay-as-you-go: **$0.20 per 100K commands** beyond the free allowance, storage **$0.25/GB-month** beyond the first free 1 GB, bandwidth free up to 200 GB/month then $0.03/GB. Rate-limiting + caching (Task 4) at low-to-moderate chat volume is likely to stay within or just past the free tier. |
| Vercel (frontend) | 1M edge requests/month, 100 GB data transfer/month, 1M function invocations | **Pro plan, $20/month** if you outgrow Hobby — unlikely for a dashboard-only frontend (the actual customer-facing chat widget traffic hits the *backend*, not Vercel) unless the marketing/landing pages get real traffic volume. |
| Cloudflare (optional CDN, not required) | Free plan: unlimited bandwidth, DNS, CDN proxy | $0 — the free plan is genuinely sufficient for this use case; only relevant if added at all. |
| **Realistic total to start** | | **$5-10/month** (Railway Hobby is the only piece close to certain to cost something from day one; Neon/Upstash/Vercel/Cloudflare free tiers cover a genuinely low-traffic launch) |

---

## 6. Reference (unchanged from before, still accurate)

Kept from the original version of this document — verified still current.

### Building and running the backend Docker image directly (any Docker host, not just Railway)

```sh
docker build -t chatmate360-backend .
docker run -d --name chatmate360-api    -p 4000:4000 --env-file .env.production chatmate360-backend
docker run -d --name chatmate360-worker --env-file .env.production chatmate360-backend npm run worker:start
```

Same image, two containers — the `CMD` override on the second is what makes
it the worker instead of the API. The image is built on
`mcr.microsoft.com/playwright:v1.62.1-jammy` (Chromium + OS deps preinstalled)
so the worker's headless-browser crawl fallback
(`src/lib/crawler/renderPage.ts`) works out of the box — **the tag must stay
in sync with the `playwright` version in `package.json`** if that's ever
bumped, or the worker will fail to launch a browser.

No separate build step — both processes run the TypeScript source directly
via `tsx` (same as local dev), not a compiled `dist/`.

### Health checks

`GET /health` → `{ "ok": true, "service": "chatmate360-backend", "demo": "sandbox" }`.
Point your orchestrator's liveness/readiness probe at this. It doesn't check
DB/Redis connectivity — a real request will surface a `503` from
`requireDb` if the database is unreachable, which is a more meaningful
signal for readiness than pinging Postgres from the health route itself.

The API process handles `SIGTERM`/`SIGINT` (`src/index.ts`) — closes the
HTTP server, then Redis and the DB pool, before exiting. Matters for
zero-downtime deploys: without it, a rolling restart drops in-flight
requests and connections uncleanly instead of finishing them first.

### CI/CD

`.github/workflows/ci.yml` (backend) runs on every push/PR to `main`:

- **`test`** — real Postgres + Redis service containers, schema applied,
  then `npm run typecheck` and the full test suite (`tests/unit`,
  `tests/integration` — **123 tests as of this writing**, up from 85 at the
  time this section was first written — including SSRF/JWT-tampering/
  SQL-injection/CORS/rate-limiting checks against the real app via
  `supertest`, not mocks of our own code).
- **`security`** — `npm audit --omit=dev --audit-level=high` (blocking;
  zero findings against production dependencies — confirmed independently
  this same session via `npm audit --omit=dev`) plus a full non-blocking
  `npm audit` and `gitleaks` secret scanning.
- **`build`** — `docker build` on every run; on push to `main` only, also
  pushes to `ghcr.io/<owner>/chatmate360-backend:{sha,latest}` — an
  alternative to Railway's own build-from-Dockerfile if you'd rather pull a
  pre-built image on a different host later.
- `.github/workflows/codeql.yml` — separate weekly + on-push SAST scan.
- `.github/dependabot.yml` — weekly dependency-update PRs, both repos.

`Chatmate360-main`'s `.github/workflows/ci.yml` — see §2.4 above for what it
actually does (email-gated, builds with `pnpm`, deploys to Vercel via the
Vercel CLI, not git auto-deploy).

Running the backend suite locally needs a `chatmate360_test` Postgres
database (create once, apply `db/schema.sql`) and the same local Redis dev
already uses — see `.env.test.example`. `npm test` / `npm run test:coverage`.

### Not yet load-tested / worth revisiting before high traffic

- Rate limit defaults (public: 20/5 per minute; authenticated: 30/minute)
  are reasonable starting points, not numbers derived from real production
  traffic.
- The crawl worker's default concurrency (3) and page/timeout bounds
  (`src/lib/crawler/crawl.ts`) were sized for a bounded, cost-conscious
  crawl, not maximum throughput — revisit if crawl volume grows.
- WordPress/Shopify embed testing needs real store/site access this
  session doesn't have — verified against a real JS-rendered site
  (`zararportfolio.netlify.app`) end-to-end, and the embed panel already has
  WordPress/Shopify-specific paste instructions
  (`embed-panel.tsx`'s `PLATFORM_INSTRUCTIONS`), but the actual embed
  hasn't been paste-tested on a live WordPress or Shopify site.
- A genuine multi-hour/production-duration soak test — the most recent
  session-based soak tests (150 seconds, then ~28 minutes before an
  environment-level interruption) both showed a healthy plateau in memory
  and connection counts, but neither substitutes for real production-length
  monitoring (see `PRODUCTION_READINESS_REPORT.md` and
  `INDEPENDENT_VERIFICATION_REPORT.md` for the actual numbers).
