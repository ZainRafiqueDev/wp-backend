# Deploy checklist — Phase 1-3 (document limits, attachments, team members)

Covers the production rollout of: Phase 1 (Crawl Plus document-count/size caps,
`file_hash`), Phase 2 (`workspace_members`/invitations/audit log), Phase 3
(managed chat attachments). Written against this repo's existing production
topology (Neon Postgres, Upstash Redis, Railway API + worker, Vercel frontend
— see `DEPLOYMENT.md`), not a new one.

---

## 1. Before deploy

### 1.1 Backup

**Check `pg_dump`'s version against Neon's server version first** — an
older `pg_dump` than the server it's dumping from is a real, silent-failure
risk (it can skip newer catalog objects/options it doesn't know about
without always erroring loudly):

```sh
local_major=$(pg_dump --version | grep -oE '[0-9]+' | head -n1)
server_major=$(psql "$DATABASE_URL" -t -A -c "select current_setting('server_version_num')::int / 10000;" | tr -d '[:space:]')
echo "pg_dump major: $local_major, Neon server major: $server_major"
if [ "$local_major" -lt "$server_major" ]; then
  echo "pg_dump ($local_major) is older than the Neon server ($server_major) — upgrade pg_dump before trusting this backup." >&2
  exit 1
fi
```

Only then:

```sh
pg_dump "$DATABASE_URL" -Fc -f "chatmate360-$(date +%Y%m%dT%H%M%S).dump"
```

`-Fc` (custom format) is required for the check below and for a realistic
restore later (`pg_restore -d <target> file.dump`), not just a flat SQL text
dump.

**Check it isn't empty** — don't trust a non-zero exit code alone:

```sh
pg_restore -l "chatmate360-<timestamp>.dump" | grep -c "TABLE DATA"
```

Should return close to 60 (the current table count — confirmed in Task 1b).
A number near 0 means the dump connected but read nothing (wrong database,
wrong user, or an RLS policy silently filtering rows under a non-superuser
role) — don't proceed on a backup you haven't checked this way.

### 1.2 Production over-limit query — run this FIRST

Finds every Crawl Plus chatbot already over any of the three limits this
deploy will start enforcing (>6 non-failed documents, any single
non-failed file >16MB, or a per-chatbot non-failed total >50MB — all three
read straight from `plans.ts`'s `crawl_plus.documentIngestion` config, not
guessed). Matches this codebase's own entitlement definition exactly
(`active`/`trialing` subscriptions only — `billing.service.ts`'s
`isEntitledStatus`, not every row ever inserted into `subscriptions`):

```sql
select
  c.id as chatbot_id,
  c.user_id as owner_user_id,
  count(*) filter (where d.status <> 'failed')     as doc_count,
  max(d.file_size) filter (where d.status <> 'failed') as max_file_bytes,
  sum(d.file_size) filter (where d.status <> 'failed') as total_chatbot_bytes
from chatbots c
join subscriptions s
  on s.user_id = c.user_id
 and s.plan = 'crawl_plus'
 and s.status in ('active', 'trialing')
join chatbot_documents d
  on d.chatbot_id = c.id
group by c.id, c.user_id
having count(*) filter (where d.status <> 'failed') > 6
    or max(d.file_size) filter (where d.status <> 'failed') > 16 * 1024 * 1024
    or sum(d.file_size) filter (where d.status <> 'failed') > 50 * 1024 * 1024
order by doc_count desc;
```

Any row returned here is a tenant whose dashboard will show "over limit" the
moment this deploy lands — they aren't blocked from using *existing*
documents, but can't add more until they're under the cap. Decide in advance
whether that's communicated to them before or after deploy; the code makes
no distinction between "always was over" and "went over at deploy time."

### 1.3 New environment variables (Phases 1-3)

None of the limit variables below are new *requirements* — every one has a
code-level default (`src/env.ts`) and the app boots fine without them. They're
listed because they're **not yet in `.env.example`** (verified: grepped for
each, zero matches), so a deploy that doesn't set them isn't broken, but
nobody deploying it can discover or override the defaults without reading
`src/env.ts` directly. Add them to `.env.example` as part of this rollout if that
matters to you.

