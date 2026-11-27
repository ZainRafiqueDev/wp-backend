

create extension if not exists pgcrypto;


create table if not exists users (
    id            uuid primary key default gen_random_uuid(),
    email         text not null unique,
    password_hash text,
    google_id     text unique,
    name          text not null,
    created_at    timestamptz not null default now(),

    constraint users_has_login_method check (password_hash is not null or google_id is not null)
);

create index if not exists idx_users_email on users (email);

alter table users add column if not exists trial_started_at timestamptz not null default now();
alter table users add column if not exists is_active boolean not null default true;
-- Distinct from is_active (which is admin-controlled — see admin.service.ts)
-- on purpose: this flips true automatically the first time the answering
-- gate detects an expired, unpaid trial (accessGate.service.ts), and
-- clears automatically on a successful paid subscription (billing.service.ts)
-- — an admin deactivation must never be undone just by the user paying, so
-- the two reasons need separate flags, not one shared boolean.
alter table users add column if not exists trial_deactivated boolean not null default false;

-- Existing rows stay usable (default true). Password signup sets false explicitly.
alter table users add column if not exists email_verified boolean not null default true;
alter table users add column if not exists auto_purchase_enabled boolean not null default false;
alter table users add column if not exists auto_purchase_model text;

create table if not exists email_verification_tokens (
    id         uuid primary key default gen_random_uuid(),
    user_id    uuid not null references users(id) on delete cascade,
    token_hash text not null unique,
    expires_at timestamptz not null,
    created_at timestamptz not null default now()
);
create index if not exists idx_email_verification_tokens_user_id on email_verification_tokens (user_id);

create table if not exists password_reset_tokens (
    id         uuid primary key default gen_random_uuid(),
    user_id    uuid not null references users(id) on delete cascade,
    token_hash text not null unique,
    expires_at timestamptz not null,
    created_at timestamptz not null default now()
);
create index if not exists idx_password_reset_tokens_user_id on password_reset_tokens (user_id);
alter table password_reset_tokens add column if not exists used_at timestamptz;

create table if not exists notifications (
    id         uuid primary key default gen_random_uuid(),
    user_id    uuid not null references users(id) on delete cascade,
    type       text not null,
    title      text not null,
    body       text not null,
    metadata   jsonb not null default '{}',
    read_at    timestamptz,
    created_at timestamptz not null default now(),

    constraint notifications_type_check check (type in (
        'usage_limit', 'payment', 'subscription', 'handoff', 'auto_purchase', 'system', 'email_verification'
    ))
);
create index if not exists idx_notifications_user_created on notifications (user_id, created_at desc);


create table if not exists refresh_tokens (
    id         uuid primary key default gen_random_uuid(),
    user_id    uuid not null references users(id) on delete cascade,
    token_hash text not null unique,
    expires_at timestamptz not null,
    created_at timestamptz not null default now()
);

create index if not exists idx_refresh_tokens_user_id on refresh_tokens (user_id);


create table if not exists chatbots (
    id              uuid primary key default gen_random_uuid(),
    user_id         uuid not null references users(id) on delete cascade,
    name            text not null,
    sources         jsonb not null default '[]',
    theme           jsonb not null default '{"primaryColor":"#769656","bgColor":"#ffffff","textColor":"#1f2937"}',
    allowed_domain  text,
    created_at      timestamptz not null default now()
);


alter table chatbots add column if not exists status text not null default 'ready';
alter table chatbots add column if not exists status_reason text;
alter table chatbots add column if not exists fallback_message text;

alter table chatbots add column if not exists website_url text;
alter table chatbots add column if not exists is_active boolean not null default true;


alter table chatbots add column if not exists preferred_model text;

-- WP-1.5: optional per-chatbot ingest overrides. NULL = env / Crawl Plus default.
alter table chatbots add column if not exists max_documents integer;
alter table chatbots add column if not exists max_bytes bigint;
alter table chatbots add column if not exists max_chunks integer;
alter table chatbots drop constraint if exists chatbots_max_documents_positive;
alter table chatbots add constraint chatbots_max_documents_positive
  check (max_documents is null or max_documents > 0);
alter table chatbots drop constraint if exists chatbots_max_bytes_positive;
alter table chatbots add constraint chatbots_max_bytes_positive
  check (max_bytes is null or max_bytes > 0);
alter table chatbots drop constraint if exists chatbots_max_chunks_positive;
alter table chatbots add constraint chatbots_max_chunks_positive
  check (max_chunks is null or max_chunks > 0);


alter table chatbots drop constraint if exists chatbots_user_id_key;
create index if not exists idx_chatbots_user_id on chatbots (user_id);

create index if not exists idx_chatbots_website_url on chatbots (website_url) where website_url is not null;

