# Stripe webhook inbox (WP-1.3)

## Phase 1 architecture (current)

```
Verify signature → persist unique event id → process inline → HTTP 200
```

This is intentional, not the long-term target.

Phase 1 keeps acceptance and processing on the same request so a successful
200 means the subscription or top-up grant has already been written. If the
process crashes before 200, Stripe retries and the inbox + checkout-session
unique key make the grant exactly-once.

Trade-off: a slow grant path (Stripe retrieve, Postgres, notification email)
can exceed Stripe’s webhook timeout and produce a concurrent retry. The retry
is safe (idempotent grants) but can run the expensive path twice.

## Phase 3 architecture (planned)

```
Verify signature → persist → COMMIT → HTTP 200 → worker processes → mark processed
```

Migrate to B when any of these are true:

- p95 `/webhooks/stripe` time approaches Stripe’s retry window
- inbox `processing` or `avgProcessingMs` stays high under load
- notification/email work starts dominating the webhook request
- more than one API instance needs to accept webhooks without sharing request CPU

Until then, keep Phase 1 A. Do not 200 before persist.

## Replay

Unprocessed rows are replayed when:

```
processed_at IS NULL
AND coalesce(last_attempt_at, received_at) < now() - STRIPE_INBOX_REPLAY_DELAY
```

`STRIPE_INBOX_REPLAY_DELAY` defaults to 30 seconds.

## Retention

Processed rows, including raw `payload`, are deleted after
`STRIPE_INBOX_RETENTION_DAYS` (default 90). Set `0` to disable purge.
Unprocessed / failed rows are never auto-deleted.

## Admin

`GET /admin/stripe-inbox`

| Query | Meaning |
|---|---|
| `status=unprocessed\|processing\|failed\|processed` | Row state |
| `type=` | Stripe event type |
| `customer=` | Stripe customer id on the object |
| `limit` / `offset` | Pagination |

Payloads are not returned.