| Variable | Default if unset | What happens if missing |
|---|---|---|
| `CRAWL_PLUS_DOC_MAX_DOCUMENTS` | `6` | Crawl Plus doc cap silently uses 6. Harmless, just undiscoverable. |
| `CRAWL_PLUS_DOC_MAX_FILE_BYTES` | `16777216` (16MB) | Same — silently uses 16MB. |
| `CRAWL_PLUS_DOC_MAX_CHATBOT_BYTES` | `52428800` (50MB) | Same. |
| `CRAWL_PLUS_ATTACHMENT_MAX_FILE_BYTES` | `10485760` (10MB) | Same, for Phase 3 attachments. |
| `CRAWL_PLUS_ATTACHMENT_MAX_FILES_PER_MESSAGE` | `3` | Same. |
| `CRAWL_PLUS_ATTACHMENT_RETENTION_DAYS` | `30` | Same — attachments expire after 30 days regardless. |
| `CRAWL_PLUS_ATTACHMENT_TOTAL_BYTES` | `209715200` (200MB) | Same — per-account storage pool cap. |
| `FULL_CUSTOM_ATTACHMENT_MAX_FILE_BYTES` / `_MAX_FILES_PER_MESSAGE` / `_RETENTION_DAYS` / `_TOTAL_BYTES` | `20MB` / `3` / `30` / `500MB` | Same, Full Custom tier. |
| `ATTACHMENT_MAX_PER_IP_PER_DAY` | `20` | Same — per-IP daily upload cap. |
| `ATTACHMENT_RETENTION_INTERVAL_MS` | `3600000` (**1 hour**, not nightly) | The retention+recompute job just runs hourly instead of whatever cadence you assumed. Not harmful, but worth knowing: this is NOT currently a nightly job despite that being the natural description of what it does (see §3). |
| `DOCUMENT_STORAGE_DRIVER` | `fs` | **Now a boot-time hard stop, not just a risk note.** `assertProductionGuards()` (`src/env.ts`, called at startup by both `src/index.ts` and `src/worker.ts`) refuses to start when `NODE_ENV=production` and this is still `fs`, unless `ALLOW_UNSAFE_PROD_DEFAULTS=true` is also set (see below) — fixed in this pass, see §7.1. Before that fix, the only consequence was silent: documents AND attachments writing to local disk (`DOCUMENT_STORAGE_DIR`, default `var/document-storage`) inside the API container, lost on every redeploy/restart. **Must be explicitly set to `s3` in production**, with a real bucket. |
| `DOCUMENT_STORAGE_BUCKET` / `_REGION` / `_ENDPOINT` / `_ACCESS_KEY` / `_SECRET_KEY` | unset / `us-east-1` / unset / unset / unset | If `DOCUMENT_STORAGE_DRIVER=s3` but `DOCUMENT_STORAGE_BUCKET` is empty, every upload fails loudly with a `503` (`objectStorage.ts:46`) rather than silently writing to local disk — safer failure mode than the driver default above, but still a full outage for uploads until fixed. |
| `DOCUMENT_SCAN_VENDOR` | `mock` | **Now a boot-time hard stop, not just a risk note.** Same `assertProductionGuards()` guard as above refuses to start when this is still `mock` in production. `ALLOW_UNSAFE_PROD_DEFAULTS` no longer covers this; only the dedicated `ALLOW_MOCK_MALWARE_SCAN_IN_PRODUCTION=true` does (never set it where real customers upload files) — fixed in this pass, see §7.1. Before that fix: the mock scanner only catches the EICAR test string, not real malware, and the fail-closed guarantee (§4) only protects against the scanner *erroring*, not against it *wrongly saying "clean."* **Must be explicitly set to `clamav`** with a real `clamd` reachable at `DOCUMENT_SCAN_CLAMD_HOST`/`_PORT`. |
| `ALLOW_UNSAFE_PROD_DEFAULTS` | `false` | New in this pass (§7.1). Leave `false`/unset in real production. The only legitimate reason to set it `true` is a deliberately ephemeral "production" (e.g. a demo environment that sets `NODE_ENV=production` for other reasons) that genuinely wants local-disk storage. Setting it `true` on real production silently brings back the local-disk risk above. It does not enable the mock scanner; that needs the separate `ALLOW_MOCK_MALWARE_SCAN_IN_PRODUCTION=true`. |
| `ALLOW_MOCK_MALWARE_SCAN_IN_PRODUCTION` | `false` | Scanner-only opt-out, split from `ALLOW_UNSAFE_PROD_DEFAULTS` so relaxing storage can never also switch off malware scanning. Leave `false` in real production. |
| `RESEND_API_KEY` | unset | Every email (verification, password reset, **team-member invitations**) is logged to the server console instead of sent (`lib/email.ts:12-18`). No boot-time guard prevents this in production. If this is unset, the §5 "invite a member, receive the real email" smoke test will fail by design — set this before running that step, not after. |
| `CRAWL_PLUS_PLAN_MAX_SEATS` | `4` (raised from `3` this pass) | Seats include the owner (`workspaceMembers.service.ts`'s `1 + members + pendingInvites` check) — `4` means owner + 3 invites, not owner + 4. Silently uses `4` if unset; harmless, just undiscoverable like the limit vars above. |
| `FULL_CUSTOM_PLAN_MAX_SEATS` | `11` (raised from `10` this pass) | Same reasoning — owner + 10 invites. Silently uses `11` if unset. |

Two more, already in `.env.example` (not new to this deploy, but their *values* changed this pass — flagging so a deploy that still has an old explicit override in its real environment doesn't silently miss the increase):

| Variable | New default | Old default | Note |
|---|---|---|---|
| `DOCUMENT_MAX_FILE_BYTES` | `20971520` (20MB) | `15728640` (15MB) | Full Custom's per-file cap — raised because it was *lower* than Crawl Plus's 16MB despite being the higher tier. If your real production environment has an explicit `DOCUMENT_MAX_FILE_BYTES=15728640` (or any value) set, this new code default won't apply until that's removed or updated — same as any other env var. |
| `DOCUMENT_MAX_CHATBOT_BYTES` | `524288000` (500MB = 25×20MB) | `393216000` (375MB = 25×15MB) | Scaled alongside the file-cap raise to preserve the invariant documented in `src/env.ts`'s own comment ("so a tenant already using the published file cap is not newly blocked") — not independently requested, a judgment call to keep that invariant true. |

---

## 2. Migrations

### Order — and the dependency question

The three new/changed migration files are applied in this exact order,
**hardcoded into `db/schema.sql` itself** (`schema.sql:905-914`), not
alphabetical and not left to whoever runs them:

```
20260929_semantic_chunking.sql       (pre-existing, unrelated)
20261026_crawl_plus_doc_limits.sql   (Phase 1)
20261027_workspace_members.sql       (Phase 2)   <- runs BEFORE chat_attachments
20261027_chat_attachments.sql        (Phase 3)
rls.sql
20260930_phase4_hardening.sql
add_okf_tables.sql
```

So the concern in the ask — "they run alphabetically, does chat_attachments
depend on the workspace tables?" — doesn't actually apply two ways:

1. **They don't run alphabetically.** `workspace_members` runs before
   `chat_attachments` already, by explicit `\ir` order in `schema.sql`, regardless
   of filename sort order.
2. **It wouldn't matter if they did.** Read `20261027_chat_attachments.sql` in
   full: its only foreign keys are to `chatbots`, `conversations`,
   `customer_identities`, `chatbot_bookly_appointments`, and `users`. Zero
   references to `workspace_members`/`workspace_invitations`/`workspace_audit_log`.
   No rename needed.

### The actual production command

This repo's established pattern (`DEPLOYMENT.md` §2.1) is **not** to apply
individual migration files by hand — it's to re-run the single idempotent
`db/schema.sql` against production, exactly as on first bootstrap:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f db/schema.sql
```

`--single-transaction` (new in this pass) wraps the *entire* script —
including everything it `\ir`'s — in one transaction, so a failure partway
through (any phase) rolls back cleanly instead of leaving the schema in a
half-migrated state. Verified this doesn't conflict with anything in the
`\ir` chain: the one `CREATE INDEX CONCURRENTLY` in this repo
(`db/migrations/20260927_pgvector_hnsw.sql`, which cannot run inside a
transaction block at all) is deliberately **not** `\ir`'d by `schema.sql` —
confirmed by grepping `db/` for `CONCURRENTLY`, it only appears in that one
file and in two comments inside `schema.sql` referring to it.

**Idempotency re-verified for real, not just asserted** — ran
`psql -v ON_ERROR_STOP=1 --single-transaction -f db/schema.sql` **twice in a
row** against the same fresh, empty throwaway database (local Docker,
removed after): first run exit 0, zero errors; second run exit 0, zero
errors; final table count unchanged at 60 both times. This covers
everything `\ir`'d — `rls.sql`'s policies, `20260930_phase4_hardening.sql`,
and `add_okf_tables.sql` included, not just the three Phase 1-3 files. No
non-idempotent statement was found, so nothing needed fixing.

**Run it on a Neon branch first, always** — before touching production
directly:
1. Create a branch of the production database in the Neon console, or via
   the CLI (`neonctl` via npm/Homebrew, or the newer `neon` package — check
   which one you have with `neonctl --version`/`neon --version`):
   `neonctl branches create --name pre-deploy-check --parent production --project-id <your-project-id>`.
   This is a real, separate Postgres instance with production's actual
   data, not a dry run against empty tables.
2. Run the exact command above against the branch's connection string.
3. Run §2's three verification queries (below) against the branch.
4. Only once that's clean, run the same command against the real
   `$DATABASE_URL` for production.

This is the one step in this whole checklist that most needs a real branch
rather than a throwaway empty container: the idempotency test above proves
the script doesn't error on a second run, but it can't prove anything about
how it behaves against production's actual data/row counts/constraint
violations that don't exist in a fresh database — only a branch of the real
thing can.

Every `create table`/`alter table ... add column` in it is already
`if not exists`-guarded, so this is safe to run against an existing
production database that already has the pre-Phase-1 schema — it will only
create what's missing.

**Check it applied** — one query per phase:

```sql
-- Phase 1: file_hash column exists
select column_name from information_schema.columns
 where table_name = 'chatbot_documents' and column_name = 'file_hash';

-- Phase 2: workspace tables exist
select table_name from information_schema.tables
 where table_name in ('workspace_members', 'workspace_invitations', 'workspace_audit_log');

-- Phase 3: attachment tables exist
select table_name from information_schema.tables
 where table_name in ('chatbot_attachments', 'attachment_storage_usage');
```

Each should return the listed rows; zero rows means that phase's migration
didn't apply — check `psql`'s own output for the actual error before retrying.

---

## 3. Deploy order

1. **Migrations** (§2) — against Neon, before touching either service.
2. **Backend API + worker** (Railway, both services, same image/commit).
3. **Frontend** (Vercel).

This matches `DEPLOYMENT.md`'s existing "DB/Redis must exist before the
backend's first boot" ordering — nothing phase-specific changes it.

**Worker registration — confirmed, not assumed:**
`src/worker.ts:293` calls `ensureAttachmentRetentionSchedulerRegistered()` at
module load (so it runs on every worker boot, not conditionally), which
registers a single repeating BullMQ job named `attachment-retention-tick`
(`src/lib/queue.ts:133-143`, `repeat: { every: env.attachmentRetentionIntervalMs }`
— the 1-hour-default interval from §1.3). That one job does both things: it
deletes expired attachments AND recomputes `attachment_storage_usage.bytes_used`
from `chatbot_attachments` (the source of truth) for every account, in the same
tick (`chatAttachments.service.ts:304-336`) — there is no separate "nightly
recompute" job to register; it's the same job, just not actually nightly at
the current default.

After deploying the worker, confirm the job registered for real (not just
that the code typechecks) — same method this repo's own `IMPLEMENTATION_STATUS.md`
used for the recrawl scheduler:

```sh
redis-cli -u "$REDIS_URL" KEYS "bull:crawl-queue:repeat:*"
```

Should include a key referencing `attachment-retention-scheduler`.

---

## 4. Malware scanner in production

**This is the single highest-risk item in this rollout.** Attachments are
fail-closed by design (`malwareScan.service.ts:147-153`, `documentScanIsFailClosed()`
forces `true` whenever `NODE_ENV=production` regardless of any env override) —
but fail-closed only protects against the scanner *erroring*. It does nothing
if the configured "scanner" is the mock vendor, which doesn't error — it just
says "clean" to everything except the literal EICAR test string
(`malwareScan.service.ts:58-73`). **As of §7.1, `assertProductionGuards()`
now refuses to boot in production with `DOCUMENT_SCAN_VENDOR` left at `mock`**
(same guard as the storage-driver one above), unless
`ALLOW_UNSAFE_PROD_DEFAULTS=true` — so a bare "forgot to set it" deploy now
fails loudly at startup instead of silently running an ineffective scanner.

**Does ClamAV run in production via this repo's `docker-compose.yml`?
Still no — and it can't, by what this file is.** `docker-compose.yml` is a
*local-dev* file: it brings up Postgres/Redis/pgbouncer for `npm run dev` to
talk to. Production on Railway doesn't use this file at all — Railway
builds straight from the `Dockerfile` and runs services configured by hand
in its dashboard (`DEPLOYMENT.md` §2.3; there's no `railway.json`/`.toml`
either). As of §7.4, this file now has a real `clamav` service — that
closes the *local-dev* gap (you can run a genuine scanner locally with
`docker compose up -d clamav` instead of only ever getting the mock vendor),
but it does **not** stand up anything in production. A production `clamd`
is still a separate, manual provisioning step: a second Railway service
running the same `clamav/clamav` image, or an external managed
INSTREAM-compatible scanner — pointed at by `DOCUMENT_SCAN_CLAMD_HOST`/
`_PORT` exactly as locally. See §7.4 for the image, memory requirement, and
the pre-deploy check either way.

Existing house documentation for the document-ingestion side of this same
scanner is `docs/MALWARE_SCAN.md` — read it too; this section only adds the
Phase 3 (chat-attachment) angle, since attachments share the exact same
`scanDocumentBytes()` call (`chatAttachments.service.ts:14,232`).

**Before go-live:**
1. A real `clamd` (or equivalent INSTREAM-compatible scanner) is running and
   reachable from the backend/worker's network.
2. `DOCUMENT_SCAN_VENDOR=clamav` is set in production — not left at the
   `.env.example` default of `mock`.
3. `DOCUMENT_SCAN_CLAMD_HOST` / `DOCUMENT_SCAN_CLAMD_PORT` point at it.

**Check it's actually running** (confirms real `clamav`, not the mock,
actually denies a real malicious signature):

```sh
curl -s -X POST "https://<api-domain>/public/chatbots/<a-real-crawl-plus-chatbotId>/attachments" \
  -H "X-Widget-Origin: https://<that-chatbot's-allowed-domain>" \
  -F "sessionId=scan-check-$(date +%s)" \
  -F "file=@eicar.txt"
```

Where `eicar.txt` contains the EICAR test string
(`X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*` — see
`malwareScan.service.ts:8-9`, harmless, never execute it as a file). Expect
`409` with `{"code":"ATTACHMENT_DENIED"}`. **This alone does not prove
`clamav` is configured** — the mock vendor denies this exact string too. The
real proof is checking the scanner vendor was actually invoked: look for a
`document malware scan failed`/`clean`/`denied` log line and confirm its
`vendor` field reads `"clamav"`, not `"mock"` — or just directly confirm the
env var in the running service's dashboard before testing at all.

---

## 5. Smoke tests after deploy

| # | Steps | Pass condition |
|---|---|---|
| 1 | Invite a member on a workspace-eligible plan, receive the real email (requires `RESEND_API_KEY` set — §1.3), accept the invite, log in as that member. | Email actually arrives (not just logged server-side). Billing nav item is hidden for the new member. The member, if invited as Viewer, gets `403`/a disabled control attempting `POST /chatbots`. |
| 2 | On a Crawl Plus chatbot already at 6 documents, upload a 7th. Separately, upload a file of exactly 16MB + 1 byte. | 7th document: `409` with a doc-limit-reached code. Oversized file: `413`. |
| 3 | From the live embedded widget (not a direct API call), upload a file. | Widget shows the fixed acknowledgement in the chat UI. The file appears on the dashboard's Attachments page for that chatbot. Downloading it from there returns the original bytes with `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`. |
| 4 | In the same conversation as #3, ask "what's in my file?". | The bot's reply never claims to have read, viewed, or opened the file (this is enforced by `answerChatbotQuestion.ts`'s `buildAttachmentNoticePages` — see the backend's `chatAttachments.integration.test.ts` for the exact phrasing this guards against). |

---

## 6. Rollback

All three phases are purely additive at the schema level — new tables, and
exactly one new nullable-default column (`chatbot_documents.file_hash`,
`add column if not exists`, Phase 1). Nothing was renamed or dropped. That
means:

- **Code rollback** (redeploy the previous backend/worker image and the
  previous frontend build) is sufficient on its own. Older code simply never
  reads the new tables/column — it doesn't need them gone to run correctly.
- **No migration needs to be reverted** to roll back the code. All of them —
  `20261026_crawl_plus_doc_limits.sql`, `20261027_workspace_members.sql`,
  `20261027_chat_attachments.sql` — are safe to leave in place permanently,
  whether or not the feature code is rolled back.
- **If you specifically want the new tables gone** (e.g. tearing down a
  rejected pilot entirely, not a routine rollback), the destructive version
  per phase is:
  ```sql
  -- Phase 1 (optional — harmless to leave; only do this if you really want it gone)
  alter table chatbot_documents drop column if exists file_hash;
  -- Phase 2
  drop table if exists workspace_audit_log, workspace_invitations, workspace_members;
  -- Phase 3
  drop table if exists attachment_storage_usage, chatbot_attachments;
  ```
  Run Phase 3's drop before Phase 2's if you ever do both — `chatbot_attachments`
  has no FK into the workspace tables (confirmed above) so order doesn't
  actually matter here, but Phase 2's tables have no dependents at all, so
  this ordering note is mostly moot; included for completeness, not because
  it's load-bearing.
- Do **not** drop `chatbot_attachments`/`attachment_storage_usage` while any
  stored objects still exist in `DOCUMENT_STORAGE_BUCKET` under
  `tenant/*/attachments/*` — that would orphan real files in the bucket with
  no DB row pointing at them (nothing automatically garbage-collects by
  storage key alone). Not a concern for a routine code-only rollback, only
  for the destructive table-drop path above.

---

## 7. Redis-outage hardening (added in this follow-up pass)

Three findings from the original audit are now fixed, each with a test.
None of these are Phase 1-3 specific — they're general infra-resilience
fixes this rollout surfaced.

### 7.1 Boot-time guard on the two unsafe production defaults

`assertProductionGuards()` (`src/env.ts`) now throws at startup — before the
process ever accepts a request — when `NODE_ENV=production` and either
`DOCUMENT_STORAGE_DRIVER=fs` or `DOCUMENT_SCAN_VENDOR=mock` is left at its
default, unless `ALLOW_UNSAFE_PROD_DEFAULTS=true` is explicitly set (see §1.3
and §4). `DOCUMENT_SCAN_SKIP=true` in production is still always blocked,
with no opt-out, regardless of `ALLOW_UNSAFE_PROD_DEFAULTS`.

Tests: `tests/unit/assertProductionGuards.test.ts` (6 cases — each unsafe
default alone, both together, the opt-out, outside production, and the
pre-existing `DOCUMENT_SCAN_SKIP` guard staying absolute).

### 7.2 Cost-cap enforcement during a Redis outage — verified, not changed

Audited `reserveModelCostSlot` and the platform/account/tenant budget
ceilings it checks (`usage.service.ts`) for what happens when Redis times
out or is unreachable. **Already correct, no code change needed:**

- The atomic reserve is one Lua `eval` against Redis with no non-Redis
  success path. A Redis failure there throws, caught by
  `reserveModelCostSlot`'s outer `catch` (logged as `"usage reservation
  failed closed"`), which denies the reservation — never falls through to
  an uncapped admit.
- `getModelPeriodCostUsd`/`getCostCapBlock` (used for the user-facing
  "you've hit your cap" message after a denial) already fall back to a
  real Postgres-computed total on a Redis read failure, rather than
  guessing or erroring.
- Net effect of a Redis outage on cost enforcement: AI answers stop being
  generated (reservations fail closed) and chatbots degrade to the
  keyword-fallback answer — never silent uncapped spend, and never a false
  "credits exhausted" message to visitors (since the Postgres fallback
  usually still reports accurately that they're not actually over cap).

Test added: `tests/integration/usageReservation.integration.test.ts`'s new
"Redis down during reservation" case — mocks `cacheRedis.eval` to reject
(the same failure shape a real Redis outage produces to this code) and
confirms the reservation is denied and zero cost is ever recorded.

### 7.3 Rate limiters: one shared fail-open helper + in-memory fallback for two of them

All five rate-limiter files (`rateLimitAdminLogin.ts`,
`rateLimitAuthenticatedChat.ts`, `rateLimitPublic.ts`,
`rateLimitPublicAttachment.ts`, `rateLimitAuthFlows.ts`) now funnel through
one shared `consumeOrFailOpen` (`src/middleware/rateLimitShared.ts`) instead
of each duplicating the same `msBeforeNext` check inline. All five fail open
on a genuine Redis/infra error (never 429 a user for an outage that isn't
their fault) and fail closed (429) on a real quota breach.

`rateLimitAdminLogin.ts` and `rateLimitPublicAttachment.ts` additionally
configure `rate-limiter-flexible`'s own `insuranceLimiter` option — an
in-memory `RateLimiterMemory` with the same points/duration — so a Redis
outage degrades to a real (if per-process, not shared across instances, and
reset on restart) cap instead of no cap at all, for the two limiters judged
highest-value to keep capped even during an outage (brute-force login
attempts; storage/malware-scan cost per attachment upload). The other three
limiters were deliberately left fail-open-with-no-fallback, matching this
codebase's existing documented preference (see `src/middleware/README.md`)
for availability over a perfectly-enforced limit during an infra failure.

Tests: `tests/unit/rateLimitFailOpen.test.ts` (extended to all 5 limiter
files, 16 cases) proves the middleware-level funnel; a new
`tests/unit/rateLimitInsuranceLimiter.test.ts` (3 cases) proves the
`insuranceLimiter` fallback actually engages against a real
`RateLimiterRedis` instance with a broken `storeClient` — not just a mocked
`.consume()`, which would bypass the library's own fallback logic entirely.

Docs corrected to match: `src/middleware/README.md`'s "Rate limiting"
section rewritten (it previously described the pre-fix fail-closed
behavior as current); `IMPLEMENTATION_STATUS.md`'s §9 entry left in place
as a historical record with a correction note appended, rather than
deleted or silently rewritten.

### 7.4 A real ClamAV service, for local dev — and what to check before production

**This scanner is required for documents too, not only attachments** — easy
to miss since most of this section talks about attachments. Both share the
exact same `scanDocumentBytes()` call (`malwareScan.service.ts`,
confirmed from `chatAttachments.service.ts:14,232` AND
`documentIngestion.service.ts:30-31,374`) and the exact same
`DOCUMENT_SCAN_VENDOR`/`DOCUMENT_SCAN_CLAMD_HOST`/`_PORT` config — there is
no separate scanner or config for documents. Everything in this section
(the compose service, the Railway setup below, the memory requirement)
covers both.

`docker-compose.yml` now has a `clamav` service (`clamav/clamav:1.4_base`,
pinned to a feature release per the official docs, not `latest`), with:
- A persistent volume (`clamav-data:/var/lib/clamav`) for the signature
  database — required with the `_base` tag, since that tag ships with no
  database baked in and expects `freshclam` to build one into whatever's
  mounted there on first start.
- `CLAMAV_NO_FRESHCLAMD: "false"` (freshclam updates enabled — this is
  already the image's own default; set explicitly so it's visible here).
- A `healthcheck` using the image's own bundled `clamdcheck.sh`, which only
  passes once clamd is running AND the signature database is actually
  loaded — a 300s `start_period` because first boot (fresh volume) takes
  several minutes to freshclam the full database before clamd can start at
  all.

**Memory requirement: 3 GiB minimum, 4 GiB preferred** (per
docs.clamav.net — the signature database loads entirely into memory; the
docs explicitly call out that 2 GiB is insufficient). Undersized hosts get
an OOM-killed container (exit 137), not a graceful degradation. **This is a
real pre-deploy check, not a formality** — confirm whatever host runs this
(a local dev machine, a Railway service, or wherever production's `clamd`
ends up) actually has 3-4 GiB free for it specifically, on top of
everything else already running there. (Found the hard way while writing
this section: this machine had 0.6 GiB free out of 15.4 GiB total at the
time, which is why the service was validated with `docker compose config`
but deliberately NOT started here — starting it would likely have
OOM-killed itself and destabilized the already-running Postgres/Redis
containers this repo's own tests depend on. Check your own host's free
memory the same way before running `docker compose up -d clamav` for real.)

**Researched: does `ConcurrentDatabaseReload no` let clamd run reliably in
3 GiB? Partially — it removes a real spike risk, but it does not lower the
documented 3 GiB floor itself, and it's not added to the compose service
here.** `clamd.conf`'s `ConcurrentDatabaseReload` defaults to `yes`, which
does a non-blocking reload on every signature update (scans keep running
during the reload) by briefly keeping both the old and new signature
database in memory at once — community reports (e.g. a documented
"ClamAV out of memory daily at 3AM" case, matching a scheduled freshclam
reload window) tie this specific spike to real OOM kills on hosts sized
right at the 3-4 GiB range. Setting it to `no` makes the reload blocking
instead (scans pause for its duration) and avoids ever holding two copies
at once — a real fix for *that* failure mode specifically. docs.clamav.net
itself says nothing about this setting changing its stated 3 GiB
minimum/4 GiB preferred baseline, and I found no source claiming it lowers
that floor — so the honest framing is "removes a spike that can push you
*above* 3-4 GiB momentarily," not "makes 3 GiB itself unnecessary."

**Not added to `docker-compose.yml` or the Railway steps below, and here's
why, rather than silently skipping it:** the official image has no
`CLAMD_CONF_*`-style environment variable for this — the only documented
mechanism is bind-mounting a replacement `clamd.conf` over
`/etc/clamav/clamd.conf`, and the image's real default `clamd.conf` is
generated at image-build time from the upstream `clamd.conf.sample` (sed
edits, per the Cisco-Talos/clamav-docker build) — not something shipped
anywhere I can read without actually running the container and inspecting
`/etc/clamav/clamd.conf` inside it. This machine couldn't safely run the
container at all this session (§7.4's memory note above — 0.4-0.6 GiB free
against a 3-4 GiB requirement), so I had no way to extract the real default
file and verify a replacement wouldn't silently drop some other directive
the entrypoint or networking depends on. Shipping an unverified config
mount felt like a worse risk than leaving this as a documented
recommendation. **To actually add it**: on a host with enough free memory,
run the real container once, `docker exec <container> cat /etc/clamav/clamd.conf`
to capture the real default, add `ConcurrentDatabaseReload no` to a copy of
it, mount that copy over `/etc/clamav/clamd.conf` in both the compose
service and the Railway service below, and confirm the container still
reaches `healthy` with it — then this note can be deleted and the setting
treated as done.

#### Running this in production (Railway) — concrete, not just "provision it somehow"

`docker-compose.yml` itself never reaches production (§4 above) — but the
exact same image can run as a **third Railway service** alongside
`chatmate360-api`/`chatmate360-worker`, same project:

1. In the Railway project, **+ New → Docker Image**, not "Deploy from GitHub
   repo" — Railway deploys directly from a registry image (Docker Hub,
   GHCR, GitLab, Microsoft Container Registry, or Quay.io are its
   documented sources), no Dockerfile/repo needed for this one. Image:
   `clamav/clamav:1.4_base`, same tag as local. Name the service
   `chatmate360-clamav`.
2. **Attach a Railway Volume** to it, mounted at `/var/lib/clamav` — the
   same path the local compose volume uses, for the same reason (signature
   database persistence; without it, every redeploy re-freshclams from
   empty, which is the several-minutes-slow cold start §7.4 already
   describes, every single time).
3. **Set this service's own memory allocation to at least 4 GiB** in its
   Railway resource settings (not the shared $5 Hobby-plan baseline the
   API/worker services were sized for in `DEPLOYMENT.md` §2.3 — this one
   needs its own explicit headroom, confirm the current setting in
   Railway's dashboard since this UI changes). Cost note, from third-party
   Railway pricing trackers, not Railway's own published rate card (confirm
   at railway.com/pricing before budgeting): memory is commonly reported
   around **$10/GB-month** (~$0.014/GB-hour), metered per second. A
   ClamAV service sitting at 3-4 GiB essentially continuously is roughly
   **$30-40/month just in RAM**, on top of CPU and the volume — this alone
   will exceed the $5/month Hobby-plan credit the rest of this stack was
   sized against; budget for it as a real line item, not an afterthought.
4. **Point the API and worker services at it** via Railway's private
   network, not a public URL: `DOCUMENT_SCAN_CLAMD_HOST=chatmate360-clamav.railway.internal`,
   `DOCUMENT_SCAN_CLAMD_PORT=3310`, set on both the API and worker services
   (same pattern `DEPLOYMENT.md` §2.3 already uses for shared env vars).
   Two things Railway's own docs flag as rough edges here, worth testing
   for real rather than assuming away: Railway's private network is
   **IPv6-only** (no IPv4), and **Alpine-based images can fail to resolve
   `*.railway.internal` DNS names** without `ENABLE_ALPINE_PRIVATE_NETWORKING=true`
   set on the affected service. The `clamav/clamav` image itself is
   Alpine-based, but it's the *caller* (API/worker) that does the DNS
   lookup here, and those run on a Debian/Ubuntu base
   (`mcr.microsoft.com/playwright:v1.62.1-jammy`, confirmed from this
   repo's own `Dockerfile`) — so this specific caveat likely doesn't apply
   to this setup, but it's a known enough Railway issue that it's worth
   confirming empirically on first deploy rather than assuming.
5. Re-run this section's two-step pre-deploy check (healthy, then EICAR +
   `vendor: "clamav"` in the logs) against the real Railway deployment
   before calling it done — the same two checks, just pointed at
   `chatmate360-clamav.railway.internal` instead of `127.0.0.1`.

This is the concrete shape of "a production `clamd`" that §4 above refers
to — §4 deliberately doesn't repeat these mechanics, to avoid the two
sections drifting out of sync with each other.

**Pre-deploy check — run both of these, in order, against whatever host
will run `clamd`:**

1. Confirm it's actually healthy, not just started:
   ```sh
   docker compose up -d clamav
   docker inspect --format='{{.State.Health.Status}}' <project>-clamav-1
   # or: ./scripts/wait-for-clamav.sh   (polls the same thing, with a timeout)
   ```
   Expect `healthy`. `starting` for several minutes on first boot is
   normal (see `start_period` above); anything that stays `unhealthy` past
   that means `clamdcheck.sh` is failing — check the container's logs
   before assuming it's just slow.
2. Then run §4's EICAR upload test against a chatbot whose backend is
   pointed at this `clamd` (`DOCUMENT_SCAN_VENDOR=clamav`,
   `DOCUMENT_SCAN_CLAMD_HOST`/`_PORT` matching), and confirm the log line's
   `vendor` field actually reads `"clamav"` — §4 already covers why the
   EICAR result alone (a `409`) doesn't prove this on its own.

**Confirmed: ClamAV being unreachable at runtime still fails closed for
both attachments and documents, but not identically** — read directly from
`chatAttachments.service.ts` and `documentIngestion.service.ts`, not
assumed from the fail-closed config flag alone:

- **Attachments** (`chatAttachments.service.ts:230-242`): a scan that
  throws (clamd unreachable/timeout) deletes the just-inserted
  `chatbot_attachments` row outright and returns a `503`
  (`MalwareScanUnavailableError`, retryable) to the uploader. There is no
  row left behind sitting in `'quarantined'` waiting for anything — "stays
  quarantined" isn't quite the literal mechanism, but the effect is the
  same guarantee: the file never reaches a servable (`'clean'`) state, and
  the uploader has to submit a fresh upload once the scanner's back, since
  nothing retries this automatically (attachment upload is synchronous,
  not queued).
- **Documents** (`documentIngestion.service.ts:572-588`): the same
  `MalwareScanUnavailableError` sets `scan_status = 'error'` but leaves the
  document's overall `status` at `'processing'` (never `'ready'`, never
  embedded, never served) and increments `ingest.scan_error` — this one
  **is** retried automatically, since document ingestion runs through a
  BullMQ job, not a synchronous request. This exact behavior is also
  already documented in `docs/MALWARE_SCAN.md`'s "Fail closed" section;
  nothing about it changed in this pass; confirmed by reading the code, not
  assumed from that doc alone.