do $$
begin
    if not exists (
        select 1 from pg_constraint where conname = 'chatbots_status_check'
    ) then
        alter table chatbots add constraint chatbots_status_check
            check (status in ('queued', 'crawling', 'processing', 'ready', 'failed'));
    end if;
end $$;


create table if not exists chatbot_live_data (
    id          uuid primary key default gen_random_uuid(),
    chatbot_id  uuid not null references chatbots(id) on delete cascade,
    key         text not null,
    value       text not null,
    updated_at  timestamptz not null default now(),

    constraint chatbot_live_data_key_len check (char_length(key) between 1 and 200),
    constraint chatbot_live_data_value_len check (char_length(value) between 1 and 2000)
);

create index if not exists idx_chatbot_live_data_chatbot_id on chatbot_live_data (chatbot_id);

create unique index if not exists idx_chatbot_live_data_chatbot_key on chatbot_live_data (chatbot_id, lower(key));


create table if not exists waitlist (
    id         uuid primary key default gen_random_uuid(),
    email      text not null unique,
    created_at timestamptz not null default now()
);

create table if not exists trial_signups (
    id         uuid primary key default gen_random_uuid(),
    name       text not null,
    email      text not null,
    company    text,
    plan       text,
    created_at timestamptz not null default now()
);

create table if not exists contact_submissions (
    id         uuid primary key default gen_random_uuid(),
    name       text not null,
    email      text not null,
    message    text not null,
    created_at timestamptz not null default now()
);


create table if not exists chatbot_integrations (
    id                uuid primary key default gen_random_uuid(),
    chatbot_id        uuid not null unique references chatbots(id) on delete cascade,
    api_key_encrypted text not null,
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now()
);

alter table chatbot_integrations add column if not exists api_base_url text;
alter table chatbot_integrations add column if not exists contract_version text not null default 'v1';


create table if not exists chatbot_actions (
    id               uuid primary key default gen_random_uuid(),
    chatbot_id       uuid not null references chatbots(id) on delete cascade,
    name             text not null,
    description      text not null,
    http_method      text not null,
    url_template     text not null,
    headers_template jsonb not null default '{}',
    body_template    jsonb,
    parameters       jsonb not null default '[]',
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),

    constraint chatbot_actions_name_format check (name ~ '^[a-z][a-z0-9_]{0,63}$'),
    constraint chatbot_actions_http_method check (http_method in ('GET', 'POST', 'PUT', 'PATCH', 'DELETE'))
);

create index if not exists idx_chatbot_actions_chatbot_id on chatbot_actions (chatbot_id);

create unique index if not exists idx_chatbot_actions_chatbot_name on chatbot_actions (chatbot_id, name);


create table if not exists subscriptions (
    id                      uuid primary key default gen_random_uuid(),
    user_id                 uuid not null unique references users(id) on delete cascade,
    stripe_customer_id      text not null,
    stripe_subscription_id  text,
    plan                    text not null default 'free',
    status                  text not null default 'inactive',
    current_period_end      timestamptz,
    created_at              timestamptz not null default now(),
    updated_at              timestamptz not null default now(),

    constraint subscriptions_plan_check check (plan in ('free', 'crawl_plus', 'full_custom')),
    constraint subscriptions_status_check
        check (status in ('inactive', 'trialing', 'active', 'past_due', 'canceled', 'unpaid'))
);


alter table subscriptions drop constraint if exists subscriptions_plan_check;
update subscriptions set plan = 'crawl_plus' where plan in ('starter', 'growth');
update subscriptions set plan = 'full_custom' where plan = 'business';
do $$
begin
    if not exists (
        select 1 from pg_constraint where conname = 'subscriptions_plan_check'
    ) then
        alter table subscriptions add constraint subscriptions_plan_check
            check (plan in ('free', 'crawl_plus', 'full_custom'));
    end if;
end $$;

create unique index if not exists idx_subscriptions_stripe_customer on subscriptions (stripe_customer_id);

create index if not exists idx_subscriptions_stripe_subscription on subscriptions (stripe_subscription_id);


create table if not exists chatbot_usage (
    id             uuid primary key default gen_random_uuid(),
    chatbot_id     uuid not null references chatbots(id) on delete cascade,
    billing_period text not null,
    input_tokens   bigint not null default 0,
    output_tokens  bigint not null default 0,
    estimated_cost numeric(12, 6) not null default 0,
    updated_at     timestamptz not null default now(),

    constraint chatbot_usage_period_unique unique (chatbot_id, billing_period)
);

create index if not exists idx_chatbot_usage_chatbot_id on chatbot_usage (chatbot_id);


alter table chatbot_usage add column if not exists model text;
alter table chatbot_usage drop constraint if exists chatbot_usage_period_unique;
do $$
begin
    if not exists (
        select 1 from pg_constraint where conname = 'chatbot_usage_period_model_unique'
    ) then
        alter table chatbot_usage add constraint chatbot_usage_period_model_unique
            unique (chatbot_id, billing_period, model);
    end if;
