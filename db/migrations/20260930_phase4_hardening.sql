-- Phase 4 (WP-4.1 through WP-4.6): security audit, pricing configs,
-- model routing, ingestion log, observability alerts.
-- Additive. Apply to both chatmate360 and chatmate360_test.

-- ---------------------------------------------------------------------------
-- WP-4.1 security audit
-- ---------------------------------------------------------------------------

create table if not exists security_audit_log (
  id            uuid primary key default gen_random_uuid(),
  event_type    text not null,
  user_id       uuid,
  chatbot_id    uuid,
  ip_address    inet,
  user_agent    text,
  request_path  text,
  details       jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  constraint security_audit_log_event_type_check check (event_type in (
    'unauthorized_access',
    'rls_violation',
    'admin_action',
    'webhook_signature_failed'
  ))
);
create index if not exists idx_security_audit_log_type on security_audit_log (event_type, created_at desc);
create index if not exists idx_security_audit_log_user on security_audit_log (user_id, created_at desc);
create index if not exists idx_security_audit_log_chatbot on security_audit_log (chatbot_id, created_at desc);

-- ---------------------------------------------------------------------------
-- WP-4.4 pricing configs (immutable after a grant — new row on change)
-- ---------------------------------------------------------------------------

create table if not exists pricing_configs (
  id                      uuid primary key default gen_random_uuid(),
  config_name             text not null,
  plan_type               text not null,
  price_usd               numeric(10,2) not null,
  stripe_percent          numeric(5,4) not null default 0.0290,
  stripe_fixed_usd        numeric(10,4) not null default 0.3000,
  platform_overhead_usd   numeric(10,4) not null default 0.5000,
  reserve_buffer_percent  numeric(5,4) not null default 0.0500,
  target_profit_percent   numeric(5,4) not null default 0.5200,
  computed_ai_credits     numeric(10,4) not null,
  stripe_price_id         text,
  is_active               boolean not null default true,
  effective_from          timestamptz not null default now(),
  created_at              timestamptz not null default now(),
  constraint pricing_configs_plan_type_check check (plan_type in ('subscription', 'topup')),
  constraint pricing_configs_credit_lt_price check (computed_ai_credits < price_usd)
);
create index if not exists idx_pricing_configs_name_active
  on pricing_configs (config_name, is_active, effective_from desc);

-- Seed defaults only when the table is empty so re-runs stay idempotent.
-- Credits = (price - stripe_fee - overhead) * (1 - reserve) * (1 - margin).
insert into pricing_configs (
  config_name, plan_type, price_usd, computed_ai_credits
)
select
  v.config_name,
  v.plan_type,
  v.price_usd,
  round(
    (v.price_usd - (v.price_usd * 0.0290 + 0.3000) - 0.5000)
    * (1 - 0.0500)
    * (1 - 0.5200)
  , 4)
from (values
  ('crawl_plus_monthly', 'subscription', 20.00),
  ('topup_starter',      'topup',        10.00),
  ('topup_standard',     'topup',        20.00),
  ('topup_growth',       'topup',        30.00),
  ('topup_scale',        'topup',        50.00)
) as v(config_name, plan_type, price_usd)
where not exists (select 1 from pricing_configs);

-- ---------------------------------------------------------------------------
-- WP-4.3 model routing + cost registry
-- ---------------------------------------------------------------------------

create table if not exists model_costs (
  id                        uuid primary key default gen_random_uuid(),
  provider                  text not null,
  model_id                  text not null,
  input_cost_per_1k_tokens  numeric(10,8) not null,
  output_cost_per_1k_tokens numeric(10,8) not null,
  context_window_tokens     int not null default 128000,
  is_available              boolean not null default true,
  effective_from            timestamptz not null default now(),
  created_at                timestamptz not null default now()
);
create unique index if not exists idx_model_costs_provider_model
  on model_costs (provider, model_id, effective_from desc);

insert into model_costs (provider, model_id, input_cost_per_1k_tokens, output_cost_per_1k_tokens, context_window_tokens)
select v.provider, v.model_id, v.input_cost, v.output_cost, v.ctx
from (values
  ('openai',    'gpt-4o-mini',         0.00015000, 0.00060000, 128000),
  ('anthropic', 'claude-sonnet-5',     0.00300000, 0.01500000, 200000),
  ('gemini',    'gemini-flash-latest', 0.00007500, 0.00030000, 1000000)
) as v(provider, model_id, input_cost, output_cost, ctx)
where not exists (select 1 from model_costs);

create table if not exists model_routing_configs (
  id                         uuid primary key default gen_random_uuid(),
  chatbot_id                 uuid not null references chatbots(id) on delete cascade,
  preferred_model            text not null default 'auto',
  fallback_chain             jsonb not null default '["gemini","openai","anthropic"]'::jsonb,
  cost_switching_enabled     boolean not null default true,
  cost_switching_threshold   numeric(3,2) not null default 0.20,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);
create unique index if not exists idx_model_routing_chatbot on model_routing_configs (chatbot_id);

-- ---------------------------------------------------------------------------
-- WP-4.6 ingestion log + progress columns
-- ---------------------------------------------------------------------------

alter table chatbot_documents add column if not exists ingest_stage text;
alter table chatbot_documents add column if not exists last_embedded_index int not null default 0;
alter table chatbot_documents add column if not exists extraction_method text;
alter table chatbot_documents add column if not exists ingest_progress_percent int not null default 0;

