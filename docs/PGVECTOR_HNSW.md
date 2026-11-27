# pgvector HNSW (WP-1.4)

## Architecture

Document RAG and product catalog search already store `vector(1536)` and rank
with cosine distance (`<=>`). Without an ANN index, those queries sequential-scan
embeddings as the corpus grows.

WP-1.4 adds HNSW indexes only. Retrieval still:

```
WHERE chatbot_id = $1
  AND embedding IS NOT NULL
ORDER BY embedding <=> $query
```

No hybrid search, no query rewrite, no BM25, no reranker, and no embedding-model
change in this work package. Those belong to a later RAG-pipeline WP.

## Why HNSW, not IVFFlat

HNSW does not need a `lists` rebuild after ingest. IVFFlat recall collapses
when the table grows past the lists chosen at build time. Document and product
rows arrive continuously, so HNSW is the better default.

Indexes:

- `vector_cosine_ops` matches `<=>`
- partial `WHERE embedding IS NOT NULL` matches the query predicate
- existing btree on `chatbot_id` stays for tenant isolation
- `m = 16`, `ef_construction = 64`

## Filter + recall

Postgres applies `chatbot_id` after ANN candidates. A tenant with few rows in a
large table can miss neighbors if `hnsw.ef_search` is too low.

`PGVECTOR_HNSW_EF_SEARCH` (default 40) is `SET LOCAL` for each lookup.

Recommended operator settings (do not change lookup code):

| Tenant vectors | `PGVECTOR_HNSW_EF_SEARCH` |
|---|---|
| < 1,000 | 20 |
| 1,000–50,000 | 40 |
| > 50,000 | 80 |

`recommendedHnswEfSearch()` documents that table. Lookups still honor the env var.

## Acceptance criteria

| Check | Target | Local 2026-09-27 |
|---|---|---|
| Recall@5 vs exact | ≥ 95% | **100%** (400 vectors, 20 queries, `ef_search=40`) |
| Recall@10 vs exact | ≥ 98% | **100%** |
| Tenant leakage | 0 | **0** |
| Query semantics | unchanged (`chatbot_id` + `<=>`) | unchanged |
| p95 lookup | < 150 ms | **51 ms seq / 50 ms HNSW path** (400-row tenant) |

Re-run: `npx tsx scripts/benchmarkHnsw.ts`

## EXPLAIN ANALYZE (local `chatmate360_test`, 400 chunks, one tenant)

Collected 2026-09-27. Plans summarized; full vectors omitted.

**Tenant-filtered lookup (`WHERE chatbot_id = $1`), indexscan off (seq path)**

- Plan: `Seq Scan chatbot_document_chunks` → hash join documents → sort by `<=>`
- Execution time: **3.98 ms**
- Scanned 400 tenant rows

**Tenant-filtered lookup, seqscan off**

- Plan: `Bitmap Index Scan idx_chatbot_document_chunks_chatbot_id` → sort by `<=>`
- Execution time: **3.21 ms**
- HNSW was **not** chosen. Correct: 400 rows for one tenant is cheaper via btree + sort.

**ANN-only `ORDER BY embedding <=> $q` (no chatbot_id), seqscan off**

- Integration test confirms `idx_chatbot_document_chunks_embedding_hnsw`
- This is the path that pays off when a corpus is large enough that scanning
  every tenant row is more expensive than ANN.

## Latency (same 400-row tenant, 40 runs, client wall clock)

| Path | p50 | p95 | mean |
|---|---|---|---|
| Exact / seqscan-style | 47 ms | 51 ms | 47.9 ms |
| HNSW session (`ef_search=40`) | 48 ms | 50 ms | 48.4 ms |

At this size the two paths are equivalent. Expect HNSW to win when a single
tenant has tens of thousands of chunks, or when the alternative is a seq scan
of the whole table. Staging still needs a prod-sized `EXPLAIN ANALYZE`.

| Environment | Rows | p95 before | p95 after | Plan |
|---|---|---|---|---|
| local/test | 400 / tenant | 51 ms | 50 ms | btree + sort (HNSW selectable on ANN-only) |
| staging |  |  |  |  |
| production |  |  |  |  |

## Metrics

Each lookup logs and increments:

- `elapsedMs`
- `returned` / `limit` (chunks returned, candidate cap)
- `hit` (returned > 0)
- `avgSimilarity` (`1 - cosine distance`)

Redis (3-day TTL): `metric:retrieval.document_lookup_{ms,n,hits,returned,similarity_milli,similarity_n}:YYYY-MM-DD`

Rerank latency is not emitted until a reranker WP exists.

## When to build

1. Staging: create the indexes, `EXPLAIN ANALYZE` a representative `chatbot_id`
   lookup, compare the same 50 questions before/after.
2. Production: snapshot, run `db/migrations/20260927_pgvector_hnsw.sql`
   **outside a transaction**, watch IO, then `EXPLAIN ANALYZE` again.

## Rollback

```sql
DROP INDEX CONCURRENTLY IF EXISTS idx_chatbot_document_chunks_embedding_hnsw;
DROP INDEX CONCURRENTLY IF EXISTS idx_product_catalog_cache_embedding_hnsw;
```

Queries stay correct and tenant-scoped; they just scan more.
