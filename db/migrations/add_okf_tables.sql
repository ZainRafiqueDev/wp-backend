-- Phase 5 OKF knowledge layer. Additive. Apply to chatmate360 and chatmate360_test.

create table if not exists okf_concepts (
  id                     uuid primary key default gen_random_uuid(),
  chatbot_id             uuid not null references chatbots(id) on delete cascade,
  type                   text not null,
  title                  text not null,
  description            text,
  tags                   text[] not null default '{}',
  resource_url           text,
  okf_version            text not null default '0.1',
  body_md                text not null,
  embedding              vector(1536),
  embedding_model        text,
  embedding_updated_at   timestamptz,
  is_active              boolean not null default true,
  created_by             text not null default 'human',
  approved_at            timestamptz,
  source_document_id     uuid references chatbot_documents(id) on delete set null,
  served_count           int not null default 0,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint okf_concepts_type_check check (type in (
    'Policy', 'PricingTable', 'OperatingInfo', 'Procedure', 'FAQ',
    'ProductSpec', 'SLADefinition', 'Glossary'
  )),
  constraint okf_concepts_created_by_check check (created_by in ('human', 'ai_suggested', 'ai_extracted')),
  constraint okf_concepts_title_len check (char_length(title) between 1 and 100),
  constraint okf_concepts_body_len check (char_length(body_md) between 1 and 10000)
);

create index if not exists idx_okf_concepts_chatbot
  on okf_concepts (chatbot_id) where is_active = true;
create index if not exists idx_okf_concepts_type
  on okf_concepts (chatbot_id, type) where is_active = true;
create index if not exists idx_okf_concepts_embedding
  on okf_concepts using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64)
  where is_active = true and approved_at is not null and embedding is not null;
create index if not exists idx_okf_concepts_pending
  on okf_concepts (chatbot_id, created_at desc)
  where approved_at is null and is_active = true;

create table if not exists okf_index (
  id              uuid primary key default gen_random_uuid(),
  chatbot_id      uuid not null references chatbots(id) on delete cascade unique,
  index_md        text not null,
  concept_count   int not null default 0,
  last_rebuilt_at timestamptz not null default now()
);

create table if not exists okf_audit_log (
  id               uuid primary key default gen_random_uuid(),
  chatbot_id       uuid not null,
  concept_id       uuid references okf_concepts(id) on delete set null,
  action           text not null,
  changed_by       text,
  change_summary   text,
  previous_body_md text,
  created_at       timestamptz not null default now(),
  constraint okf_audit_log_action_check check (action in (
    'created', 'updated', 'approved', 'deactivated', 'ai_suggested', 'restored'
  ))
);
create index if not exists idx_okf_audit_log_concept on okf_audit_log (concept_id, created_at desc);
create index if not exists idx_okf_audit_log_chatbot on okf_audit_log (chatbot_id, created_at desc);

create table if not exists okf_routing_log (
  id              uuid primary key default gen_random_uuid(),
  chatbot_id      uuid not null references chatbots(id) on delete cascade,
  concept_id      uuid references okf_concepts(id) on delete set null,
  matched         boolean not null,
  confidence      double precision,
  routing_method  text not null,
  created_at      timestamptz not null default now(),
  constraint okf_routing_log_method_check check (routing_method in (
    'exact_title', 'semantic', 'type_hint', 'rag', 'okf_fallback_rag'
  ))
);
create index if not exists idx_okf_routing_log_chatbot
  on okf_routing_log (chatbot_id, created_at desc);

alter table rag_evaluations add column if not exists okf_routed boolean not null default false;
alter table rag_evaluations add column if not exists okf_concept_id uuid references okf_concepts(id) on delete set null;
alter table rag_evaluations add column if not exists okf_confidence double precision;
alter table rag_evaluations add column if not exists routing_method text;

alter table document_ingestion_log add column if not exists okf_suggestion_cost_usd numeric(10,6);
alter table document_ingestion_log add column if not exists okf_suggestion_count int;

alter table alert_configs drop constraint if exists alert_configs_type_check;
alter table alert_configs add constraint alert_configs_type_check check (alert_type in (
  'grounding_failure_rate',
  'circuit_breaker_open',
  'ingest_queue_depth',
  'tenant_spend_90',
  'okf_stale'
));

insert into alert_configs (alert_type, enabled, threshold)
select 'okf_stale', true, 90
where not exists (select 1 from alert_configs where alert_type = 'okf_stale');

do $$
declare
  t text;
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app' and p.proname = 'is_privileged'
  ) then
    raise notice 'app.is_privileged() missing — apply db/rls.sql, then re-run this migration';
    return;
  end if;

  foreach t in array array['okf_concepts', 'okf_index', 'okf_audit_log', 'okf_routing_log'] loop
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

  if exists (select 1 from pg_roles where rolname = 'chatmate360_app') then
    grant select, insert, update, delete on okf_concepts, okf_index, okf_audit_log, okf_routing_log to chatmate360_app;
  end if;
end $$;
