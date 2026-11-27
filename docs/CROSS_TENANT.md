# WP-1.7 Cross-tenant negative test pack

Application ownership (`requireOwnedChatbotId`) stays the isolation boundary. This pack makes a missing “other tenant 404” a CI failure, not a review-time hope.

## How to add a chatbot-scoped route

1. Mount the route (it will contain `:chatbotId`).
2. Add one row to `CHATBOT_SCOPED_ROUTES` in `tests/helpers/crossTenantRoutePack.ts`.
3. Add a test that contains the exact marker `CROSS_TENANT: METHOD /full/path`.
4. For owner-scoped dashboard routes, the attacker must receive **404** and the owner row must stay unchanged.
5. Public widget routes are intentionally reachable by chatbot id. Cover them with data-scope assertions, not owner 404s.
6. WooCommerce webhooks isolate by per-chatbot webhook secret. A signature for tenant A must not write `commerce_webhook_events` for tenant B.
7. `POST /chatbots/:chatbotId/bookly-admin-chat` authenticates with a Bookly admin session token, not the dashboard JWT. It must not return 200 for another tenant.

`tests/unit/crossTenantRoutePack.test.ts` parses `src/routes/chatbot.routes.ts`, `billing.routes.ts`, `public.routes.ts`, and `src/app.ts`. A new `:chatbotId` route without a catalog entry or covering marker fails CI.

Signup/Resend is not used. Tests SQL-seed users and sign JWTs locally.