end $$;


create table if not exists chatbot_model_credits (
    id                          uuid primary key default gen_random_uuid(),
    chatbot_id                  uuid not null references chatbots(id) on delete cascade,
    billing_period              text not null,
    model                       text not null,
    credited_usd                numeric(12, 6) not null,
    stripe_checkout_session_id  text not null unique,
    created_at                  timestamptz not null default now()
);

create index if not exists idx_chatbot_model_credits_lookup
    on chatbot_model_credits (chatbot_id, billing_period, model);


create table if not exists admin_users (
    id            uuid primary key default gen_random_uuid(),
    email         text not null unique,
    password_hash text not null,
    name          text not null,
    created_at    timestamptz not null default now()
);

create index if not exists idx_admin_users_email on admin_users (email);


create table if not exists admin_audit_log (
    id             uuid primary key default gen_random_uuid(),
    admin_user_id  uuid references admin_users(id) on delete set null,
    action         text not null,
    target_user_id uuid references users(id) on delete set null,
    detail         jsonb not null default '{}',
    created_at     timestamptz not null default now()
);

create index if not exists idx_admin_audit_log_admin_user_id on admin_audit_log (admin_user_id);
create index if not exists idx_admin_audit_log_target_user_id on admin_audit_log (target_user_id);
create index if not exists idx_admin_audit_log_created_at on admin_audit_log (created_at desc);


create table if not exists chatbot_abuse_flags (
    id               uuid primary key default gen_random_uuid(),
    chatbot_id       uuid not null references chatbots(id) on delete cascade,
    reason           text not null,
    detail           jsonb not null default '{}',
    auto_deactivated boolean not null default false,
    reviewed         boolean not null default false,
    created_at       timestamptz not null default now()
);

create index if not exists idx_chatbot_abuse_flags_chatbot_id on chatbot_abuse_flags (chatbot_id);
create index if not exists idx_chatbot_abuse_flags_unreviewed on chatbot_abuse_flags (reviewed) where not reviewed;


create table if not exists conversations (
    id            uuid primary key default gen_random_uuid(),
    chatbot_id    uuid not null references chatbots(id) on delete cascade,
    session_id    text not null,
    summary       text,
    turn_count    integer not null default 0,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now(),

    constraint conversations_chatbot_session_unique unique (chatbot_id, session_id)
);

create index if not exists idx_conversations_chatbot_id on conversations (chatbot_id);


alter table conversations add column if not exists pinned_model text;

create table if not exists messages (
    id              uuid primary key default gen_random_uuid(),
    conversation_id uuid not null references conversations(id) on delete cascade,
    role            text not null,
    content         text not null,
    created_at      timestamptz not null default now(),

    constraint messages_role_check check (role in ('user', 'assistant'))
);

create index if not exists idx_messages_conversation_id_created_at on messages (conversation_id, created_at);



create extension if not exists vector;

create table if not exists chatbot_woocommerce_credentials (
    id                         uuid primary key default gen_random_uuid(),
    chatbot_id                 uuid not null unique references chatbots(id) on delete cascade,
    store_url                  text not null,
    consumer_key_encrypted     text not null,
    consumer_secret_encrypted  text not null,
    webhook_secret_encrypted   text not null,
    created_at                 timestamptz not null default now()
);

create table if not exists customer_identities (
    id                       uuid primary key default gen_random_uuid(),
    chatbot_id               uuid not null references chatbots(id) on delete cascade,
    email                    text,
    phone                    text,
    woocommerce_customer_id  text,
    verification_level       text not null default 'UNVERIFIED',
    created_at               timestamptz not null default now(),

    constraint customer_identities_verification_level_check
        check (verification_level in ('UNVERIFIED', 'EMAIL_VERIFIED', 'ORDER_VERIFIED', 'ACCOUNT_VERIFIED'))
);
create index if not exists idx_customer_identities_chatbot_id on customer_identities (chatbot_id);

create index if not exists idx_customer_identities_chatbot_email
    on customer_identities (chatbot_id, email) where email is not null;

-- Purpose-based email OTPs. Auth authority stays in Express — FastAPI/AI
-- may request verification, but only this table + Express can mark success.
-- PASSWORD_RESET is intentionally excluded: use high-entropy reset tokens.
create table if not exists auth_otps (
    id            uuid primary key default gen_random_uuid(),
    email         text not null,
    otp_hash      text not null,
    purpose       text not null,
    expires_at    timestamptz not null,
    attempts      integer not null default 0,
    max_attempts  integer not null default 5,
    verified_at   timestamptz,
    user_id       uuid references users(id) on delete cascade,
    chatbot_id    uuid references chatbots(id) on delete cascade,
    customer_id   uuid references customer_identities(id) on delete cascade,
    created_at    timestamptz not null default now(),

    constraint auth_otps_purpose_check check (purpose in (
        'EMAIL_VERIFY', 'ORDER_ACCESS', 'SENSITIVE_ACTION'
    ))
);
create index if not exists idx_auth_otps_lookup
    on auth_otps (email, purpose, created_at desc);
