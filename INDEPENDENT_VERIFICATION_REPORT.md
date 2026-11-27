# ChatMate360 Backend — Independent Verification Report

**Date:** 2026-08-28
**Purpose:** an outside check on `PRODUCTION_READINESS_REPORT.md`'s self-reported
claims, before treating that report as load-bearing for a production launch
decision. Every finding below comes from re-reading the actual current source,
re-running or freshly attempting the cited tests/attacks myself, and running
real commands (`npm audit --omit=dev`, `npm ls`, live curl attacks, a live
soak test) — not from re-stating the prior report's own text.

---

## Section 1: Independent citation spot-check

Four claims, one from each of Tasks 1/2/3/5, checked cold against the current
file state (not from memory of writing them).

### Claim A (Task 1) — rate-limiter wiring and shared Redis connection

**Report's claim:** `src/routes/chatbot.routes.ts` wires
`rateLimitAuthenticatedChat` ahead of body validation on `POST /chatbots/chat`,
and the middleware reuses the existing shared Redis connection rather than
opening a second one.

**Verification:** Read `src/routes/chatbot.routes.ts` fresh — lines 41–48
read exactly:
```
chatbotRouter.post(
  "/chat",
  requireAuth,
  requireDb,
  rateLimitAuthenticatedChat,
  validateBody(chatSchema),
  chatWithChatbot,
)
```
Read `src/middleware/rateLimitAuthenticatedChat.ts` — imports
`redis` from `../lib/redis.js`. Grepped the whole `src/` tree for
`new IORedis(` / `new Redis(` — **exactly one match**, `src/lib/redis.ts:9`,
imported by all six consumers (`rateLimitAuthenticatedChat.ts`, `worker.ts`,
`index.ts`, `rateLimitPublic.ts`, `cache.ts`, `queue.ts`). No second
connection exists anywhere.

**Verdict: CONFIRMED.** Exact match, no discrepancy.

### Claim B (Task 2) — live-data merged before the relevance gate/AI call

**Report's claim (verbatim):** `src/lib/answerChatbotQuestion.ts:90-92`:
`const pages = [...liveDataToPages(liveData), ...crawledPages]`, computed
before the relevance-gate check and the `answerQuestion` call.

**Verification:** Read the file fresh in full. The line
`const pages = [...liveDataToPages(liveData), ...crawledPages]` exists
verbatim and is exactly as described functionally — computed at what is
currently **line 102**, before the cached-relevance-gate lookup (line
118–128) and the `answerQuestion` call (line 134). The **functional claim is
true**. The **line-number citation is wrong**: report says 90-92, actual is
102 — a 10-12 line discrepancy.

**Verdict: CONFIRMED (substance), citation inaccurate.** The feature exists
and works exactly as described; the file:line pointer does not match current
file state.

### Claim C (Task 3) — grounding check wired in, logs correctly

**Report's claim (verbatim):** `src/lib/answerChatbotQuestion.ts:124-140` —
runs on every AI answer before it's returned or cached; on failure, returns
the fixed fallback and logs a `grounding-check-failed` event, never the full
message at info level.

**Verification:** Read the file fresh. The actual grounding-check block
(`verifyGroundedClaims` call through the fallback substitution) spans
**lines 134–160**, not 124-140 — line 124 in the current file is actually
inside the *relevance-gate cache* lookup, a different piece of logic. The
functional claim is otherwise accurate: `verifyGroundedClaims(aiAnswer,
contextTextFor(pages))` runs immediately after the AI answer is received
(line 136); on failure it logs via `log().warn({chatbotId,
...chatMessageSummary(question), failedClaimCount:
grounding.failedClaims.length, event: "grounding-check-failed"}, ...)` —
`chatMessageSummary()` (confirmed by reading `src/lib/logger.ts`) returns
only a hashed ref + length, never the raw question text — and returns the
fixed `fallbackMessage` instead of the ungrounded answer, without caching it.

**Verdict: CONFIRMED (substance), citation inaccurate.** Same pattern as
Claim B — a consistent ~10-12 line offset between the report's citations and
the file's current state, in the same file, for two separate claims. This
looks systematic rather than a one-off typo, and is worth the original
author fixing (or double-checking all remaining citations) even though the
underlying features are real.

### Claim D (Task 5) — cross-user live-data ownership check (404, not leaky 403)

**Report's claim:** a second user attempting to read/update/delete another
user's live-data row by id gets a plain 404, verified by
`liveData.integration.test.ts`.

