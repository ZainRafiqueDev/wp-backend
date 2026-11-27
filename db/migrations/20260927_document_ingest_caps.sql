-- WP-1.5: optional per-chatbot ingest overrides. NULL = env / Crawl Plus default
-- (25 documents, 15MB per file, 400 chunks per file). Existing over-cap rows
-- are grandfathered — new uploads that would exceed are rejected with 409.

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

-- Index-only COUNT/SUM for ingest cap checks. The list index
-- (chatbot_id, created_at desc) still serves dashboard ordering.
create index if not exists idx_chatbot_documents_ingest_usage
  on chatbot_documents (chatbot_id) include (file_size, chunk_count);