create index if not exists idx_auth_otps_expires on auth_otps (expires_at)
    where verified_at is null;

create table if not exists commerce_orders (
    id                    uuid primary key default gen_random_uuid(),
    chatbot_id            uuid not null references chatbots(id) on delete cascade,
    customer_id           uuid not null references customer_identities(id) on delete restrict,
    woocommerce_order_id  text not null,
   
    idempotency_key       text not null,
    booking_number        text,
    status                text not null default 'DRAFT',
    
    operational_status    text,
    order_snapshot        jsonb not null,
    created_at            timestamptz not null default now(),
    paid_at               timestamptz,
    fulfilled_at          timestamptz,

    constraint commerce_orders_status_check
        check (status in ('DRAFT', 'PENDING_PAYMENT', 'PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED')),
    constraint commerce_orders_operational_status_check
        check (operational_status is null or operational_status in
            ('PAYMENT_VERIFICATION_PENDING', 'PAYMENT_VERIFICATION_FAILED', 'SYNC_ERROR', 'INTEGRATION_ERROR')),
    constraint commerce_orders_chatbot_wc_order_unique unique (chatbot_id, woocommerce_order_id)
);

alter table commerce_orders add column if not exists idempotency_key text;
update commerce_orders set idempotency_key = 'legacy:' || id::text where idempotency_key is null;
alter table commerce_orders alter column idempotency_key set not null;
do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'commerce_orders_chatbot_idempotency_key_unique') then
        alter table commerce_orders add constraint commerce_orders_chatbot_idempotency_key_unique
            unique (chatbot_id, idempotency_key);
    end if;
end $$;
create index if not exists idx_commerce_orders_chatbot_id on commerce_orders (chatbot_id);
create index if not exists idx_commerce_orders_customer_id on commerce_orders (customer_id);

create unique index if not exists idx_commerce_orders_booking_number_unique
    on commerce_orders (chatbot_id, booking_number) where booking_number is not null;

create table if not exists commerce_tickets (
    id                uuid primary key default gen_random_uuid(),
    chatbot_id        uuid not null references chatbots(id) on delete cascade,
    customer_id       uuid not null references customer_identities(id) on delete restrict,
    subject           text not null,
    status            text not null default 'OPEN',
    related_order_id  uuid references commerce_orders(id) on delete set null,
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now(),

    constraint commerce_tickets_status_check check (status in ('OPEN', 'RESOLVED', 'CLOSED'))
);
create index if not exists idx_commerce_tickets_chatbot_id on commerce_tickets (chatbot_id);
create index if not exists idx_commerce_tickets_customer_id on commerce_tickets (customer_id);

create table if not exists product_catalog_cache (
    id                       uuid primary key default gen_random_uuid(),
    chatbot_id               uuid not null references chatbots(id) on delete cascade,
    woocommerce_product_id   text not null,
    name                     text not null,
    description              text,
    price                    numeric(12, 2),
    stock_quantity           integer,
   
    embedding                vector(1536),
    last_synced_at           timestamptz not null default now(),

    constraint product_catalog_cache_chatbot_product_unique unique (chatbot_id, woocommerce_product_id)
);
alter table product_catalog_cache add column if not exists embedding_model text;
alter table product_catalog_cache add column if not exists embedding_dim int;
create index if not exists idx_product_catalog_cache_chatbot_id on product_catalog_cache (chatbot_id);
-- WP-1.4: cosine ANN for product lookup. Production: CONCURRENTLY migration.
create index if not exists idx_product_catalog_cache_embedding_hnsw
    on product_catalog_cache
    using hnsw (embedding vector_cosine_ops)
    with (m = 16, ef_construction = 64)
    where embedding is not null;
create index if not exists idx_product_catalog_cache_embedding_identity
    on product_catalog_cache (chatbot_id, embedding_model, embedding_dim)
    where embedding_model is not null;



alter table product_catalog_cache add column if not exists image_url text;
alter table product_catalog_cache add column if not exists product_url text;



create table if not exists commerce_webhook_events (
    id                 uuid primary key default gen_random_uuid(),
    chatbot_id         uuid not null references chatbots(id) on delete cascade,
    provider_event_id  text not null,
    event_type         text not null,
    payload            jsonb not null,
    received_at        timestamptz not null default now(),
    processed_at       timestamptz,

    constraint commerce_webhook_events_chatbot_event_unique unique (chatbot_id, provider_event_id)
);
-- The BullMQ worker job (src/services/commerceWebhookProcessing.service.ts)
-- polls for exactly these rows.
create index if not exists idx_commerce_webhook_events_unprocessed
    on commerce_webhook_events (received_at) where processed_at is null;