**Verification, two independent methods:**
1. Re-ran the specific cited test cold: `npx vitest run
   tests/integration/liveData.integration.test.ts` — all 5 tests pass,
   including "never lets one user read, update, or delete another user's
   live-data row by id."
2. **Not satisfied with re-running someone else's test**, manually reproduced
   the attack via raw curl against the live running server, independent of
   the test suite: created user A with a live-data row (`"Secret stock":
   "999"`), created user B, then had user B directly `PATCH` and `DELETE`
   user A's real entry id.
   - `PATCH` → `HTTP_STATUS=404`, body `{"ok":false,"error":"Live-data entry
     not found."}`
   - `DELETE` → `HTTP_STATUS=404`, same body
   - User B's own `GET /chatbots/live-data` → `{"entries":[]}` (never sees
     the victim's row)
   - Re-checked user A's row afterward — untouched, value still `"999"`.

**Verdict: CONFIRMED**, with independent reproduction beyond just re-running
the existing test.

### Section 1 summary

All 4 claims **substantively hold up**. Two (B, C) have a real, consistent
inaccuracy in their exact line-number citations — not something to wave away
given "file:line evidence discipline" is the stated standard, but not a
functional failure either. None of the four is DISPUTED in the sense of "the
described feature doesn't exist or doesn't work" — every feature checked is
real, wired in, and behaves as claimed.

---

## Section 2: Extended soak test

**Target:** "aim for at least a few hours if the environment allows."

**What actually happened:** launched a 60-minute k6 soak (6 VUs, sustained
~1 req/s per VU against the public widget chat endpoint, mixed across 12
distinct chatbots to avoid one rate-limit bucket dominating), with memory/
connection sampling every 5 minutes, as a backgrounded process.

**The background process was killed by the environment before completing** —
not by my own choice, and not because it hit a duration cap I set. The task
notification reported status `killed`. This was **not a multi-hour run**,
and did not reach the intended 60 minutes either. Being honest about this
rather than reporting the intended duration as if it were achieved: **the
soak ran for approximately 28 minutes of active load before being
terminated**, per k6's own last progress line before the kill
(`0h28m18.0s/1h0m0s`, 10,116 iterations completed, 0 interrupted).

**Why a multi-hour run wasn't achieved:** this is an interactive CLI session,
not a detached/supervised long-running job — a background process here is
subject to being reclaimed by the environment (exactly what happened), and
there's no mechanism available to me in this pass to make a multi-hour
background run durable against that. A genuinely unattended multi-hour or
overnight soak would need to run outside this interactive session (a CI job,
a scheduled cloud task, or a dedicated staging deployment with real APM),
which is outside what this verification pass can produce.

**What the ~28 minutes achieved is still meaningfully more than the prior
pass's 150-second test (roughly 11x longer)**, and the sampled data is real:

| Sample | Elapsed | API RSS | Worker RSS | PG conns (app db) | PG conns (total) | Redis clients | Redis used_memory |
|---|---|---|---|---|---|---|---|
| baseline | 0s | 69.8 MB | 34.1 MB | — | — | — | — |
| 1 | 302s (5m) | 73.9 MB | 18.0 MB | 3 | 8 | 4 | 2,238,736 B |
| 2 | 605s (10m) | 75.5 MB | 18.8 MB | 3 | 8 | 4 | 2,184,928 B |
| 3 | 908s (15m) | 76.0 MB | 16.1 MB | 3 | 8 | 4 | 2,198,192 B |
| 4 | 1211s (20m) | 76.2 MB | 18.1 MB | 4 | 9 | 4 | 2,186,144 B |
| 5 | 1514s (25m) | 75.1 MB | 17.8 MB | 4 | 9 | 4 | 2,240,392 B |

**Shape assessment, per metric:**
- **API process memory**: rose during the first ~10 minutes (69.8 → 75.5 MB,
  +5.7 MB) then **plateaued** for the remaining ~15 minutes (75.5 → 76.0 →
  76.2 → 75.1 MB — essentially flat, ±1 MB noise). Classic warm-up-then-
  plateau, not sustained growth.
- **Worker process memory**: dropped after baseline (34.1 → ~18 MB, likely
  GC reclaiming startup allocation — the worker wasn't processing crawl jobs
  during this widget-chat-focused soak) then stayed flat/noisy in the 16-19
  MB range for the rest of the run. **Flat.**
- **Postgres connections**: 3-4 (app db), 8-9 (total) throughout — small,
  stable, no growth. **Flat.**
