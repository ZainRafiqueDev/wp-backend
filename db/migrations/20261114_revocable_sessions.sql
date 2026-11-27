-- CS-11 (2026-11-14): revocable sessions for dashboard users and admins.
--
-- users.tokens_valid_after / admin_users.tokens_valid_after: access tokens
-- whose iat_ms is earlier than this are rejected by requireAuth /
-- requireAdminAuth. Moved forward on logout-all, password reset, Google
-- account link of an unverified account, deactivation (users) and on admin
-- logout / credential change (admins). Written from the app clock, see
-- src/lib/auth.ts.
--
-- refresh_tokens.session_id: stable id of one sign-in, carried across refresh
-- rotation and embedded in the access token as `sid`. Logout deletes the
-- session's refresh tokens, which also invalidates its access tokens.
--
-- refresh_tokens.rotated_at: set (instead of deleting the row) when a refresh
-- token is exchanged for a new one, so presenting it again is recognised as
-- reuse and ends the whole session. Rotated rows older than 7 days are pruned
-- at each rotation; all of a session's rows go when the session ends.
--
-- Watermarks and refresh_tokens.created_at are written with the database
-- clock (clock_timestamp()), and access tokens carry that same time as
-- iat_ms, so app instances with skewed clocks cannot misorder them.
--
-- Idempotent. The admin backfill below runs only in the same transaction
-- that adds admin_users.tokens_valid_after, so re-running this file never
-- signs anyone out again.
--
-- Dashboard users are NOT signed out by this migration: their watermark stays
-- null (no revocation yet), so every existing refresh token keeps working and
-- gets a session_id below. Pre-deploy access tokens need no watermark to die:
-- they carry no sid, which requireAuth rejects, and the dashboard silently
-- refreshes on that 401.
alter table users add column if not exists tokens_valid_after timestamptz;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'admin_users' and column_name = 'tokens_valid_after'
  ) then
    alter table admin_users add column tokens_valid_after timestamptz;
    -- Admin bearer tokens issued before this deploy (held in sessionStorage
    -- by the old admin UI) stop working; admins sign in again (cookie).
    update admin_users set tokens_valid_after = now();
  end if;
end $$;

alter table refresh_tokens add column if not exists session_id uuid;
update refresh_tokens set session_id = gen_random_uuid() where session_id is null;
alter table refresh_tokens alter column session_id set default gen_random_uuid();
alter table refresh_tokens alter column session_id set not null;
create index if not exists idx_refresh_tokens_session_id on refresh_tokens (session_id);
alter table refresh_tokens add column if not exists rotated_at timestamptz;
-- sha256 of the User-Agent the token was issued to (never the raw value).
alter table refresh_tokens add column if not exists client_fingerprint text;