create table if not exists customer_notifications (
    id            uuid primary key default gen_random_uuid(),
    chatbot_id    uuid not null references chatbots(id) on delete cascade,
    customer_id   uuid not null references customer_identities(id) on delete cascade,
    order_id      uuid references commerce_orders(id) on delete cascade,
    type          text not null,
    payload       jsonb not null,
    delivered_at  timestamptz
);
create index if not exists idx_customer_notifications_undelivered
    on customer_notifications (customer_id) where delivered_at is null;




create table if not exists chatbot_bookly_credentials (
    id                     uuid primary key default gen_random_uuid(),
    chatbot_id             uuid not null unique references chatbots(id) on delete cascade,
    base_url               text not null,
    resource_id            text not null,
    resource_label         text not null,
    api_key_encrypted      text not null,
    created_at             timestamptz not null default now()
);

create table if not exists chatbot_bookly_appointments (
    id                     uuid primary key default gen_random_uuid(),
    chatbot_id             uuid not null references chatbots(id) on delete cascade,
    customer_id            uuid not null references customer_identities(id) on delete restrict,
    bookly_appointment_id  text not null,
    idempotency_key        text not null,
    bookly_resource_id     text not null,
    start_time             timestamptz not null,
    status                 text not null default 'PENDING',
    created_at             timestamptz not null default now(),
    cancelled_at           timestamptz,

    constraint chatbot_bookly_appointments_status_check
        check (status in ('PENDING', 'CONFIRMED', 'CANCELLED', 'FAILED')),
    constraint chatbot_bookly_appointments_chatbot_idempotency_key_unique
        unique (chatbot_id, idempotency_key)
);
create index if not exists idx_chatbot_bookly_appointments_chatbot_id on chatbot_bookly_appointments (chatbot_id);
create index if not exists idx_chatbot_bookly_appointments_customer_id on chatbot_bookly_appointments (customer_id);


alter table chatbot_bookly_appointments add column if not exists google_meet_url text;
alter table chatbot_bookly_appointments add column if not exists zoom_join_url text;


create table if not exists chatbot_bookly_admin_audit_log (
    id                uuid primary key default gen_random_uuid(),
    chatbot_id        uuid not null references chatbots(id) on delete cascade,
    admin_id          text not null,
    admin_email       text not null,
    conversation_id   text not null,
    request_id        text,
    action            text not null,
    target_resource   text,
    before_state      jsonb,
    after_state       jsonb,
    success           boolean not null,
    error_message     text,
    created_at        timestamptz not null default now()
);
create index if not exists idx_chatbot_bookly_admin_audit_log_chatbot_id on chatbot_bookly_admin_audit_log (chatbot_id, created_at desc);


create table if not exists chatbot_documents (
    id             uuid primary key default gen_random_uuid(),
    chatbot_id     uuid not null references chatbots(id) on delete cascade,
    file_name      text not null,
    file_type      text not null,
    file_size      integer not null,
    status         text not null default 'processing',
    error_message  text,
    chunk_count    integer not null default 0,
    created_at     timestamptz not null default now(),

    constraint chatbot_documents_status_check check (status in ('processing', 'ready', 'failed'))
);
alter table chatbot_documents add column if not exists storage_key text;
alter table chatbot_documents add column if not exists page_count integer;
alter table chatbot_documents add column if not exists bytes bigint;
alter table chatbot_documents add column if not exists updated_at timestamptz not null default now();
alter table chatbot_documents add column if not exists scan_status text;
alter table chatbot_documents add column if not exists scan_vendor text;
alter table chatbot_documents add column if not exists scanned_at timestamptz;
alter table chatbot_documents drop constraint if exists chatbot_documents_scan_status_check;
alter table chatbot_documents add constraint chatbot_documents_scan_status_check
  check (scan_status is null or scan_status in ('pending', 'clean', 'denied', 'error'));
create index if not exists idx_chatbot_documents_chatbot_id on chatbot_documents (chatbot_id, created_at desc);
create index if not exists idx_chatbot_documents_processing_updated
  on chatbot_documents (updated_at) where status = 'processing';
-- Covers COUNT/SUM(file_size)/SUM(chunk_count) used by ingest caps (WP-1.5).
create index if not exists idx_chatbot_documents_ingest_usage
  on chatbot_documents (chatbot_id) include (file_size, chunk_count);

