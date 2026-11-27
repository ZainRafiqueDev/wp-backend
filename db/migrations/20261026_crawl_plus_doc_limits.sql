-- Phase 1 (2026-10-26): Crawl Plus document limits (6 docs / 16MB / 50MB
-- per chatbot) and SHA-256 dedup. See src/lib/plans.ts, src/lib/ingestCaps.ts.
alter table chatbot_documents add column if not exists file_hash text;

-- A duplicate upload for the same chatbot never consumes a document slot
-- (checked in app code before the quota check in
-- documentIngestion.service.ts's uploadDocument). This index is the DB-level
-- backstop for two uploads of the same file racing past that pre-check.
-- Partial on status <> 'failed' so a failed row never blocks re-uploading
-- the same bytes.
create unique index if not exists idx_chatbot_documents_dedup
  on chatbot_documents (chatbot_id, file_hash)
  where status <> 'failed' and file_hash is not null;
