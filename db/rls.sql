-- WP-3.1 Postgres RLS. Defense in depth; application checks stay.
-- Idempotent. Apply as a superuser/table owner (local: postgres), then point
-- DATABASE_URL at chatmate360_app (NOBYPASSRLS) so policies actually bind.
-- Rollback: see the footer, or docs/RLS.md.

create schema if not exists app;

create or replace function app.current_scope()
returns text
language sql
stable
as $$
  select lower(coalesce(nullif(current_setting('app.scope', true), ''), ''))
$$;

create or replace function app.current_uuid(setting_name text)
returns uuid
language plpgsql
stable
as $$
declare
  raw text;
begin
  raw := nullif(current_setting(setting_name, true), '');
  if raw is null then
    return null;
  end if;
  begin
    return raw::uuid;
  exception
    when invalid_text_representation then
      return null;
  end;
end;
$$;

-- Roles are created WITHOUT a password (CS-15, B02-005/B03-016): neither can
-- log in until the operator sets one from a secret store, e.g.
--   alter role chatmate360_app with password '<secret>';
--   alter role chatmate360_system with password '<different secret>';
-- chatmate360_system is the privileged (admin/system scope) login; the
-- tenant role is never a member of it. See docs/RLS.md.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'chatmate360_app') then
    create role chatmate360_app login
      nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  else
    alter role chatmate360_app with login nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'chatmate360_system') then
    create role chatmate360_system login
      nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
end $$;

