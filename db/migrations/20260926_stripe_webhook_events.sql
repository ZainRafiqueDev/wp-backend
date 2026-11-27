-- WP-1.3 Stripe webhook inbox. Safe to re-run.
-- Apply with: psql "$DATABASE_URL" -f db/migrations/20260926_stripe_webhook_events.sql
-- Also included in db/schema.sql for new environments.

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

create index if not exists idx_stripe_webhook_events_unprocessed
    on stripe_webhook_events (received_at)
    where processed_at is null;
