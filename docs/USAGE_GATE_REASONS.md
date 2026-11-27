# Usage gate reasons (WP-1.2)

Customer-facing credits are **monthly USD only**. Day and week caps are request-pace
limits. They still block answering, but they are not sold as extra credits.

## Reasons the API emits

| `gateReason` | HTTP | Meaning | Visitor copy |
|---|---|---|---|
| `monthly_credits_exhausted` | 200 | No allowed model has monthly credit left | Top up or upgrade |
| `burst_limited` | 429 + `Retry-After` | Monthly credit remains; day or week pace is exhausted | Wait a moment and try again |
| `trial_expired` | 200 | Unpaid trial ended | Owner must upgrade |
| `account_deactivated` / `chatbot_deactivated` | 200 | Admin or abuse flag | Unavailable |

`burst_limited` is an internal enum. Visitors never see the word “burst”.

429 bodies also include `retryAfterSeconds`. That value is seconds until the
blocking UTC day or ISO week refreshes. CORS exposes the `Retry-After` header.

## Deprecated alias

`cost_cap_exceeded` is **no longer emitted**.

It remains in the TypeScript union and in `isUsageGateReason` /
`visitorMessageForGate` so older widgets, mocks, and recrawl checks keep
compiling. Incoming legacy values are treated as monthly credit exhaustion.

Old widgets that only switch on `cost_cap_exceeded`:

- Monthly blocks still return HTTP 200 with `text` set to the upgrade/top-up
  message, so they keep working via the body.
- Pace-limit blocks return 429 with `error` set to the wait-and-retry message.
  Unknown `gateReason` values should fall back to `text` / `error`, not a blank
  banner.

Deploy the updated widget with the backend so `GATE_MESSAGES` includes both new
reasons.

## Operational counters

Redis keys `metric:<name>:<YYYY-MM-DD>` (3-day TTL), plus structured logs:

- `usage.monthly_blocked`
- `usage.burst_blocked`
- `usage.platform_limit`
- `usage.provider_unavailable`

`usage.upgrade_clicked` is not counted yet (needs a Billing CTA hook).
