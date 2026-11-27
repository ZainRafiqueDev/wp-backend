-- CS-15 phase 1 of 2 (B02-005, B02-009, B03-016, S3-012): a separate login
-- role for privileged (admin / system) database work.
--
-- Additive only: nothing in here changes what chatmate360_app can do, so it
-- is safe to apply before the code that uses it is deployed. Phase 2
-- (20261115_rls_2_lockdown.sql) is what makes app.is_privileged() require
-- this role; apply it only after SYSTEM_DATABASE_URL is set on every API
-- and worker process (see docs/RLS.md "Two-role rollout").
--
-- No password is set here or anywhere else in versioned SQL. A role created
-- by this file cannot log in until the operator sets one:
--   alter role chatmate360_system with password '<from your secret store>';
-- Apply as the table owner (local docker: postgres). Idempotent.
--
-- Rollback: `drop owned by chatmate360_system; drop role chatmate360_system;`
-- (only after 20261115_rls_2_lockdown.sql has been rolled back, see there).

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'chatmate360_system') then
    create role chatmate360_system login nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  else
    alter role chatmate360_system with login nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;

  -- The tenant role must never be able to SET ROLE (or set_config('role'))
  -- into the privileged one, or the split buys nothing.
  if exists (select 1 from pg_roles where rolname = 'chatmate360_app')
     and pg_has_role('chatmate360_app', 'chatmate360_system', 'MEMBER') then
    execute 'revoke chatmate360_system from chatmate360_app';
  end if;
end $$;

do $$
begin
  -- CREATE on the database: LangGraph PostgresSaver.setup() runs
  -- CREATE SCHEMA IF NOT EXISTS public, which checks this privilege even when
  -- the schema exists. setup() now runs on this role (src/langgraph/checkpointer.ts)
  -- so the tenant role can lose it in phase 2.
  execute format('grant connect, create on database %I to chatmate360_system', current_database());
end $$;

create schema if not exists app;
grant usage on schema public to chatmate360_system;
grant usage on schema app to chatmate360_system;
grant create on schema public to chatmate360_system;
grant execute on all functions in schema app to chatmate360_system;
grant select, insert, update, delete on all tables in schema public to chatmate360_system;
grant usage, select on all sequences in schema public to chatmate360_system;
alter default privileges in schema public grant select, insert, update, delete on tables to chatmate360_system;
alter default privileges in schema public grant usage, select on sequences to chatmate360_system;

-- Tables chatmate360_system itself creates (LangGraph setup on a fresh
-- database) stay usable by the tenant login. Needs superuser or membership
-- in chatmate360_system; src/langgraph/checkpointer.ts also grants after setup.
do $$
begin
  execute 'alter default privileges for role chatmate360_system in schema public grant select, insert, update, delete on tables to chatmate360_app';
  execute 'alter default privileges for role chatmate360_system in schema public grant usage, select on sequences to chatmate360_app';
exception
  when insufficient_privilege or undefined_object then
    raise notice 'default privileges for chatmate360_system not set (%); rely on the checkpointer grant', sqlerrm;
end $$;

do $$
begin
  if to_regclass('public.checkpoint_migrations') is not null then
    execute 'grant all on table checkpoint_migrations to chatmate360_system';
  end if;
  if to_regclass('public.checkpoints') is not null then
    execute 'grant all on table checkpoints to chatmate360_system';
  end if;
  if to_regclass('public.checkpoint_blobs') is not null then
    execute 'grant all on table checkpoint_blobs to chatmate360_system';
  end if;
  if to_regclass('public.checkpoint_writes') is not null then
    execute 'grant all on table checkpoint_writes to chatmate360_system';
  end if;
end $$;
