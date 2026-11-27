-- WP-2.3: lexical tsvector + GIN beside the existing HNSW vector index.
-- Apply on existing DBs. New DBs get the same columns from schema.sql.
alter table chatbot_document_chunks add column if not exists content_tsv tsvector;
alter table chatbot_document_chunks add column if not exists heading text;
alter table chatbot_document_chunks add column if not exists source_type text;

create index if not exists idx_chatbot_document_chunks_content_tsv
  on chatbot_document_chunks using gin (content_tsv)
  where content_tsv is not null;