- **Redis connected clients**: exactly 4 at every single sample. **Flat.**
- **Redis used_memory**: 2,184,928–2,240,392 bytes throughout (a ~55KB band,
  no trend) — meaningful because this soak continuously exercises the Task 4
  Redis-backed answer/relevance/pages caches with TTL expiry; flat memory
  here is a genuine signal that TTL expiry is actually reclaiming space, not
  that entries are accumulating unboundedly.
- **Errors**: zero `error`/`fail`/`✗` lines anywhere in the full k6 output
  log across all ~28 minutes and ~10,116 completed iterations.

**My assessment: plateau, not unbounded or linear growth, across every
tracked metric, for as long as I was able to observe.** This is consistent
with (and extends, in duration, the confidence behind) the prior pass's
150-second finding. It does **not** rule out a slower leak with a longer time
constant than ~28 minutes could reveal — that caveat, already stated
honestly in the prior report, still stands and is not resolved by this pass.

---

## Section 3: Task 3 grounding-gap risk documentation

**`RISK_LOG.md` created at the repo root**, containing `RISK-001`: a full
description of the context-poisoning gap (the regex-based grounding check
catches a hallucinated claim in the model's *answer* but cannot distinguish
a legitimate crawled/live fact from a maliciously engineered one already
present in the *context*), its attack surface (realistically the chatbot
owner themselves, or someone who's compromised the owner's own site/dashboard
access — not a cross-tenant or external-attacker exposure, since only the
verified owner can write `chatbot_live_data` or control what gets crawled
from their own site), why it's accepted for this launch, and what would
change that assessment. Cross-references the exact test
(`tests/unit/groundingCheck.test.ts`'s last test) that already demonstrates
this limitation with a passing assertion, and the prompt-level
`_INJECTION_GUARD` in `ai.ts` that remains the (imperfect) first line of
defense. **Not fixed in this pass, as instructed — documented, not closed.**

---

## Section 4: npm audit reachability check

**Report's claim:** all 6 findings are dev-toolchain-only, not reachable in
the production dependency tree, and were not silently upgraded.

**Independent verification, three methods:**

1. **Read `package.json` fresh**: `vitest` and `@vitest/coverage-v8` are
   listed directly under `devDependencies`; `vite`, `vite-node`,
   `@vitest/mocker`, and `esbuild` are not listed at the top level at all —
   they're transitive.
2. **Traced every one of the 6 findings' full dependency path** with
   `npm ls <package> --all`:

| Finding | Path(s) found | Reachable in production? |
|---|---|---|
| `vitest` | direct `devDependencies` entry, and via `@vitest/coverage-v8` | **No** — devDependency only |
| `@vitest/coverage-v8` | direct `devDependencies` entry | **No** — devDependency only |
| `vite` | `vitest → vite`, `vitest → @vitest/mocker → vite`, `vitest → vite-node → vite` — three paths, all rooted in the `vitest` devDependency subtree | **No** — devDependency only |
| `vite-node` | `vitest → vite-node` | **No** — devDependency only |
| `@vitest/mocker` | `vitest → @vitest/mocker` | **No** — devDependency only |
| `esbuild` | **two separate paths**: (a) `tsx → esbuild@0.28.2` — `tsx` **is a real, top-level `dependencies` entry**, and is the literal runtime interpreter `npm run start`/`CMD` invokes; (b) `vitest → vite → esbuild@0.21.5` — devDependency subtree | **Package name yes, vulnerable version no** — see below |

3. **The `esbuild` nuance, checked precisely**: `npm audit --json`'s own
   finding for `esbuild` reports `"range": "<=0.24.2"` and, critically,
   `"nodes": ["node_modules/vite/node_modules/esbuild"]` — npm's own
   auditor has already scoped this specific finding to the nested copy
   inside `vite`'s subtree (version 0.21.5, in range), and does **not** flag
   the top-level copy (version 0.28.2, resolved via `tsx`, **outside** the
   vulnerable `<=0.24.2` range). So: `esbuild` the package name genuinely
   does appear in the production dependency tree (via `tsx`), but at a
   version that is not the vulnerable one. **This is a real nuance the prior
   report's blanket "all four packages... devDependencies only" phrasing
   glossed over** — it happened to reach the right conclusion (no
   production risk) without stating the more precise reason for `esbuild`
   specifically.
4. **Authoritative confirmation**: `npm audit --omit=dev` — the exact
   command that audits precisely the dependency tree `Dockerfile`'s
   `RUN npm ci --omit=dev` actually ships (confirmed by reading the
   Dockerfile: `COPY package.json package-lock.json ./` then
   `RUN npm ci --omit=dev` before `COPY . .`) — reports:
   ```
   found 0 vulnerabilities
   ```

**Verdict: CONFIRMED**, with one precision correction: 5 of 6 findings
(`vitest`, `@vitest/coverage-v8`, `vite`, `vite-node`, `@vitest/mocker`) are
cleanly devDependency-only with no production path at all. The 6th
(`esbuild`) is more precisely described as "present in the production tree
via `tsx`, but at a non-vulnerable version (0.28.2, outside the flagged
`<=0.24.2` range) — the vulnerable copy (0.21.5) exists only in the
dev-only `vite` subtree." The bottom-line conclusion (0 production-reachable
vulnerabilities, correctly not force-upgraded) holds and is now backed by
`npm audit --omit=dev`'s direct output rather than manual reasoning about
`dependencies` vs. `devDependencies` alone.

