-- CS-15 phase 2 of 2: RLS lockdown.
--   B02-009  app.is_privileged() no longer trusts the app.scope GUC alone. A
--            session can still set app.scope = 'system' (any SQL can call
--            set_config), but the privilege now also requires the connected
--            role to be chatmate360_system, a separate login whose password
--            the tenant role never sees. chatbots.user_id can no longer be
--            rewritten from a tenant / public / worker context.
--   B02-005  chatmate360_app loses CREATE on the database and schema public.
--   B02-008  RLS + FORCE RLS on chatbot_attachments, attachment_storage_usage,
--            workspace_members, workspace_invitations, workspace_audit_log.
--
--   admin    chatmate360_app loses all access to admin_users (password hashes).
--
-- STEP 3 of docs/RLS.md "Two-role rollout". NOT included by db/schema.sql:
-- run it on its own, explicitly, as the table owner:
--   psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/20261115_rls_2_lockdown.sql
-- Prerequisites, in this order:
--   1. db/schema.sql (includes 20261115_rls_1_system_role.sql) applied;
--   2. passwords set for both roles, SYSTEM_DATABASE_URL set on every API and
--      worker process, and the CS-15 code deployed and healthy.
-- Applying this before step 2 makes every admin/system query (access gate,
-- sweeps, webhooks, admin dashboard) return 0 rows: fail closed, not open.
--
-- Idempotent; forward-only.
--
-- Rollback (emergency only; restores the B02-009 weakness):
--   create or replace function app.is_privileged() returns boolean language sql
--     stable as $f$ select app.current_scope() in ('admin', 'system') $f$;
--   drop function app.cs15_lockdown_applied();  -- lets db/rls.sql loosen again
--   drop trigger if exists chatbots_freeze_owner on chatbots;
--   drop trigger if exists workspace_invitations_invitee_guard on workspace_invitations;
--   grant select, insert, update, delete on admin_users to chatmate360_app;
--   alter table <each table below> no force row level security;
--   alter table <each table below> disable row level security;
--   (re-granting CREATE to chatmate360_app is not needed by the CS-15 code.)

-- ---------------------------------------------------------------------------
-- Privilege = privileged scope AND privileged role.
-- plpgsql on purpose: an inlined SQL body exposes both conditions to the
-- planner, which then estimates the `is_privileged() OR tenant key` RLS
-- filter at well under 1% of rows and picks nested loops. On a 55k-user
-- table the admin user list went from ~0.2s to 100s (statement timeout).
-- As an opaque boolean function it gets the default selectivity instead.
-- ---------------------------------------------------------------------------
create or replace function app.is_privileged()
returns boolean
language plpgsql
stable
as $$
begin
  return app.current_scope() in ('admin', 'system')
     and pg_has_role(current_user, 'chatmate360_system', 'MEMBER');
end;
$$;

-- ---------------------------------------------------------------------------
-- No CREATE for the tenant role (B02-005). The system role keeps it for
-- LangGraph setup (phase 1). PUBLIC loses CREATE on schema public as well:
-- the default since Postgres 15, explicit here for older servers.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'chatmate360_app') then
    execute format('revoke create on database %I from chatmate360_app', current_database());
    execute 'revoke create on schema public from chatmate360_app';
  end if;
end $$;
revoke create on schema public from public;

-- ---------------------------------------------------------------------------
-- chatbots.user_id is the tenant key every other policy hangs off. The
-- existing chatbots policy lets a public/worker context (id = app.chatbot_id)
-- UPDATE the row, so freeze the owner column outside privileged contexts.
-- Superuser / BYPASSRLS maintenance sessions are not blocked.
-- ---------------------------------------------------------------------------
create or replace function app.chatbots_freeze_owner()
returns trigger
language plpgsql
as $$
begin
  if new.user_id is distinct from old.user_id
     and not app.is_privileged()
     and not exists (
       select 1 from pg_roles r
        where r.rolname = session_user
          and (r.rolsuper or r.rolbypassrls)
     ) then
    raise exception 'chatbots.user_id can only be changed in a privileged context'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists chatbots_freeze_owner on chatbots;
