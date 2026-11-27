-- WP-2.4: version every stored vector and meter embedding spend per tenant/day.
-- Apply on existing DBs. New DBs get the same columns from schema.sql.
--
-- Existing vectors in this product were written with text-embedding-3-small
-- (1536). Label them so hybrid vector lookup can require an exact identity
-- without mixing an unlabeled legacy row into a later model generation.

alter table chatbot_document_chunks add column if not exists embedding_model text;
alter table chatbot_document_chunks add column if not exists embedding_dim int;

alter table product_catalog_cache add column if not exists embedding_model text;
alter table product_catalog_cache add column if not exists embedding_dim int;

update chatbot_document_chunks
   set embedding_model = 'text-embedding-3-small', embedding_dim = 1536
 where embedding is not null and embedding_model is null;

update product_catalog_cache
   set embedding_model = 'text-embedding-3-small', embedding_dim = 1536
 where embedding is not null and embedding_model is null;

drop index if exists idx_chatbot_document_chunks_embedding_identity;
create index if not exists idx_chatbot_document_chunks_embedding_identity
  on chatbot_document_chunks (chatbot_id, embedding_model, embedding_dim)
  where embedding_model is not null;

drop index if exists idx_product_catalog_cache_embedding_identity;
create index if not exists idx_product_catalog_cache_embedding_identity
  on product_catalog_cache (chatbot_id, embedding_model, embedding_dim)
  where embedding_model is not null;

create table if not exists embedding_usage_daily (
    user_id      uuid not null references users(id) on delete cascade,
    usage_day    date not null,
    call_count   integer not null default 0,
    token_count  bigint not null default 0,
    cost_usd     numeric(18, 12) not null default 0,
    primary key (user_id, usage_day)
);

alter table embedding_usage_daily alter column cost_usd type numeric(18, 12);
