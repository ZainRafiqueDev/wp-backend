# Document ingest caps (WP-1.5)

Caps are enforced from **database counts**, not only multer. Multer's 20MB limit is a transport/memory ceiling. Business rejection is `409` with `{ ok: false, error, cap }`.

`cap` is one of: `documents` | `bytes` | `chunks`.

There is no page column. Page-like bounds are **chunk** caps.

## Full Custom defaults

Mislabeled "Crawl Plus defaults" until this pass — these `DOCUMENT_MAX_*`
vars are Full Custom's own (Crawl Plus has its own separate
`CRAWL_PLUS_DOC_MAX_*` vars: 6 documents / 16MB per file / 50MB per
chatbot — see `docs/deploy-checklist-phase1-3.md` §1.3). Predates the
Phase 1 per-plan split; never updated to match.

| Cap | Default | Env |
| ---: | ---: | --- |
| Documents per chatbot | 25 | `DOCUMENT_MAX_PER_CHATBOT` |
| Bytes per file | 20MB (`20971520`) | `DOCUMENT_MAX_FILE_BYTES` |
| Bytes per chatbot | 25 × 20MB | `DOCUMENT_MAX_CHATBOT_BYTES` |
| Chunks per file | 400 | `DOCUMENT_MAX_CHUNKS_PER_DOCUMENT` |
| Chunks per chatbot | 25 × 400 | `DOCUMENT_MAX_CHUNKS_PER_CHATBOT` |

Per-chatbot nullable columns override the env defaults:

- `chatbots.max_documents`
- `chatbots.max_bytes` (chatbot-total bytes, not per-file)
- `chatbots.max_chunks` (chatbot-total chunks)

## Grandfathering

Existing rows that already sit over a cap are **kept**. New uploads that would exceed a cap are rejected.

A chunk-cap rejection after insert **deletes** the in-progress row so a rejected explosion does not consume a document slot.

When `DOCUMENT_INGEST_ASYNC` is on (WP-2.1 default), count and byte caps still reject on the HTTP hop (`409` before persist). The chunk cap runs in the worker after `202`; the row and stored object are then deleted.

## Why failed rows still count

`failed` rows count toward the document and byte caps. That is intentional.

- A failed upload is still a stored dashboard row (`file_name`, `file_size`, `error_message`). Counting only `ready` would let a client create unbounded failed rows.
- `processing` must count, or concurrent uploads could all pass the check while embeddings are in flight.
- Users can delete a failed document and retry. The API already exposes delete.
- Chunk-cap failures are different: those rows are deleted because the file was never accepted as an inventory item.

Counting only successful ingest is a reasonable SaaS variant. It is not a WP-1.5 change. If product later wants `ready`-only quotas, exclude `failed` in the aggregate and keep `processing`.

## Indexes and lock order

- `idx_chatbot_documents_chatbot_id (chatbot_id, created_at desc)` — dashboard list.
- `idx_chatbot_documents_ingest_usage (chatbot_id) INCLUDE (file_size, chunk_count)` — cap aggregates.

Lock order is always `chatbots.id` then aggregates/writes on `chatbot_documents`. The only other `FOR UPDATE` in the app is `commerce_orders.id`. Those paths do not interleave, so this package does not introduce a deadlock cycle.

Cached `current_documents` / `current_bytes` / `current_chunks` columns are a later optimization. At the 25-document Crawl Plus default, COUNT/SUM is cheaper than maintaining a second write path.

Measured on local Postgres against 25 rows (n=40):

| Path | p50 | p95 |
| --- | ---: | ---: |
| `count(*)` only (pre-WP-1.5) | 1.68ms | 2.19ms |
| `count` + `sum(file_size)` + `sum(chunk_count)` | 1.53ms | 2.13ms |
| `FOR UPDATE` + aggregates + commit | 7.31ms | 10.01ms |

The extra SUM is in the noise. The lock+commit adds ~5–8ms, still far below extract/embed time.

HTTP `409 cap=documents` on the live upload route (n=20): p50 **35.4ms**, p95 **47.2ms**. That includes Express, auth, plan check, lock, and aggregate — not embedding.

At ~100 rows the planner still seq-scans (`actual 0.07ms`). `idx_chatbot_documents_ingest_usage` is in place and used when the table is large enough. Repeat SQL numbers with `npx tsx scripts/benchmarkIngestCaps.ts`.

## Monitoring

Redis (3-day TTL) plus structured logs:

- `metric:ingest.rejected_cap:<YYYY-MM-DD>`
- `metric:ingest.rejected_cap.documents:<YYYY-MM-DD>`
- `metric:ingest.rejected_cap.bytes:<YYYY-MM-DD>`
- `metric:ingest.rejected_cap.chunks:<YYYY-MM-DD>`

Search logs for `event=ingest.rejected_cap`.

## Rollback

Raise the env caps. Keep the columns. Do not drop `max_documents` / `max_bytes` / `max_chunks`.

## Production checklist

1. Count current max documents and summed `file_size` per chatbot.
2. Confirm env defaults (or raise them once) before enforcing in production.
3. Apply `db/migrations/20260927_document_ingest_caps.sql` (or `db/schema.sql`) then deploy the API.
4. Announce the 25 / 15MB / 400-chunk defaults.