create trigger chatbots_freeze_owner
  before update of user_id on chatbots
  for each row execute function app.chatbots_freeze_owner();

-- ---------------------------------------------------------------------------
-- B02-008: tenant tables added after WP-3.1 that never got policies.
-- ---------------------------------------------------------------------------

-- Visitor attachments: same chatbot_id policy as every other chatbot table.
alter table chatbot_attachments enable row level security;
alter table chatbot_attachments force row level security;
drop policy if exists chatbot_attachments_isolation on chatbot_attachments;
create policy chatbot_attachments_isolation on chatbot_attachments
  using (app.is_privileged() or chatbot_id = app.current_uuid('app.chatbot_id'))
  with check (app.is_privileged() or chatbot_id = app.current_uuid('app.chatbot_id'));

-- Per-account attachment byte counter. The owner sees it by user id; a
-- public widget upload (scope public, app.chatbot_id only) reserves bytes on
-- the account that owns that chatbot, resolved through chatbots RLS.
alter table attachment_storage_usage enable row level security;
alter table attachment_storage_usage force row level security;
drop policy if exists attachment_storage_usage_isolation on attachment_storage_usage;
create policy attachment_storage_usage_isolation on attachment_storage_usage
  using (
    app.is_privileged()
    or owner_user_id = app.current_uuid('app.user_id')
    or owner_user_id = (
      select c.user_id from chatbots c where c.id = app.current_uuid('app.chatbot_id')
    )
  )
  with check (
    app.is_privileged()
    or owner_user_id = app.current_uuid('app.user_id')
    or owner_user_id = (
      select c.user_id from chatbots c where c.id = app.current_uuid('app.chatbot_id')
    )
  );

-- The invitee clause: a signed-in user presenting the raw token
-- (acceptInvitation sets app.lookup_hash) for an invitation addressed to
-- their own e-mail. users RLS lets a user read only their own row.
create or replace function app.is_invitee_of(inv_token_hash text, inv_email text)
returns boolean
language sql
stable
as $$
  select app.current_scope() = 'user'
     and app.current_uuid('app.user_id') is not null
     and inv_token_hash = nullif(current_setting('app.lookup_hash', true), '')
     and exists (
       select 1 from users u
        where u.id = app.current_uuid('app.user_id')
          and lower(u.email) = lower(inv_email)
     )
$$;

-- Invitations: the owner manages its own rows. The invitee may only SELECT
-- and UPDATE (never INSERT/DELETE) the one row it holds the token for, and
-- the trigger below limits that UPDATE to the status transition.
alter table workspace_invitations enable row level security;
alter table workspace_invitations force row level security;
drop policy if exists workspace_invitations_isolation on workspace_invitations;
drop policy if exists workspace_invitations_owner on workspace_invitations;
drop policy if exists workspace_invitations_invitee_select on workspace_invitations;
drop policy if exists workspace_invitations_invitee_update on workspace_invitations;
create policy workspace_invitations_owner on workspace_invitations
  using (app.is_privileged() or owner_user_id = app.current_uuid('app.user_id'))
  with check (app.is_privileged() or owner_user_id = app.current_uuid('app.user_id'));
create policy workspace_invitations_invitee_select on workspace_invitations
  for select
  using (app.is_invitee_of(token_hash, email));
create policy workspace_invitations_invitee_update on workspace_invitations
  for update
  using (app.is_invitee_of(token_hash, email))
  with check (app.is_invitee_of(token_hash, email));

