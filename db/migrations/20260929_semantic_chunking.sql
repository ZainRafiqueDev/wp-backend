-- WP-3.3 semantic chunking. `heading` already exists (db/schema.sql) but was
-- never populated by the old chunkText.ts — this adds the rest of the
-- metadata semanticChunk.ts produces, plus chunking_version so existing
-- (version 1) chunks can be identified and re-chunked by the background
-- worker without disturbing chatbots that already have version-2 chunks.
alter table chatbot_document_chunks add column if not exists chunking_version int not null default 1;
alter table chatbot_document_chunks add column if not exists section text;
alter table chatbot_document_chunks add column if not exists page_number int;
alter table chatbot_document_chunks add column if not exists document_type text;
alter table chatbot_document_chunks add column if not exists token_estimate int;

create index if not exists idx_chatbot_document_chunks_version
  on chatbot_document_chunks (chatbot_id, chunking_version);

-- Configurable target chunk size per chatbot (master prompt: "configurable
-- per chatbot, with sensible defaults"). 1200 matches semanticChunk.ts's
-- own default.
alter table chatbots add column if not exists chunk_target_chars int not null default 1200;