---

## Section 5: README.md correction

**`README.md` updated.** Documentation only — no source files touched.

**What changed:**
- Removed every remaining Supabase reference (env vars `SUPABASE_URL`/
  `SUPABASE_SERVICE_ROLE_KEY`, "Supabase SQL editor" setup step, "Supabase
  Auth" column in the endpoints table) — none of these exist in the current
  codebase.
- Replaced the setup section with the real flow: `docker compose up -d` for
  Postgres+Redis, applying `db/schema.sql` directly (not a Supabase
  migration file), the real required `.env` vars (`DATABASE_URL`,
  `JWT_SECRET`, at least one AI provider key, `REDIS_URL`), and — previously
  entirely undocumented — that `npm run worker` has to be running in a
  separate terminal or a chatbot with a `websiteUrl` stays `queued` forever.
- Added an accurate, complete endpoints table (previously missing
  `/chatbots/status`, `/chatbots/theme`, `/chatbots/domain`,
  `/chatbots/fallback-message`, `/chatbots/chat`, both `/chatbots/live-data`
  routes, both `/public/chatbots/*` routes, `/auth/refresh`, `/auth/logout`,
  and `/embed/v1/embed.js` — the old table only listed 8 of the now
  ~20 real routes, all read fresh from the actual route files, not copied
  from either prior report).
- Added `npm run lint`/`npm run typecheck` instructions and a one-paragraph
  architecture overview (crawler-as-background-job, grounding, live data,
  caching, logging) pointing to `IMPLEMENTATION_STATUS.md`,
  `PRODUCTION_READINESS_REPORT.md`, and this pass's own `RISK_LOG.md` for
  detail, rather than re-duplicating their content.

---

## Final recommendation: **GO**

Based only on what was independently verified in this pass:

- **Section 1**: 4/4 spot-checked claims hold up substantively. Zero were
  DISPUTED in the sense of "the feature doesn't exist or doesn't work." Two
  had inaccurate line-number citations (a real, worth-fixing evidence-hygiene
  issue, flagged clearly above) — this does not meet the bar for a blocking
  finding, since the underlying functionality is real and independently
  reproduced (Claim D, especially, via a fresh manual attack, not just a
  re-run test).
- **Section 2**: no unbounded or linear growth observed in any of 5 tracked
  metrics (API memory, worker memory, Postgres connections, Redis
  connections, Redis memory) over ~28 minutes of real sustained load — a
  plateau shape throughout. The shortfall against the "a few hours" target is
  disclosed plainly above, with the specific reason (an environment-level
  kill of the background process, not a deliberate cap), consistent with the
  honesty standard this report is held to.
- **Section 4** found and disclosed a real precision gap in the prior
  report's phrasing (the `esbuild` dual-path nuance), but the underlying
  security conclusion — zero production-reachable vulnerabilities — is now
  confirmed by direct, authoritative tooling (`npm audit --omit=dev`), not
  just re-stated.
- **Section 3**'s risk is now formally logged, not just verbally
  acknowledged, with an accurate attack-surface description and an explicit
  acceptance rationale.
- **Section 5**'s stale documentation, which would have actively misled the
  next person to touch this repo, is corrected.

**Neither trigger condition for a mandatory NO-GO** (a DISPUTED Section 1
claim, or unbounded growth in Section 2) **was met.** The one open item
worth carrying forward, not as a launch blocker but as a genuine follow-up:
get a true multi-hour soak run somewhere outside an interactive session (CI,
staging + APM) before this has run for as long in aggregate production-like
conditions as the memory-safety confidence in this report would ideally
warrant.