-- WITH CHECK cannot see OLD, so pin every column except the status
-- transition for anyone who is neither privileged nor the row's owner.
create or replace function app.workspace_invitations_invitee_guard()
returns trigger
language plpgsql
as $$
begin
  if app.is_privileged()
     or old.owner_user_id = app.current_uuid('app.user_id')
     or exists (
       select 1 from pg_roles r
        where r.rolname = session_user
          and (r.rolsuper or r.rolbypassrls)
     ) then
    return new;
  end if;
  if new.id is distinct from old.id
     or new.owner_user_id is distinct from old.owner_user_id
     or new.email is distinct from old.email
     or new.role is distinct from old.role
     or new.token_hash is distinct from old.token_hash
     or new.invited_by is distinct from old.invited_by
     or new.expires_at is distinct from old.expires_at
     or new.created_at is distinct from old.created_at
     or new.revoked_at is distinct from old.revoked_at
     or old.status <> 'pending'
     or new.status not in ('accepted', 'expired')
     or (new.status = 'expired' and new.accepted_at is distinct from old.accepted_at) then
    raise exception 'an invitee may only accept or expire its own pending invitation'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists workspace_invitations_invitee_guard on workspace_invitations;
create trigger workspace_invitations_invitee_guard
  before update on workspace_invitations
  for each row execute function app.workspace_invitations_invitee_guard();

-- Memberships: visible to the owner and to the member themself; written by
-- the owner. The invitee may INSERT only itself, only into the workspace and
-- with the role of an invitation it accepted in this same transaction
-- (acceptInvitation marks it accepted, then inserts; accepted_at = now() pins
-- it to the transaction) that is unexpired and addressed to its own e-mail.
alter table workspace_members enable row level security;
alter table workspace_members force row level security;
drop policy if exists workspace_members_isolation on workspace_members;
drop policy if exists workspace_members_invitee_insert on workspace_members;
create policy workspace_members_isolation on workspace_members
  using (
    app.is_privileged()
    or owner_user_id = app.current_uuid('app.user_id')
    or member_user_id = app.current_uuid('app.user_id')
  )
  with check (
    app.is_privileged()
    or owner_user_id = app.current_uuid('app.user_id')
  );
create policy workspace_members_invitee_insert on workspace_members
  for insert
  with check (
    member_user_id = app.current_uuid('app.user_id')
    and exists (
      select 1
        from workspace_invitations i
       where i.owner_user_id = workspace_members.owner_user_id
         and i.role = workspace_members.role
         and i.status = 'accepted'
         and i.accepted_at = now()
         and i.expires_at > now()
         and app.is_invitee_of(i.token_hash, i.email)
    )
  );

-- Workspace audit log: read by the owner only; written by the owner, or by
-- a member about their own action in the workspace they belong to.
alter table workspace_audit_log enable row level security;
alter table workspace_audit_log force row level security;
drop policy if exists workspace_audit_log_isolation on workspace_audit_log;
create policy workspace_audit_log_isolation on workspace_audit_log
  using (
    app.is_privileged()
    or owner_user_id = app.current_uuid('app.user_id')
  )
  with check (
    app.is_privileged()
    or owner_user_id = app.current_uuid('app.user_id')
    or (
      actor_user_id = app.current_uuid('app.user_id')
      and exists (
        select 1
          from workspace_members m
         where m.owner_user_id = workspace_audit_log.owner_user_id
           and m.member_user_id = app.current_uuid('app.user_id')
      )
    )
  );

-- ---------------------------------------------------------------------------
-- Pre-existing gap: admin_users has no tenant key and holds password hashes.
-- Admin auth runs on the system login (adminAuth.service.ts), so the tenant
-- role loses all access to it.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'chatmate360_app')
     and to_regclass('public.admin_users') is not null then
    execute 'revoke all on table admin_users from chatmate360_app';
  end if;
end $$;

-- Marker read by db/rls.sql (so re-running schema.sql never loosens the
-- lockdown) and by src/lib/db.ts (logs rls.lockdown_missing in production).
create or replace function app.cs15_lockdown_applied()
returns boolean
language sql
immutable
as $$ select true $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'chatmate360_app') then
    execute 'grant execute on all functions in schema app to chatmate360_app';
  end if;
  if exists (select 1 from pg_roles where rolname = 'chatmate360_system') then
    execute 'grant execute on all functions in schema app to chatmate360_system';
  end if;
end $$;