create table if not exists chatbot_document_chunks (
    id           uuid primary key default gen_random_uuid(),
    document_id  uuid not null references chatbot_documents(id) on delete cascade,
    chatbot_id   uuid not null references chatbots(id) on delete cascade,
    content      text not null,
    embedding    vector(1536),
    created_at   timestamptz not null default now()
);
alter table chatbot_document_chunks add column if not exists content_tsv tsvector;
alter table chatbot_document_chunks add column if not exists heading text;
alter table chatbot_document_chunks add column if not exists source_type text;
alter table chatbot_document_chunks add column if not exists embedding_model text;
alter table chatbot_document_chunks add column if not exists embedding_dim int;
create index if not exists idx_chatbot_document_chunks_chatbot_id on chatbot_document_chunks (chatbot_id);
create index if not exists idx_chatbot_document_chunks_document_id on chatbot_document_chunks (document_id);
create index if not exists idx_chatbot_document_chunks_content_tsv
  on chatbot_document_chunks using gin (content_tsv)
  where content_tsv is not null;
-- WP-1.4: cosine ANN. Production builds this CONCURRENTLY
-- (db/migrations/20260927_pgvector_hnsw.sql) outside a transaction.
create index if not exists idx_chatbot_document_chunks_embedding_hnsw
    on chatbot_document_chunks
    using hnsw (embedding vector_cosine_ops)
    with (m = 16, ef_construction = 64)
    where embedding is not null;
create index if not exists idx_chatbot_document_chunks_embedding_identity
    on chatbot_document_chunks (chatbot_id, embedding_model, embedding_dim)
    where embedding_model is not null;

create table if not exists embedding_usage_daily (
    user_id      uuid not null references users(id) on delete cascade,
    usage_day    date not null,
    call_count   integer not null default 0,
    token_count  bigint not null default 0,
    cost_usd     numeric(18, 12) not null default 0,
    primary key (user_id, usage_day)
);


create table if not exists chatbot_bookly_additional_resources (
    id               uuid primary key default gen_random_uuid(),
    chatbot_id       uuid not null references chatbots(id) on delete cascade,
    resource_id      text not null,
    resource_label   text not null,
    created_at       timestamptz not null default now(),

    constraint chatbot_bookly_additional_resources_unique unique (chatbot_id, resource_id)
);
create index if not exists idx_chatbot_bookly_additional_resources_chatbot_id on chatbot_bookly_additional_resources (chatbot_id);

create table if not exists auto_purchase_events (
    id           uuid primary key default gen_random_uuid(),
    user_id      uuid not null references users(id) on delete cascade,
    chatbot_id   uuid not null references chatbots(id) on delete cascade,
    model        text not null,
    status       text not null,
    detail       text,
    created_at   timestamptz not null default now(),

    constraint auto_purchase_events_status_check check (status in ('attempted', 'succeeded', 'failed', 'skipped'))
);
create index if not exists idx_auto_purchase_events_chatbot on auto_purchase_events (chatbot_id, created_at desc);


-- Token/cost allocation system (tokenallocation.md) — durable reservation
-- ledger. Written BEFORE the Redis fast-path check on every reservation
-- attempt (not after), so a reservation can always be recovered/expired
-- from this table even if Redis is flushed or the process crashes between
-- reserving and reconciling. request_id is the idempotency key: a retried
-- request with the same request_id reads back this row instead of
-- reserving/charging a second time.
create table if not exists reservations (
    id                  uuid primary key default gen_random_uuid(),
    request_id          text not null,
    chatbot_id          uuid references chatbots(id) on delete cascade,
    model               text not null,
    scope               text not null default 'tenant',
    reserved_micro_usd  bigint not null,
    actual_micro_usd    bigint,
    status              text not null default 'held',
    created_at          timestamptz not null default now(),
    expires_at          timestamptz not null,
    reconciled_at       timestamptz,

    constraint reservations_scope_check check (scope in ('tenant', 'platform')),
    constraint reservations_status_check check (status in ('held', 'reconciled', 'expired'))
);

do $$
begin
    if not exists (
        select 1 from pg_constraint where conname = 'reservations_request_id_unique'
    ) then
        alter table reservations add constraint reservations_request_id_unique unique (request_id);
    end if;
end $$;

-- Partial index: only ever scanned by the orphan-recovery sweep, which only
-- cares about rows still 'held' — reconciled/expired rows never match it.
create index if not exists idx_reservations_status_expires
    on reservations (status, expires_at) where status = 'held';


