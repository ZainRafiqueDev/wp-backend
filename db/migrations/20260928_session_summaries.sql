-- Master prompt: cross-session customer memory + credit-exhaustion
-- continuity. customer_identifier is always a hash (sha256 of
-- "<chatbotId>:<lowercased email>", see hashToken in
-- notification.service.ts) — never a plain email, per the master prompt's
-- explicit privacy rule for this table.
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
