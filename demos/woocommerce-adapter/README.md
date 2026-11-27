# WooCommerce demo (Phase E)

A real adapter translating ChatMate360's Backend Integration Contract
(`docs/BACKEND_INTEGRATION_CONTRACT.md` in the main repo) into WooCommerce's
real REST API v3 (`/wp-json/wc/v3/...`) calls — read (products, availability)
and, for the first time, **write** (order creation, inventory update).

## Why an adapter, not calling WooCommerce directly

The contract is intentionally generic (`GET {api_base_url}/products` returns
free-form JSON objects with just an `id` guaranteed) so it works for any
backend, not only WooCommerce. This adapter is what a WooCommerce store
owner would actually deploy and point their chatbot's integration
(`PUT /chatbots/:chatbotId/integration`) at — it exposes the generic contract
shape on one side and speaks WooCommerce's real, WooCommerce-specific shape
on the other, so ChatMate360 itself never needs to know anything about
WooCommerce.

## What's here

- `src/wooClient.ts` — the real WooCommerce REST API v3 client: list/get
  products, create an order, update a product's stock. HTTP Basic Auth with
  a store's `consumer_key`/`consumer_secret` (the documented approach for an
  HTTPS store — see [WooCommerce's REST API docs](https://woocommerce.github.io/woocommerce-rest-api-docs/)).
- `src/contractMapping.ts` — pure translation functions between WooCommerce's
  real product/order shapes and the contract's generic shapes. No I/O; the
  most important file to read to see exactly what got adjusted from the
  contract doc's original assumptions (see **Contract adjustments** below).
- `src/app.ts` — the Express routes implementing the contract:
  `GET /products`, `GET /products/:id/availability`,
  `POST /orders` (**new**), `PATCH /products/:id/inventory` (**new**).
- `tests/wooClient.test.ts` — proves the real WooCommerce request shapes
  (URLs, Basic Auth header, request bodies) sent for all four operations.
- `tests/contractMapping.test.ts` — proves the translation logic against
  realistic WooCommerce response shapes, including the edge cases the
  contract doc didn't originally anticipate (see below).
- `tests/app.test.ts` — proves the HTTP routes wire the above together
  correctly, including validation and error passthrough (404 vs. 5xx).

Run it locally (no real store needed — the test suite mocks WooCommerce):

```
npm install
npm test          # 23/23 passing
```

Running it against a real store additionally requires:

```
WOO_STORE_URL=https://your-store.example.com \
WOO_CONSUMER_KEY=ck_... \
WOO_CONSUMER_SECRET=cs_... \
npm run dev        # http://localhost:4200
```

(Generate a consumer key/secret in WordPress admin: WooCommerce → Settings →
Advanced → REST API → Add key, with Read/Write permissions for the two write
endpoints to work.)

## Contract adjustments found while implementing this (validated against WooCommerce's real API shape)

The generic contract doc was written before any real backend implemented it.
Building this adapter against WooCommerce's actual REST API surfaced three
adjustments, all reflected in `contractMapping.ts` and its tests:

1. **`stock` can be a real gap, not just a number.** WooCommerce only
   reports `stock_quantity` when a product has `manage_stock: true`; for a
   non-stock-managed product it's always `null` even though the product may
   be perfectly in stock. `productToContract`/`productToAvailability` report
   `stock`/`quantity` as `null` in that case (never fabricated as `0`) and
   derive `available` from WooCommerce's separate `stock_status` field
   (`instock`/`outofstock`/`onbackorder`), which is always present
   regardless of stock management. The original contract doc's example
   (`"stock": 14`) implicitly assumed a number is always available — true
   for stock-managed products, not guaranteed otherwise.
2. **Order creation needs `line_items`, not a flat `productId`.** The
   contract's Phase 2 draft (`/bookings`, still spec-only for appointment
   verticals — see the separate booking-api demo) modeled a single-product
   request. WooCommerce orders are built around a `line_items` array of
   `{product_id, quantity}`, and billing details are their own nested
   object (`first_name`/`last_name`, not a single `name` string) —
   `contractOrderRequestToWooInput` + `createOrder` do this translation,
   including splitting a single "customer name" into first/last name.