-- CS-15 two-step rollout: this file runs on every `psql -f db/schema.sql`,
-- including on a live database still served by pre-CS-15 code. It therefore
-- keeps the pre-lockdown privilege model (scope GUC; CREATE for the app
-- role, which old code's LangGraph setup needs) UNTIL the explicit step-3
-- script db/migrations/20261115_rls_2_lockdown.sql has run. That script
-- creates app.cs15_lockdown_applied(); once it exists this file never
-- loosens anything again (see the end of the file).
do $$
begin
  if to_regproc('app.cs15_lockdown_applied') is null then
    execute $f$
      create or replace function app.is_privileged()
      returns boolean
      language sql
      stable
      as $b$ select app.current_scope() in ('admin', 'system') $b$
    $f$;
    -- CONNECT plus CREATE: pre-CS-15 LangGraph PostgresSaver.setup() runs
    -- CREATE SCHEMA IF NOT EXISTS public on this role.
    execute format('grant connect, create on database %I to chatmate360_app', current_database());
    execute 'grant create on schema public to chatmate360_app';
  else
    execute format('grant connect on database %I to chatmate360_app', current_database());
  end if;
end $$;
grant usage on schema public to chatmate360_app;
grant usage on schema app to chatmate360_app;
grant execute on all functions in schema app to chatmate360_app;
grant select, insert, update, delete on all tables in schema public to chatmate360_app;
grant usage, select on all sequences in schema public to chatmate360_app;
alter default privileges in schema public grant select, insert, update, delete on tables to chatmate360_app;
alter default privileges in schema public grant usage, select on sequences to chatmate360_app;

-- ---------------------------------------------------------------------------
-- Tenant tables. chatbot_id / user_id policies; no universal tenant_id column.
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
  chatbot_tables text[] := array[
    'chatbot_live_data',
    'chatbot_integrations',
    'chatbot_actions',
    'chatbot_usage',
    'chatbot_model_credits',
    'chatbot_abuse_flags',
    'conversations',
    'chatbot_woocommerce_credentials',
    'customer_identities',
    'commerce_orders',
    'commerce_tickets',
    'product_catalog_cache',
    'commerce_webhook_events',
    'customer_notifications',
    'chatbot_bookly_credentials',
    'chatbot_bookly_appointments',
    'chatbot_bookly_admin_audit_log',
    'chatbot_documents',
    'chatbot_document_chunks',
    'chatbot_bookly_additional_resources',
    'routing_events',
    'usage_alerts_sent',
    'model_routing_configs',
    'document_ingestion_log',
    'okf_concepts',
    'okf_index',
    'okf_audit_log',
    'okf_routing_log'
  ];
  user_tables text[] := array[
    'notifications',
    'refresh_tokens',
    'subscriptions',
    'embedding_usage_daily'
  ];
begin
  foreach t in array chatbot_tables loop
    -- Some entries here (model_routing_configs, document_ingestion_log, the
    -- okf_* tables) are created by migrations that run AFTER this file in
    -- db/schema.sql's fresh-install sequence — skip a table that doesn't
    -- exist yet rather than failing the whole install. Each such migration
    -- enables RLS on its own new tables itself once created.
    if to_regclass('public.' || t) is null then
      continue;
    end if;
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('drop policy if exists %I on %I', t || '_isolation', t);
    execute format(
      'create policy %I on %I using (app.is_privileged() or chatbot_id = app.current_uuid(''app.chatbot_id'')) with check (app.is_privileged() or chatbot_id = app.current_uuid(''app.chatbot_id''))',
      t || '_isolation',
      t
    );
  end loop;

  foreach t in array user_tables loop
    if to_regclass('public.' || t) is null then
      continue;
    end if;
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('drop policy if exists %I on %I', t || '_isolation', t);
    execute format(
      'create policy %I on %I using (app.is_privileged() or user_id = app.current_uuid(''app.user_id'')) with check (app.is_privileged() or user_id = app.current_uuid(''app.user_id''))',
      t || '_isolation',
      t
    );
  end loop;
end $$;

alter table users enable row level security;
alter table users force row level security;
drop policy if exists users_isolation on users;
create policy users_isolation on users
  using (
    app.is_privileged()
    or id = app.current_uuid('app.user_id')
    or (
      app.current_scope() = 'auth'
      and lower(email) = lower(nullif(current_setting('app.user_email', true), ''))
    )
    or (
      app.current_scope() = 'auth'
      and nullif(current_setting('app.google_id', true), '') is not null
      and google_id = current_setting('app.google_id', true)
    )
  )
  with check (
    app.is_privileged()
    or id = app.current_uuid('app.user_id')
    or (
      app.current_scope() = 'auth'
      and lower(email) = lower(nullif(current_setting('app.user_email', true), ''))
    )
  );

alter table chatbots enable row level security;
alter table chatbots force row level security;
drop policy if exists chatbots_isolation on chatbots;
create policy chatbots_isolation on chatbots
  using (
    app.is_privileged()
    or user_id = app.current_uuid('app.user_id')
    or id = app.current_uuid('app.chatbot_id')
  )
  with check (
    app.is_privileged()
    or user_id = app.current_uuid('app.user_id')
    or id = app.current_uuid('app.chatbot_id')
  );

alter table email_verification_tokens enable row level security;
alter table email_verification_tokens force row level security;
drop policy if exists email_verification_tokens_isolation on email_verification_tokens;
create policy email_verification_tokens_isolation on email_verification_tokens
  using (
    app.is_privileged()
    or user_id = app.current_uuid('app.user_id')
    or (
      app.current_scope() = 'auth'
      and token_hash = nullif(current_setting('app.lookup_hash', true), '')
    )
  )
  with check (
    app.is_privileged()
    or user_id = app.current_uuid('app.user_id')
  );

alter table password_reset_tokens enable row level security;
alter table password_reset_tokens force row level security;
drop policy if exists password_reset_tokens_isolation on password_reset_tokens;
create policy password_reset_tokens_isolation on password_reset_tokens
  using (
    app.is_privileged()
    or user_id = app.current_uuid('app.user_id')
    or (
      app.current_scope() = 'auth'
      and token_hash = nullif(current_setting('app.lookup_hash', true), '')
    )
  )
  with check (
    app.is_privileged()
    or user_id = app.current_uuid('app.user_id')
  );

-- Token lookup for rotate/logout before user_id is known.
drop policy if exists refresh_tokens_lookup on refresh_tokens;
create policy refresh_tokens_lookup on refresh_tokens
  using (
    app.current_scope() = 'auth'
    and token_hash = nullif(current_setting('app.lookup_hash', true), '')
  );

-- WP-3.4 memory tables. Keyed by a hashed customer_identifier, but the tenant
-- key RLS binds on is still chatbot_id. Guarded by to_regclass because both
-- arrive via db/migrations, not db/schema.sql, so a partially-migrated
-- database can still run this file end to end.
do $$
declare
  t text;
  memory_tables text[] := array['session_summaries', 'conversation_facts'];
begin
  foreach t in array memory_tables loop
    if to_regclass(format('public.%I', t)) is null then
      continue;
    end if;
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('drop policy if exists %I on %I', t || '_isolation', t);
    execute format(
      'create policy %I on %I using (app.is_privileged() or chatbot_id = app.current_uuid(''app.chatbot_id'')) with check (app.is_privileged() or chatbot_id = app.current_uuid(''app.chatbot_id''))',
      t || '_isolation',
      t
    );
  end loop;
end $$;

alter table messages enable row level security;
alter table messages force row level security;
drop policy if exists messages_isolation on messages;
create policy messages_isolation on messages
  using (
    app.is_privileged()
    or exists (
      select 1
        from conversations c
       where c.id = messages.conversation_id
         and c.chatbot_id = app.current_uuid('app.chatbot_id')
    )
  )
  with check (
    app.is_privileged()
    or exists (
      select 1
        from conversations c
       where c.id = messages.conversation_id
         and c.chatbot_id = app.current_uuid('app.chatbot_id')
    )
  );

alter table auto_purchase_events enable row level security;
alter table auto_purchase_events force row level security;
drop policy if exists auto_purchase_events_isolation on auto_purchase_events;
create policy auto_purchase_events_isolation on auto_purchase_events
  using (
    app.is_privileged()
    or chatbot_id = app.current_uuid('app.chatbot_id')
    or user_id = app.current_uuid('app.user_id')
  )
  with check (
    app.is_privileged()
    or chatbot_id = app.current_uuid('app.chatbot_id')
    or user_id = app.current_uuid('app.user_id')
  );

alter table reservations enable row level security;
alter table reservations force row level security;
drop policy if exists reservations_isolation on reservations;
create policy reservations_isolation on reservations
  using (
    app.is_privileged()
    or chatbot_id = app.current_uuid('app.chatbot_id')
    or (
      scope = 'platform'
      and app.current_uuid('app.chatbot_id') is not null
    )
  )
  with check (
    app.is_privileged()
    or chatbot_id = app.current_uuid('app.chatbot_id')
  );

alter table auth_otps enable row level security;
alter table auth_otps force row level security;
drop policy if exists auth_otps_isolation on auth_otps;
create policy auth_otps_isolation on auth_otps
  using (
    app.is_privileged()
    or user_id = app.current_uuid('app.user_id')
    or chatbot_id = app.current_uuid('app.chatbot_id')
    or (
      app.current_scope() = 'auth'
      and lower(email) = lower(nullif(current_setting('app.user_email', true), ''))
    )
  )
  with check (
    app.is_privileged()
    or user_id = app.current_uuid('app.user_id')
    or chatbot_id = app.current_uuid('app.chatbot_id')
    or (
      app.current_scope() = 'auth'
      and lower(email) = lower(nullif(current_setting('app.user_email', true), ''))
    )
  );

alter table leads enable row level security;
alter table leads force row level security;
drop policy if exists leads_isolation on leads;
create policy leads_isolation on leads
  using (
    app.is_privileged()
    or user_id = app.current_uuid('app.user_id')
    or (
      app.current_scope() in ('auth', 'public')
      and lower(email) = lower(nullif(current_setting('app.user_email', true), ''))
    )
  )
  with check (
    app.is_privileged()
    or user_id = app.current_uuid('app.user_id')
    or (
      app.current_scope() in ('auth', 'public')
      and lower(email) = lower(nullif(current_setting('app.user_email', true), ''))
    )
  );

alter table admin_audit_log enable row level security;
alter table admin_audit_log force row level security;
drop policy if exists admin_audit_log_isolation on admin_audit_log;
create policy admin_audit_log_isolation on admin_audit_log
  using (app.is_privileged())
  with check (app.is_privileged());

alter table stripe_webhook_events enable row level security;
alter table stripe_webhook_events force row level security;
drop policy if exists stripe_webhook_events_isolation on stripe_webhook_events;
create policy stripe_webhook_events_isolation on stripe_webhook_events
  using (app.is_privileged())
  with check (app.is_privileged());

-- Platform tables intentionally without RLS (no tenant key):
-- waitlist, trial_signups, contact_submissions, admin_users.
-- LangGraph checkpoint tables are created at runtime (or already exist from
-- a prior setup()) and are not RLS'd. DML + a completed migration watermark
-- so the app role does not need to ALTER postgres-owned tables.
do $$
begin
  if to_regclass('public.checkpoint_migrations') is not null then
    execute 'grant all on table checkpoint_migrations to chatmate360_app';
    execute 'insert into checkpoint_migrations (v) select i from generate_series(0, 4) as i on conflict do nothing';
  end if;
  if to_regclass('public.checkpoints') is not null then
    execute 'grant all on table checkpoints to chatmate360_app';
  end if;
  if to_regclass('public.checkpoint_blobs') is not null then
    execute 'grant all on table checkpoint_blobs to chatmate360_app';
  end if;
  if to_regclass('public.checkpoint_writes') is not null then
    execute 'grant all on table checkpoint_writes to chatmate360_app';
  end if;
end $$;

-- CS-15: after the lockdown, re-assert what the blanket grants above would
-- otherwise hand back to the tenant role.
do $$
begin
  if to_regproc('app.cs15_lockdown_applied') is not null then
    execute format('revoke create on database %I from chatmate360_app', current_database());
    execute 'revoke create on schema public from chatmate360_app';
    if to_regclass('public.admin_users') is not null then
      execute 'revoke all on table admin_users from chatmate360_app';
    end if;
  end if;
end $$;

-- Rollback (hotfix):
--   alter table <name> disable row level security;
--   alter table <name> no force row level security;
-- Or reconnect DATABASE_URL as a BYPASSRLS/superuser role (not for ongoing prod).
