-- Phase 3 (2026-10-27): managed chat attachments. v1 — store the file,
-- show it to the owner, link it to the conversation and (optionally) the
-- visitor's identity / Bookly appointment. No auto-add to the knowledge
-- base, no push to Bookly.
create table if not exists chatbot_attachments (
    id                    uuid primary key default gen_random_uuid(),
    chatbot_id            uuid not null references chatbots(id) on delete cascade,
    conversation_id       uuid not null references conversations(id) on delete cascade,
    customer_identity_id  uuid references customer_identities(id) on delete set null,
    bookly_appointment_id uuid references chatbot_bookly_appointments(id) on delete set null,
    storage_key           text not null,
    -- Generated id-based name on disk/in the bucket (never the visitor's
    -- own filename) — original_file_name is display-only, never used to
    -- build a path.
    generated_file_name   text not null,
    original_file_name    text not null,
    content_type          text not null,
    file_size             bigint not null,
    status                text not null default 'quarantined',
    created_at            timestamptz not null default now(),
    expires_at            timestamptz not null,

    constraint chatbot_attachments_status_check check (status in ('quarantined', 'clean', 'denied'))
);
create index if not exists idx_chatbot_attachments_chatbot_id on chatbot_attachments (chatbot_id, created_at desc);
create index if not exists idx_chatbot_attachments_conversation_id on chatbot_attachments (conversation_id);
create index if not exists idx_chatbot_attachments_expires_at on chatbot_attachments (expires_at);

-- One counter row per account (owner_user_id, not chatbot_id — the 200MB
-- Crawl Plus cap is a single pool shared by all of the owner's chatbots,
-- unlike Phase 1's per-chatbot document caps). Created lazily on first
-- upload (ON CONFLICT DO NOTHING in app code), reserved via one atomic
-- conditional UPDATE so two concurrent uploads can't both succeed past the
-- cap, and corrected by a nightly recompute job against
-- chatbot_attachments (the source of truth) in case of drift.
create table if not exists attachment_storage_usage (
    owner_user_id uuid primary key references users(id) on delete cascade,
    bytes_used    bigint not null default 0,
    updated_at    timestamptz not null default now()
);