3. **No native "order notes" field on creation.** The generic contract's
   Phase 2 draft included a free-text `notes` field; WooCommerce has no
   equivalent on order creation itself (only as a separate follow-up
   `POST /orders/{id}/notes` call). This adapter does not implement that
   follow-up call — a real deployment wanting to preserve customer notes
   would need to add it. Flagged here rather than silently dropped.

## The new write endpoints

### `POST {api_base_url}/orders`

Request (contract shape ChatMate360 sends — see the main contract doc):

```json
{
  "productId": "123",
  "quantity": 2,
  "customer": { "name": "Ada Lovelace", "email": "ada@example.com", "phone": "555-1234" }
}
```

Response (`201`):

```json
{ "orderId": "501", "status": "confirmed", "confirmationDetails": "Order #501 (processing). Total: USD49.98." }
```

A non-2xx WooCommerce response (out of stock, invalid product id, payment
issue) is passed through as `4xx`/`502` with `{"error": "..."}"` — this is a
write, so unlike the read side's silent fallback, a failure here needs to
reach the end user as an actual error the chatbot can relay ("that item just
sold out", etc.), not a generic "unavailable."

### `PATCH {api_base_url}/products/{id}/inventory`

Request: `{ "quantity": 25 }` (absolute new stock count — not a delta).
Response (`200`): `{ "id": "123", "stock": 25 }`.

## Wiring this into a real chatbot's Custom Actions

Full Custom plan only (writes are gated — see
`src/services/actions.service.ts`'s `requireFullCustomPlan` in the main
repo). Register two actions against this adapter's deployed URL:

- `create_order` → `POST {adapter_url}/orders`, parameters `product_id`,
  `quantity`, `customer_name`, `customer_email`, bodyTemplate
  `{"productId": "{{product_id}}", "quantity": "{{quantity}}", "customer": {"name": "{{customer_name}}", "email": "{{customer_email}}"}}`.
- `update_inventory` → `PATCH {adapter_url}/products/{{product_id}}/inventory`,
  parameter `quantity`, bodyTemplate `{"quantity": "{{quantity}}"}`.

Note `"quantity"` is quoted (a string template) in both, even though it's a
number conceptually: ChatMate360's Custom Actions engine
(`actionExecutor.ts`'s `fillBody`/`fillTemplate`) only ever substitutes
`{{placeholders}}` inside JSON **strings** — there's no way to template a
raw JSON number — so every quantity a real Custom Action call sends arrives
here as a numeric string (`"2"`, not `2`). Both `/orders` and
`/products/:id/inventory` accept either; see `coerceQuantity` in
`contractMapping.ts`.

The read side (`/products`, `/products/{id}/availability`) is wired via the
backend-link integration (`PUT /chatbots/:chatbotId/integration`), not a
Custom Action — it's passive context ChatMate360 fetches automatically on
every relevant chat message, exactly like any other backend-link
integration.

## Deployment (not done in this environment)

This sandbox has no cloud hosting credentials and no real WooCommerce store
to point at, so this adapter is not deployed to a real public URL and has
not been run against a real store as part of this work — it's built and
fully tested locally against realistic mocked WooCommerce responses (23/23
tests passing), matching WooCommerce's documented REST API v3 shapes. To
actually stand this up:

1. Get a real WooCommerce store (or a local one via the official Docker
   image) and generate a REST API consumer key/secret with read/write
   permissions.
2. Deploy this adapter to any Node 20+ host (Render, Railway, Fly.io, a
   VPS) with `WOO_STORE_URL`/`WOO_CONSUMER_KEY`/`WOO_CONSUMER_SECRET` set.
3. Point a Full Custom chatbot's backend-link integration and the two
   Custom Actions above at that adapter's deployed URL.
