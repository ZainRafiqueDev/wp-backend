# Backend Integration Contract (v1)

This is the contract a chatbot owner's own backend implements so ChatMate360
can read live, real-time data (stock, availability, bookings) straight from
their system instead of only from what the crawler last saw or what they've
manually entered as live data.

**Transport model:** the owner gives ChatMate360 an `api_base_url` and an
`api_key` (`PUT /chatbots/integration` — see `src/services/integration.service.ts`).
ChatMate360 calls out to endpoints on that base URL; it never gets direct
database access to the owner's system, and the owner's system never calls
into ChatMate360. The api_key is encrypted at rest (AES-256-GCM, see
`src/lib/crypto.ts`) and sent as `Authorization: Bearer <api_key>` on every
request this contract describes.

**Naming is generic on purpose.** "Product" is the noun used everywhere
below regardless of vertical — a hotel maps "product" to a room type, a
property manager maps it to a listing, a store maps it to a SKU. Implement
the shape below; call your own internal things whatever you want.

**Versioning:** `contract_version` is stored per-integration
(`chatbot_integrations.contract_version`, currently always `"v1"`, set by
this app — not owner-configurable). A future v2 contract change adds new
endpoints/fields under a new version rather than breaking v1 implementations
that are still live.

---

## Phase 1 (implemented now): READ only

ChatMate360 calls these; nothing here lets ChatMate360 write anything back
to the owner's system. See `src/lib/backendLink.ts` for the actual client.

### `GET {api_base_url}/products`

Returns the current list of products/rooms/listings/SKUs this chatbot
should be able to answer questions about. Called on (roughly) every chat
message that needs current data, subject to a short cache
(`BACKEND_LINK_CACHE_TTL_SECONDS`, default 30s) — implement this cheaply;
it is not a batch/report endpoint.

Response: `200 application/json`, a JSON array of objects. Every object

must have an `id` (string or number, used to call the availability endpoint
below); everything else is free-form and gets fed to the AI as context
verbatim, so include whatever a customer might reasonably ask about (name,
price, short description, current stock count, etc.) — don't make the AI
guess at fields you didn't return.

```json
[
  { "id": "sku_123", "name": "Wireless Mouse", "price": "24.99", "stock": 14 },
  { "id": "sku_456", "name": "Mechanical Keyboard", "price": "89.00", "stock": 0 }
]
```

Any non-2xx response, a response that isn't a JSON array, a timeout, or a
connection failure is treated as "no live data available right now" —
ChatMate360 falls back to crawled content / the fixed fallback message,
never to a fabricated answer about what this endpoint might have said.

### `GET {api_base_url}/products/{id}/availability`

Returns current availability detail for one product. Called for a bounded
number of products returned by the list endpoint above (currently the first
5 — see `MAX_AVAILABILITY_LOOKUPS` in `src/lib/backendLink.ts`), in
parallel, each with its own timeout, so a slow response for one product
doesn't block the others.

Response: `200 application/json`, a free-form JSON object — again, whatever
fields are relevant (`available`, `quantity`, `nextRestockDate`,
`bookableDates`, etc.). A 404 for a since-removed product is treated the
same as any other failure: that product's availability is simply omitted
from context, not surfaced as an error to the chat user.

```json
{ "available": true, "quantity": 14, "leadTimeDays": 0 }
```

---

## Phase 2a (implemented — Full Custom tier, via Custom Actions): e-commerce writes

**Implemented for the first time in the three-tier product pass (Phase E) —
validated against a real e-commerce backend (WooCommerce; see
`demos/woocommerce-adapter/`), not merely speculative.** Unlike Phase 1
above, ChatMate360 does not call these automatically — they require
conversational input (which product, how many, whose order) that only
exists mid-conversation. They are wired up as **Custom Actions**
(`src/services/actions.service.ts`, gated to the Full Custom plan), not a
new capability of `src/lib/backendLink.ts` — the read side above stays a
passive, automatic context-injection mechanism; writes go through the
existing tool-calling mechanism Custom Actions already provide, rather than
adding a third, parallel way for ChatMate360 to call an owner's backend. A
chatbot owner registers the two actions below pointing at their own
backend's equivalent of these two routes (see the WooCommerce demo's README
for exact registration payloads); ChatMate360 does not call a fixed
`{api_base_url}` for these two — the URL is whatever the owner's Custom
Action definition says.

### `POST {your_backend}/orders`

Request body:

```json
{
  "productId": "sku_123",
  "quantity": 1,
  "customer": { "name": "string", "email": "string", "phone": "string | null" }
}
```

Response (`201 application/json`):

```json
{ "orderId": "string", "status": "confirmed | pending | failed", "confirmationDetails": "string" }
```

