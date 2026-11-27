# Connecting a WordPress/WooCommerce store (local testing)

Step-by-step for wiring a real WordPress store running the WooCommerce
plugin to a Full Custom chatbot, tested against localhost first. See
`IMPLEMENTATION_STATUS.md` §13 for the full architecture writeup this
setup exercises.

## 1. Start infrastructure

```bash
cd Chatmate360-Backend-main/Chatmate360-Backend-main
docker compose up -d
```

## 2. Start backend, worker, and frontend (3 separate terminals)

```bash
npm run dev        # backend, terminal 1
npm run worker      # terminal 2
```

```bash
cd Chatmate360-main/Chatmate360-main
npm run dev          # frontend, terminal 3
```

## 3. Start ngrok (terminal 4 — keep it running)

WordPress needs to reach your backend over the public internet to deliver
webhooks; `localhost:4000` isn't reachable from there, so a tunnel is
required for local testing.

```bash
ngrok http 4000
```

Copy the `https://xxxx.ngrok-free.app` URL it prints — this is your
temporary public backend address for the rest of this setup.

## 4. Sign up / log in and create a chatbot

- Go to `http://localhost:3000` → sign up (or log in).
- Create a chatbot, paste your WordPress store's URL, wait for status
  `ready` (the worker crawls it — this trains the bot on your site's
  general content, separate from the WooCommerce product data wired up
  below).
- Note the **chatbot id** — visible in the dashboard URL, or via
  `GET /chatbots` with your access token.

## 5. Get your access token

Browser devtools → Application/Storage → Local Storage →
`chatmate360.access_token` → copy the value.

## 6. Upgrade that account to Full Custom

No real Stripe checkout exists in this environment, so grant the plan
directly:

```bash
docker exec -i chatmate360-backend-main-postgres-1 psql -U postgres -d chatmate360 \
  -c "insert into subscriptions (user_id, stripe_customer_id, plan, status) values ('<your_user_id>', 'cus_manual_test', 'full_custom', 'active');"
```

Your user id is in the `GET /auth/me` response, or the `users` table.

## 7. Get WooCommerce API keys from WordPress

WP Admin → **WooCommerce → Settings → Advanced → REST API → Add key**:
- Permissions: **Read/Write** (order creation + inventory updates need
  write access)
- Generate → copy the **Consumer key** (`ck_...`) and **Consumer secret**
  (`cs_...`) immediately — WooCommerce only shows the secret once.

## 8. Connect WooCommerce to the chatbot

```bash
curl -X POST http://localhost:4000/chatbots/<chatbotId>/woocommerce \
  -H "Authorization: Bearer <your_access_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "storeUrl": "https://your-wordpress-site.com",
    "consumerKey": "ck_...",
    "consumerSecret": "cs_...",
    "webhookSecret": "pick-any-secret-string"
  }'
```

`webhookSecret` isn't issued by WooCommerce — you invent it here, then
paste the *same* value into the WooCommerce webhook config in step 9. This
call also automatically starts a background product-catalog sync.

## 9. Add the webhook in WordPress

WP Admin → **WooCommerce → Settings → Advanced → Webhooks → Add webhook**,
twice (once per topic below), same URL and secret both times:

| Field | Value |
|---|---|
| Status | Active |
| Topic | `Order updated` (first webhook), `Order created` (second webhook) |
| Delivery URL | `https://xxxx.ngrok-free.app/webhooks/woocommerce/<chatbotId>` |
| Secret | the exact string used as `webhookSecret` in step 8 |
| API version | WP REST API Integration v3 |

## 10. Verify products synced

```bash
docker exec -i chatmate360-backend-main-postgres-1 psql -U postgres -d chatmate360 \
  -c "select name, price, stock_quantity from product_catalog_cache where chatbot_id = '<chatbotId>';"
```

If empty, trigger it manually:

```bash
curl -X POST http://localhost:4000/chatbots/<chatbotId>/woocommerce/sync \
  -H "Authorization: Bearer <your_access_token>"
```

Watch the **worker terminal** for `"product catalog synced"`. A
`getaddrinfo`/connection error there usually means `storeUrl` is wrong or
the host firewalls the REST API.

## 11. Test it

Open the chatbot's chat preview in the dashboard (or the embedded widget)
and ask about a real product — it should answer from live WooCommerce data,
not the crawled page text. Then try placing a full order to exercise
draft → confirm → real WooCommerce order → real payment link.

## Notes

- If ngrok isn't running when a payment webhook fires, it isn't lost — the
  `PaymentReconciliationJob` re-checks every ~10 minutes automatically and
  will still confirm it, just not instantly.
- ngrok's free-tier URL changes every time you restart it — you'll need to
  re-save the webhook URLs in WordPress if you restart the tunnel.
