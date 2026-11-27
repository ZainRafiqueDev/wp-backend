# WP-3.1 Postgres RLS

Application ownership (`requireOwnedChatbotId`) stays the isolation boundary. RLS is defense in depth.

## What shipped

- `src/lib/tenantContext.ts` — AsyncLocalStorage tenant GUCs (`app.chatbot_id`, `app.user_id`, `app.scope`, …).
- `src/lib/db.ts` — `pool.query` runs `BEGIN` + `SET LOCAL` (via `set_config(..., true)`) then the statement. `pool.connect()` applies session GUCs (`set_config(..., false)`) so callers can `BEGIN`/`COMMIT` without an extra wrapper transaction. Superuser connections bypass RLS and log `rls.bypass_role`.
- `db/rls.sql` — `ENABLE` + `FORCE ROW LEVEL SECURITY`, policies on `chatbot_id` / `user_id`, role `chatmate360_app` (`NOSUPERUSER`, `NOBYPASSRLS`).
- HTTP, public chat, workers, and verified webhooks set context. Owner routes do **not** take `chatbot_id` from the URL until `requireOwnedChatbotId` succeeds.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `RLS_ENABLED` | `true` | Log `rls.missing_tenant_context` when a query has no tenant GUC. Policies still exist in Postgres. |
| `RLS_APP_ROLE` | `chatmate360_app` | Expected login role. Superuser/`BYPASSRLS` logs `rls.bypass_role`. |
| `DATABASE_URL` | — | Production and CI tests must use `chatmate360_app`, not `postgres`. |
| `SYSTEM_DATABASE_URL` | — | CS-15. Login for `admin` / `system` scope work (`chatmate360_system`). Required in production; read by `src/lib/db.ts`. Tests: `TEST_SYSTEM_DATABASE_URL`. |

### Roles and passwords (CS-15)

- `chatmate360_app` — tenant login. `NOBYPASSRLS`, CONNECT + DML only (no CREATE on the database or schema `public`). Never a member of `chatmate360_system`.
- `chatmate360_system` — privileged login. `NOBYPASSRLS`; `app.is_privileged()` is `app.scope in ('admin','system')` **and** `pg_has_role(current_user, 'chatmate360_system', 'MEMBER')`. Setting `app.scope = 'system'` on the tenant login therefore grants nothing (B02-009). Holds CREATE for LangGraph `PostgresSaver.setup()`, which `src/langgraph/checkpointer.ts` runs on this login.
- No password exists in versioned SQL, compose or code. Set both from a secret store:

```sql
alter role chatmate360_app with password '<strong unique password>';
alter role chatmate360_system with password '<different strong password>';
```

`src/lib/db.ts` routes queries by scope: only an explicit `admin`/`system` context uses the system pool; empty or missing context stays on the tenant login, where RLS returns 0 rows. In production it refuses to boot when `SYSTEM_DATABASE_URL` is unset or a URL uses a default/self-named password, and refuses connections whose role is superuser/`BYPASSRLS` or (tenant pool) a member of `chatmate360_system`.

Missing tenant context fails closed everywhere. Only the vitest setup file (`tests/setup/implicitSystemContext.ts`) opts context-less fixture queries into system scope, via `allowImplicitSystemContextForTests()`, which throws outside `NODE_ENV=test` (B09-017).

Tables also covered since CS-15 (`20261115_rls_2_lockdown.sql`): `chatbot_attachments` (chatbot_id), `attachment_storage_usage` (owner, or owner of `app.chatbot_id`), `workspace_members` (owner or member), `workspace_invitations` (owner, or a signed-in invitee presenting the token via `app.lookup_hash`), `workspace_audit_log` (owner reads; owner or member writes). `chatbots.user_id` can only change in a privileged context (trigger `chatbots_freeze_owner`).

### Running tests locally

The roles have no default password, so the suite needs both test URLs, or every DB test fails with a SASL/password authentication error:

1. Once per local cluster, as `postgres`, set local-only passwords (never real secrets): `alter role chatmate360_app with password '<local>'` and `alter role chatmate360_system with password '<other local>'`.
2. Bring `chatmate360_test` up to date: `db/schema.sql`, then any newer migration not yet in it, then `db/migrations/20261115_rls_2_lockdown.sql` (the suite expects the lockdown).
3. Put `TEST_DATABASE_URL=postgresql://chatmate360_app:<local>@127.0.0.1:5435/chatmate360_test` and `TEST_SYSTEM_DATABASE_URL=postgresql://chatmate360_system:<other local>@127.0.0.1:5435/chatmate360_test` in the untracked `.env`, or export them. `vitest.config.ts` reads only these two keys from `.env` and passes them to tests as `DATABASE_URL` / `SYSTEM_DATABASE_URL`.

### Two-role rollout (every database, new or existing)

The lockdown is **never** applied by `db/schema.sql` or `db/rls.sql`. It is a separate, explicit step, so applying the schema on a live database still served by pre-CS-15 code changes nothing that code relies on.

1. **Schema (safe with old or new code).** `psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -f db/schema.sql`. This includes only `20261115_rls_1_system_role.sql` (creates `chatmate360_system`, grants; additive). `rls.sql` keeps the pre-lockdown privilege model until step 3 has run, and after that never loosens it again (it checks for `app.cs15_lockdown_applied()`).
2. **Credentials and code.** Set passwords for both roles; set `SYSTEM_DATABASE_URL` on the API **and** worker; deploy the CS-15 code; confirm it is healthy (it logs `rls.lockdown_missing` at error level in production until step 3).
3. **Lockdown (explicit).** `psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/20261115_rls_2_lockdown.sql`. Run before step 2 it makes admin/system work see 0 rows (fails closed). Verify with `select app.cs15_lockdown_applied();`.

The admin login and `npm run create-admin` use the system login (`admin_users` is revoked from `chatmate360_app` in step 3), so `scripts/createAdmin.ts` needs `SYSTEM_DATABASE_URL` too.

Rollback of step 3 is in the header of that migration (drop the marker, restore the old `is_privileged()`, drop the triggers, disable RLS on the five tables, re-grant `admin_users`).

## Shadow then enable (production checklist)

1. Apply `db/migrations/20260928_postgres_rls.sql` (or `db/schema.sql` on a new database) as the table owner.
2. Keep API `DATABASE_URL` on the current role in staging first — superuser still bypasses; this is the shadow window. Confirm `SET LOCAL` logs and workers.
3. Switch API + worker `DATABASE_URL` to `chatmate360_app`.
4. Watch `rls.missing_tenant_context`, 0-row anomalies, and auth/chat error rates.

## Rollback

Hotfix either:

```sql
-- per table, or loop all tenant tables in db/rls.sql
alter table chatbot_document_chunks disable row level security;
alter table chatbot_document_chunks no force row level security;
```

or reconnect `DATABASE_URL` as a superuser/BYPASSRLS role (restores pre-WP-3.1 leak surface — only for an emergency).

Do not set `RLS_ENABLED=false` while connected as `chatmate360_app` with policies still enabled: GUCs would still be empty on a bug and queries would return 0 rows.

## Out of scope

- Universal `tenant_id` column (blueprint allows relying on `chatbot_id` / `user_id`).
- RLS on LangGraph checkpoint tables (separate runtime-created schema).
- WP-3.2 provider circuit breakers.
