-- WP-2.1: persist uploaded bytes under storage_key so ingest can finish
-- after the HTTP request returns. Apply with schema.sql on new DBs.
alter table chatbot_documents add column if not exists storage_key text;
alter table chatbot_documents add column if not exists page_count integer;
alter table chatbot_documents add column if not exists bytes bigint;
alter table chatbot_documents add column if not exists updated_at timestamptz not null default now();

create index if not exists idx_chatbot_documents_processing_updated
  on chatbot_documents (updated_at) where status = 'processing';
