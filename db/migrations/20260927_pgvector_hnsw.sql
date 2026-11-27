-- WP-1.4 HNSW indexes for cosine ANN lookup.
-- MUST run outside a transaction (CREATE INDEX CONCURRENTLY).
-- Apply with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/20260927_pgvector_hnsw.sql
-- Take a snapshot first. Raise maintenance_work_mem for the build session only.
-- Rollback: DROP INDEX CONCURRENTLY IF EXISTS idx_chatbot_document_chunks_embedding_hnsw;
--           DROP INDEX CONCURRENTLY IF EXISTS idx_product_catalog_cache_embedding_hnsw;

SET maintenance_work_mem = '256MB';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chatbot_document_chunks_embedding_hnsw
    ON chatbot_document_chunks
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64)
    WHERE embedding IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_product_catalog_cache_embedding_hnsw
    ON product_catalog_cache
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64)
    WHERE embedding IS NOT NULL;
