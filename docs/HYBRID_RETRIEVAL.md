# Hybrid retrieval (WP-2.3) + rerank (WP-3.2)

Document lookup is the union of:

1. **Lexical** — `content_tsv @@ plainto_tsquery` with a GIN index (`simple` config so SKU/id tokens survive).
2. **Vector** — existing HNSW cosine lookup from WP-1.4.

The two ranked lists are fused with reciprocal rank fusion into a candidate pool (`max(DOCUMENT_RETRIEVAL_LIMIT, RETRIEVAL_RERANK_CANDIDATE_POOL)` deep when rerank is on, `DOCUMENT_RETRIEVAL_LIMIT` deep otherwise). Both queries stay `chatbot_id` scoped and only read `ready` documents.

**Rerank (WP-3.2)**: the fused pool is then passed to `src/lib/rerank.ts`, which asks a cheap LLM (same Gemini→OpenAI fallback chain as query rewriting, `completeCheaply`) to output the candidate numbers ordered most-to-least relevant to the actual question — RRF's fused rank tells you "ranked well by lexical/vector overlap," not "answers the question," and this step corrects for that. The reordered list is then truncated to `DOCUMENT_RETRIEVAL_LIMIT`. Fails open on any error (no provider configured, timeout, unparseable response) straight back to the plain RRF-fused order — retrieval never breaks because rerank did.

```
question
   ├─ lexical GIN (SKU / exact id)
   └─ vector HNSW (synonyms / paraphrase)
        ↓
   RRF fuse → candidate pool
        ↓
   LLM rerank (WP-3.2) → top-K
```

## Configuration

| Env | Default | Role |
| --- | --- | --- |
| `RETRIEVAL_MODE` | `hybrid` | `vector` is the rollback (HNSW only). |
| `RETRIEVAL_TS_CONFIG` | `simple` | Postgres text-search config for write and query. |
| `RETRIEVAL_RRF_K` | `60` | RRF constant. |
| `RETRIEVAL_LEXICAL_CANDIDATES` | `20` | Lexical pool before fuse. |
| `RETRIEVAL_VECTOR_CANDIDATES` | `20` | Vector pool before fuse. |
| `RETRIEVAL_SHADOW_COMPARE` | `false` | Log hybrid vs vector-only overlap. |
| `RETRIEVAL_RERANK_ENABLED` | `true` | `false` rolls back to plain RRF-fused order, no LLM call. |
| `RETRIEVAL_RERANK_CANDIDATE_POOL` | `15` | Fused candidates kept alive for the reranker to reorder. |

## Workers

The document-ingest sweep backfills `content_tsv` on existing chunks (`backfillDocumentChunkTsvectors`). New ingest writes `content_tsv` in the same insert as the embedding.

## Monitoring

- `retrieval.lexical_hits`
- `retrieval.vector_hits`
- `retrieval.empty`
- `"hybrid retrieval reranked"` info log (chatbotId, candidateCount, topN) on every successful rerank; `"rerank ... falling back"` warn log on any fallback.

## Production checklist

1. Apply `db/migrations/20260927_hybrid_retrieval.sql`.
2. Let the sweep backfill (or run `backfillDocumentChunkTsvectors` until it returns 0).
3. Optionally set `RETRIEVAL_SHADOW_COMPARE=true` and review overlap on ~100 queries.
4. Keep `RETRIEVAL_MODE=hybrid`. Rollback is `RETRIEVAL_MODE=vector`.
5. Keep `RETRIEVAL_RERANK_ENABLED=true`. Rollback is `RETRIEVAL_RERANK_ENABLED=false` (plain RRF order, no added LLM cost/latency).