-- Per-request routing decisions, so QUOTA_SWITCH / COST_SWITCH /
-- PROVIDER_FAILURE / ADMIN_OVERRIDE are distinguishable after the fact
-- (previously only ever existed as an ad-hoc log field, never persisted —
-- see modelSelection.service.ts / ai.ts).
create table if not exists routing_events (
    id                   uuid primary key default gen_random_uuid(),
    request_id           text not null,
    chatbot_id           uuid not null references chatbots(id) on delete cascade,
    conversation_id      uuid references conversations(id) on delete set null,
    previous_model       text,
    selected_model       text not null,
    reason               text not null,
    provider_error_class text,
    created_at           timestamptz not null default now(),

    constraint routing_events_reason_check check (reason in (
        'INITIAL_SELECTION', 'USER_SELECTED', 'QUOTA_SWITCH', 'COST_SWITCH',
        'PROVIDER_FAILURE', 'ADMIN_OVERRIDE', 'FALLBACK_DENIED'
    ))
);
create index if not exists idx_routing_events_chatbot_created
    on routing_events (chatbot_id, created_at desc);


-- Pure dedup ledger for usage-threshold alerting (80/90/100%) — one row per
-- (chatbot, model, billing_period, window, threshold) ever sent, so a
-- threshold is never re-alerted twice within the same period. Scoped by
-- model (not just chatbot) because enforcement itself is per-model.
create table if not exists usage_alerts_sent (
    chatbot_id      uuid not null references chatbots(id) on delete cascade,
    model           text not null,
    billing_period  text not null,
    usage_window    text not null,
    threshold       integer not null,
    sent_at         timestamptz not null default now(),

    constraint usage_alerts_sent_window_check check (usage_window in ('day', 'week', 'month')),
    constraint usage_alerts_sent_threshold_check check (threshold in (80, 90, 100)),
    primary key (chatbot_id, model, billing_period, usage_window, threshold)
);

-- Existing installs (table already created without `model` before this
-- column existed): add it and widen the primary key to include it.
alter table usage_alerts_sent add column if not exists model text not null default 'unknown';
do $$
begin
    if exists (select 1 from pg_constraint where conname = 'usage_alerts_sent_pkey')
       and not exists (
           select 1 from pg_constraint
           where conname = 'usage_alerts_sent_pkey' and pg_get_constraintdef(oid) like '%model%'
       )
    then
        alter table usage_alerts_sent drop constraint usage_alerts_sent_pkey;
        alter table usage_alerts_sent add constraint usage_alerts_sent_pkey
            primary key (chatbot_id, model, billing_period, usage_window, threshold);
    end if;
end $$;
alter table usage_alerts_sent alter column model drop default;


-- Per-tenant entitlement overrides — what makes a Full Custom contract
-- configuration rather than a separate code path (tokenallocation.md).
-- Null means "use the plan default from plans.ts"; a non-null value here
-- always wins. custom_allowed_models overrides the whole list at once
-- (not merged) to keep "what is this tenant actually allowed to use"
-- unambiguous from a single glance at one row.
alter table subscriptions add column if not exists custom_daily_cap_usd numeric(12, 6);
alter table subscriptions add column if not exists custom_weekly_cap_usd numeric(12, 6);
alter table subscriptions add column if not exists custom_monthly_cap_usd numeric(12, 6);
alter table subscriptions add column if not exists custom_limit_action text;
alter table subscriptions add column if not exists custom_allowed_models jsonb;
alter table subscriptions add column if not exists activated_by uuid references admin_users(id) on delete set null;
alter table subscriptions add column if not exists activated_at timestamptz;

do $$
begin
    if not exists (
        select 1 from pg_constraint where conname = 'subscriptions_custom_limit_action_check'
    ) then
        alter table subscriptions add constraint subscriptions_custom_limit_action_check
            check (custom_limit_action is null or custom_limit_action in (
                'BLOCK', 'ROUTE_TO_CHEAPER_MODEL', 'USE_OVERAGE', 'ADMIN_OVERRIDE'
            ));
    end if;
end $$;


-- Full Custom plan leads (replaces self-service Stripe checkout for that
-- plan — see lead.service.ts). user_id is nullable: an anonymous public
-- pricing-page visitor can submit without an account; on delete set null
-- rather than cascade, since a lead record is a sales artifact that should
-- outlive the account row it happened to be attached to.
create table if not exists leads (
    id                 uuid primary key default gen_random_uuid(),
    user_id            uuid references users(id) on delete set null,
    name               text not null,
    email              text not null,
    phone              text not null,
    selected_bots      jsonb not null default '[]',
    status             text not null default 'lead',
    calendly_event_uri text,
    created_at         timestamptz not null default now(),
    updated_at         timestamptz not null default now(),

    constraint leads_status_check check (status in ('lead', 'booked'))
);
-- Partial index: only ever scanned to find "the account's current active
-- lead", so rows already booked never need to be indexed for this lookup.
create index if not exists idx_leads_user_active on leads (user_id) where status = 'lead';
create index if not exists idx_leads_email on leads (lower(email));

