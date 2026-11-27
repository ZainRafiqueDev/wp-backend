-- WP-3.4 Advanced Session Memory.
--
-- Three additions on top of the existing conversations/messages/session_summaries
-- memory system (20260928_session_summaries.sql):
--   1. conversation_facts — durable, structured, per-customer facts extracted
--      from turns, so memory is not only a prose blob. Keyed by the same
--      hashed customer_identifier session_summaries uses (never a plain email).
--   2. conversations.expires_at / needs_compaction — idle TTL plus a flag the
--      worker uses to compact off the chat request path (ADR 0001: "move
--      compact to a worker").
--   3. RLS for session_summaries and conversation_facts, which the original
--      RLS rollout (20260928_postgres_rls.sql) did not cover.

create table if not exists conversation_facts (
    id                  uuid primary key default gen_random_uuid(),
    chatbot_id          uuid not null references chatbots(id) on delete cascade,
    customer_identifier text not null,
    fact_key            text not null,
    fact_value          text not null,
    confidence          real not null default 0.5,
    first_seen_at       timestamptz not null default now(),
    last_seen_at        timestamptz not null default now()
);

create unique index if not exists idx_conversation_facts_scope
    on conversation_facts (chatbot_id, customer_identifier, fact_key);

create index if not exists idx_conversation_facts_customer
    on conversation_facts (chatbot_id, customer_identifier, last_seen_at desc);

-- Idle TTL. Null means "not yet stamped" — pre-existing rows are left alone
-- until their next turn, so this migration never silently expires live data.
alter table conversations add column if not exists expires_at timestamptz;
alter table conversations add column if not exists needs_compaction boolean not null default false;

create index if not exists idx_conversations_expires_at
    on conversations (expires_at)
    where expires_at is not null;

create index if not exists idx_conversations_needs_compaction
    on conversations (updated_at)
    where needs_compaction;

-- Memory tables are chatbot-scoped; same policy shape as every other
-- chatbot_id table in db/rls.sql. Skipped entirely when db/rls.sql has not
-- been applied yet (app.is_privileged() is defined there).
do $$
declare
  t text;
  memory_tables text[] := array['session_summaries', 'conversation_facts'];
begin
  if not exists (
    select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app' and p.proname = 'is_privileged'
  ) then
    raise notice 'app.is_privileged() missing — apply db/rls.sql, then re-run this migration';
    return;
  end if;

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

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'chatmate360_app') then
    execute 'grant select, insert, update, delete on conversation_facts to chatmate360_app';
  end if;
end $$;

-- Rollback:
--   drop table if exists conversation_facts;
--   alter table conversations drop column if exists expires_at;
--   alter table conversations drop column if exists needs_compaction;
--   alter table session_summaries disable row level security;
