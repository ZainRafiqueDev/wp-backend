# Async document ingestion (WP-2.1)

The HTTP upload path does **not** embed. It writes the file to object storage, inserts a `processing` row with `storage_key`, and returns `202`. A BullMQ `document-ingest` worker (concurrency 1–2) embeds and marks `ready` or `failed`.

```
HTTP persist (storage_key + processing row)
        ↓
     202 Accepted
        ↓
document-ingest worker
        ↓
malware scan (WP-2.2, before parse)
        ↓
  ready | failed
```

## Control plane

| Env | Default | Role |
| --- | --- | --- |
| `DOCUMENT_INGEST_ASYNC` | `true` | `false` processes files `<= DOCUMENT_INGEST_SYNC_MAX_BYTES` inline and returns `201` (rollback). |
| `DOCUMENT_INGEST_SYNC_MAX_BYTES` | 15MB | Sync-path size ceiling when async is off. |
| `DOCUMENT_INGEST_QUEUE_NAME` | `document-ingest` | Dedicated queue. Do not share with crawl. |
| `DOCUMENT_INGEST_WORKER_CONCURRENCY` | `2` (clamped 1–2) | Worker parallelism. |
| `DOCUMENT_INGEST_STALE_PROCESSING_MS` | 30m | Sweep re-enqueues stuck `processing` rows. |
| `DOCUMENT_STORAGE_DRIVER` | `fs` | `fs` for local/CI; `s3` for MinIO/AWS. |
| `DOCUMENT_STORAGE_DIR` | `var/document-storage` | Filesystem root when driver is `fs`. |
| `DOCUMENT_STORAGE_BUCKET` / `REGION` / `ENDPOINT` / keys | unset | Required for `s3`. |

`storage_key` format: `tenant/{chatbotId}/documents/{documentId}/{sanitizedName}`.

## APIs

- `POST /chatbots/:chatbotId/documents` → `202` + document id (`status=processing`) when async; `201` on sync rollback after inline process.
- `GET /chatbots/:chatbotId/documents` lists `status` for dashboard polling.
- `POST /chatbots/:chatbotId/documents/:id/retry` re-enqueues a row that still has `storage_key`.
- Count/byte caps still `409` on the HTTP hop (WP-1.5). Chunk caps run in the worker and delete the row + object.

## Workers

`src/worker.ts` processes `document-ingest` and a sweep tick. Cap explosions throw `409 { cap: "chunks" }` and delete the row. Parse/embed failures mark `failed` and increment `ingest.failed`.

## Rollback

1. Set `DOCUMENT_INGEST_ASYNC=false` so files `<= DOCUMENT_INGEST_SYNC_MAX_BYTES` embed inline (`201`).
2. Keep the bucket / filesystem tree. Do not delete stored objects.
3. Leave the worker running until the queue drains.

## Monitoring

- `ingest.queue_depth`
- `ingest.processing_age`
- `ingest.failed`

Redis metric writes must never take ingest down.

## Production checklist

- Create the S3/MinIO bucket with encryption and IAM for the API + worker.
- Run the worker on AWS with concurrency 1–2.
- Apply `db/migrations/20260927_async_document_ingest.sql` (or `db/schema.sql` on a new DB).
- Set a lifecycle rule on failed/orphaned objects after operators confirm they are unused.
- Dashboard polls `GET` while `status=processing`.