A non-2xx response here should carry `{ "error": "human-readable reason" }`
and gets relayed to the end user as an actual failure (out of stock, payment
declined, etc.) — unlike the read side's silent-fallback behavior, a failed
purchase attempt needs to reach the customer, not disappear.

### `PATCH {your_backend}/products/{id}/inventory`

Request body: `{ "quantity": number }` (the new absolute stock count, not a
delta). Response (`200 application/json`): `{ "id": "string", "stock": number }`.

**Known real-world constraint (found while building the WooCommerce demo,
not specific to WooCommerce):** ChatMate360's Custom Actions template engine
(`src/lib/actionExecutor.ts`) only ever substitutes `{{parameters}}` inside
JSON **strings** — there is no way for a bodyTemplate to produce a raw JSON
number. A `"quantity": "{{quantity}}"` bodyTemplate therefore always sends
`quantity` as a numeric **string** (e.g. `"2"`), even though the action's
own parameter is declared `type: "number"`. Any backend implementing these
two write endpoints should accept `quantity` as either a JSON number or a
numeric string — see `demos/woocommerce-adapter/src/contractMapping.ts`'s
`coerceQuantity` for a working example.

## Phase 2b (spec only — not implemented, not called by this app yet)

Designed for appointment/booking verticals, where the natural conversation
flow (check availability, then confirm one specific slot) is the same
shape as the e-commerce write flow above but the fields differ (a date/time
slot rather than a quantity). **Note:** the Phase E booking/appointment demo
(`demos/booking-api/`) does *not* implement this fixed shape — Custom
Actions are fully owner-defined (arbitrary URL/method/body), so that demo
simply registers two actions against its own real API's actual shape
(`GET /availability`, `POST /bookings`) rather than needing ChatMate360 to
standardize a shape here first. This spec is kept for a future backend that
wants a documented shape to target rather than inventing its own.

### `POST {api_base_url}/bookings`

Request body:

```json
{
  "productId": "sku_123",
  "quantity": 1,
  "customer": { "name": "string", "email": "string", "phone": "string | null" },
  "notes": "string | null"
}
```

Response (`201 application/json`):

```json
{
  "bookingId": "string",
  "status": "confirmed | pending | failed",
  "confirmationDetails": "string | null"
}
```

### `POST {api_base_url}/reservations`

Same shape as `/bookings`, for verticals (property/hospitality) where a
"reservation" (a date range against one listing) is the more natural noun
than a quantity-based booking:

Request body:

```json
{
  "productId": "listing_123",
  "startDate": "YYYY-MM-DD",
  "endDate": "YYYY-MM-DD",
  "customer": { "name": "string", "email": "string", "phone": "string | null" },
  "notes": "string | null"
}
```

Response (`201 application/json`):

```json
{
  "reservationId": "string",
  "status": "confirmed | pending | failed",
  "confirmationDetails": "string | null"
}
```

Error responses for both write endpoints (once implemented) are expected to
be `4xx application/json` with `{ "error": "human-readable reason" }` — a
capacity conflict, an invalid date range, etc. — since a write failure needs
to be relayable to the end user in a way a silent "unavailable" fallback
(the read-side failure behavior) isn't appropriate for.

---

## Security notes

- **Read-only in Phase 1 is a deliberate scope boundary, not a technical
  guarantee.** ChatMate360 never calls a write endpoint against
  `api_base_url` (the backend-link integration stays passive/read-only —
  see `src/lib/backendLink.ts`), and the contract above reflects that — but
  the api_key you issue is sent as a bearer token and this app has no way to
  inspect or constrain what that key is scoped to on your end. Phase 2a's
  writes are a separate mechanism (Custom Actions, each with its own
  owner-configured URL and its own `Authorization` header if the action
  sets one) — a store owner who wants their `api_base_url` key fully
  read-only can still do so, and issue a separate, write-capable key only to
  the specific Custom Action endpoints that need one.
- **Encryption at rest protects against a ChatMate360 database compromise,
  not against what a legitimately-obtained key can do.** If your platform
  supports issuing a scoped or read-only API key (one that can only satisfy
  `GET /products` and `GET /products/{id}/availability`, with no write
  access on your side even though Phase 1 doesn't send writes), we
  recommend issuing that instead of a full-access key. This is a
  recommendation ChatMate360 cannot enforce from its side — it depends
  entirely on what your own API supports.
- Every outbound call ChatMate360 makes to `api_base_url` is checked against
  the same SSRF protections used for site crawling (`src/lib/crawler/ssrf.ts`)
  — private/loopback/link-local/cloud-metadata/reserved IP ranges are
  blocked, re-resolved on every call rather than trusted from a cached DNS
  result.
- Every call has an aggressive timeout (`BACKEND_LINK_TIMEOUT_MS`, 4s) and
  zero retries. A slow or broken backend degrades the chat answer to a
  fallback; it never hangs the chat response waiting on your system.