-- Populated from the Calendly webhook's scheduled_event when a lead books —
-- lets the dashboard "your meeting" reminder page show an actual date
-- instead of just a bare "booked" flag. Both nullable: older rows (booked
-- before this existed) or a webhook payload missing scheduled_event still
-- flip status to 'booked' fine, just without a displayable time.
alter table leads add column if not exists meeting_starts_at timestamptz;
alter table leads add column if not exists meeting_name text;

-- WP-1.3 Stripe webhook inbox. Signature is verified before insert. The
-- unique event id makes Stripe retries one row. processed_at is set only
-- after processStripeWebhookEvent succeeds. Grants stay exactly-once via
-- existing checkout-session unique keys, not this table.
create table if not exists stripe_webhook_events (
    stripe_event_id text primary key,
    type            text not null,
    payload         jsonb not null,
    received_at     timestamptz not null default now(),
    last_attempt_at timestamptz,
    processed_at    timestamptz,
    attempts        integer not null default 0,
    last_error      text
);
alter table stripe_webhook_events add column if not exists last_attempt_at timestamptz;
-- CS-13: single-processor claim lease (db/migrations/20261115_stripe_webhook_claim.sql).
alter table stripe_webhook_events add column if not exists locked_until timestamptz;
create index if not exists idx_stripe_webhook_events_unprocessed
    on stripe_webhook_events (received_at)
    where processed_at is null;

-- Cross-session customer memory. customer_identifier is always a hash of
-- "<chatbotId>:<lowercased email>" (hashToken in notification.service.ts),
-- never a plain email. See db/migrations/20260928_session_summaries.sql.
create table if not exists session_summaries (
    id                                uuid primary key default gen_random_uuid(),
    chatbot_id                        uuid not null references chatbots(id) on delete cascade,
    customer_identifier               text not null,
    summary_md                        text not null,
    token_count                       integer not null default 0,
    interrupted_by_credit_exhaustion  boolean not null default false,
    created_at                        timestamptz not null default now(),
    updated_at                        timestamptz not null default now()
);
create unique index if not exists idx_session_summaries_scope
    on session_summaries (chatbot_id, customer_identifier);
create index if not exists idx_session_summaries_chatbot
    on session_summaries (chatbot_id);

-- WP-3.4 Advanced Session Memory: structured facts alongside the prose
-- summary, plus conversation idle TTL and off-request-path compaction.
-- See db/migrations/20260929_advanced_session_memory.sql.
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

alter table conversations add column if not exists expires_at timestamptz;
alter table conversations add column if not exists needs_compaction boolean not null default false;
create index if not exists idx_conversations_expires_at
    on conversations (expires_at)
    where expires_at is not null;
create index if not exists idx_conversations_needs_compaction
    on conversations (updated_at)
    where needs_compaction;

-- WP-3.3 semantic chunking columns. No RLS dependency, so this can run
-- anywhere after chatbots/chatbot_document_chunks exist — it was missing
-- from this file entirely (unlike every other WP-* migration, which is
-- documented as "also included in schema.sql for new environments"),
-- which broke a fresh database with "column chunking_version does not
-- exist" the same way the Phase 4/5 gap below did. See
-- db/migrations/20260929_semantic_chunking.sql, kept in sync with it.
\ir migrations/20260929_semantic_chunking.sql

-- Phase 1 (2026-10-26): Crawl Plus document limits + SHA-256 dedup.
\ir migrations/20261026_crawl_plus_doc_limits.sql

-- Phase 2 (2026-10-27): team members, invitations, workspace audit log.
\ir migrations/20261027_workspace_members.sql

-- Phase 3 (2026-10-27): managed chat attachments.
\ir migrations/20261027_chat_attachments.sql

-- WP-3.1 Postgres RLS (defense in depth). See db/rls.sql and docs/RLS.md.
-- Must run before the Phase 4/5 migrations below: both rely on
-- app.is_privileged() (defined here) for their own embedded RLS policies.
\ir rls.sql

-- Phase 4 tables and policies (security audit, pricing, routing, ingest log).
\ir migrations/20260930_phase4_hardening.sql

-- Phase 5 OKF knowledge layer.
\ir migrations/add_okf_tables.sql
\ir migrations/20261114_auto_purchase_daily_claim.sql
-- CS-11 (2026-11-14): revocable sessions (tokens_valid_after, refresh session ids).
\ir migrations/20261114_revocable_sessions.sql

-- CS-15 (2026-11-15) step 1 only: the privileged login role (additive).
-- The lockdown (step 3) is deliberately NOT included here: it must run as a
-- separate, explicit command after the CS-15 code is live with
-- SYSTEM_DATABASE_URL set. See docs/RLS.md "Two-role rollout":
--   psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/20261115_rls_2_lockdown.sql
\ir migrations/20261115_rls_1_system_role.sql

-- SA-01 (2026-11-16): admin roles (super_admin / admin) and admin deactivation.
\ir migrations/20261116_admin_roles.sql