create table if not exists document_ingestion_log (
  id                      uuid primary key default gen_random_uuid(),
  document_id             uuid not null references chatbot_documents(id) on delete cascade,
  chatbot_id              uuid not null references chatbots(id) on delete cascade,
  status                  text not null,
  extraction_method       text,
  extracted_chars         int,
  chunk_count             int,
  embedding_tokens        int,
  embedding_cost_usd      numeric(10,6),
  embedding_model         text,
  scan_duration_ms        int,
  extraction_duration_ms  int,
  chunking_duration_ms    int,
  embedding_duration_ms   int,
  total_duration_ms       int,
  error                   text,
  created_at              timestamptz not null default now()
);
create index if not exists idx_document_ingestion_log_chatbot
  on document_ingestion_log (chatbot_id, created_at desc);
create index if not exists idx_document_ingestion_log_document
  on document_ingestion_log (document_id, created_at desc);

-- ---------------------------------------------------------------------------
-- WP-4.5 alerts + labeled eval store
-- ---------------------------------------------------------------------------

create table if not exists alert_configs (
  id          uuid primary key default gen_random_uuid(),
  alert_type  text not null unique,
  enabled     boolean not null default true,
  threshold   numeric(10,4),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint alert_configs_type_check check (alert_type in (
    'grounding_failure_rate',
    'circuit_breaker_open',
    'ingest_queue_depth',
    'tenant_spend_90'
  ))
);

insert into alert_configs (alert_type, enabled, threshold)
select v.alert_type, true, v.threshold
from (values
  ('grounding_failure_rate', 0.20),
  ('circuit_breaker_open',   null),
  ('ingest_queue_depth',     500),
  ('tenant_spend_90',        0.90)
) as v(alert_type, threshold)
where not exists (select 1 from alert_configs);

create table if not exists rag_evaluations (
  id                    uuid primary key default gen_random_uuid(),
  chatbot_id            uuid,
  pair_count            int not null,
  recall_at_5           numeric(6,4),
  recall_at_10          numeric(6,4),
  precision_at_5        numeric(6,4),
  mrr                   numeric(6,4),
  ndcg_at_10            numeric(6,4),
  citation_coverage     numeric(6,4),
  grounded_answer_rate  numeric(6,4),
  hallucination_rate    numeric(6,4),
  isolation_violations  int not null default 0,
  p50_ms                numeric(10,2),
  p95_ms                numeric(10,2),
  artifact_path         text,
  created_at            timestamptz not null default now()
);

create table if not exists alert_events (
  id           uuid primary key default gen_random_uuid(),
  alert_type   text not null,
  chatbot_id   uuid,
  payload      jsonb not null default '{}'::jsonb,
  delivered    boolean not null default false,
  created_at   timestamptz not null default now()
);
create index if not exists idx_alert_events_type on alert_events (alert_type, created_at desc);

-- CIRCUIT_OPEN is a Phase 4 routing reason.
alter table routing_events drop constraint if exists routing_events_reason_check;
alter table routing_events add constraint routing_events_reason_check check (reason in (
  'INITIAL_SELECTION', 'USER_SELECTED', 'QUOTA_SWITCH', 'COST_SWITCH',
  'PROVIDER_FAILURE', 'ADMIN_OVERRIDE', 'FALLBACK_DENIED', 'CIRCUIT_OPEN'
));

-- ---------------------------------------------------------------------------
-- RLS: privileged-only platform tables + chatbot-scoped new tables
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regclass('public.security_audit_log') is not null then
    execute 'alter table security_audit_log enable row level security';
    execute 'alter table security_audit_log force row level security';
    execute 'drop policy if exists security_audit_log_isolation on security_audit_log';
    execute $p$create policy security_audit_log_isolation on security_audit_log
      using (app.is_privileged()) with check (app.is_privileged())$p$;
  end if;

  if to_regclass('public.pricing_configs') is not null then
    execute 'alter table pricing_configs enable row level security';
    execute 'alter table pricing_configs force row level security';
    execute 'drop policy if exists pricing_configs_isolation on pricing_configs';
    execute $p$create policy pricing_configs_isolation on pricing_configs
      using (app.is_privileged()) with check (app.is_privileged())$p$;
  end if;

  if to_regclass('public.model_costs') is not null then
    execute 'alter table model_costs enable row level security';
    execute 'alter table model_costs force row level security';
    execute 'drop policy if exists model_costs_isolation on model_costs';
    execute $p$create policy model_costs_isolation on model_costs
      using (app.is_privileged()) with check (app.is_privileged())$p$;
  end if;

  if to_regclass('public.alert_configs') is not null then
    execute 'alter table alert_configs enable row level security';
    execute 'alter table alert_configs force row level security';
    execute 'drop policy if exists alert_configs_isolation on alert_configs';
    execute $p$create policy alert_configs_isolation on alert_configs
      using (app.is_privileged()) with check (app.is_privileged())$p$;
  end if;

  if to_regclass('public.alert_events') is not null then
    execute 'alter table alert_events enable row level security';
    execute 'alter table alert_events force row level security';
    execute 'drop policy if exists alert_events_isolation on alert_events';
    execute $p$create policy alert_events_isolation on alert_events
      using (app.is_privileged()) with check (app.is_privileged())$p$;
  end if;

  if to_regclass('public.rag_evaluations') is not null then
    execute 'alter table rag_evaluations enable row level security';
    execute 'alter table rag_evaluations force row level security';
    execute 'drop policy if exists rag_evaluations_isolation on rag_evaluations';
    execute $p$create policy rag_evaluations_isolation on rag_evaluations
      using (app.is_privileged()) with check (app.is_privileged())$p$;
  end if;
end $$;

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

  foreach t in array array['model_routing_configs', 'document_ingestion_log'] loop
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
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'chatmate360_app') then
    grant select, insert, update, delete on
      security_audit_log, pricing_configs, model_costs, model_routing_configs,
      document_ingestion_log, alert_configs, alert_events, rag_evaluations
      to chatmate360_app;
  end if;
end $$;
