# Admin Dashboard Setup

The admin surface (`/admin/*`) is deliberately separate from customer
accounts — its own table (`admin_users`), its own JWT scope (`typ: "admin"`,
never valid on a customer route), no self-service signup route. This is by
design: a compromised customer account must never be a path into it.

## Creating the first admin account

There is no `POST /admin/signup`. Create an admin user from a machine with
`DATABASE_URL` access:

```
npm run create-admin -- "Your Name" you@example.com "a strong password"
```

This inserts one row into `admin_users` (password bcrypt-hashed, same as a
customer account) and exits. Run it again with a different email to add
another admin.

## Logging in

`POST /admin/login` with `{ "email": "...", "password": "..." }` returns an
`access_token` scoped `typ: "admin"` (`ADMIN_ACCESS_TOKEN_TTL_SECONDS`,
default 8 hours — shorter-lived than a customer session by design). Every
other `/admin/*` route requires `Authorization: Bearer <that token>` and
re-verifies it on every request (`src/middleware/requireAdminAuth.ts`) —
there is no refresh-token flow for admin sessions in this pass; re-login
once it expires.

## What the admin surface can do

- `GET /admin/users?search=` — list/search users with plan, trial status,
  and current-billing-period token usage.
- `POST /admin/users/:id/deactivate` / `.../activate` — soft-disable a
  user's login and all their chatbots' public widget traffic, without
  touching their data.
- `DELETE /admin/users/:id` with body `{ "confirm": true }` — permanent,
  cascading deletion (chatbots, sources, live-data, actions, usage,
  conversations — everything).
- `GET /admin/users/:id/usage` — that user's token/cost breakdown by
  chatbot and billing period.
- `POST /admin/users/:id/activate-plan` — senior-only Full Custom
  activation after meeting and payment. Body:
  `{ plan: "full_custom", monthlyCreditUsd, allowedModels, cashCollectedUsd, overrideReason? }`.
  Monthly credits must be `< cashCollectedUsd`. Credits above
  `cashCollectedUsd × ADMIN_PLAN_AI_BUDGET_RATIO` (same ledger as Crawl
  Plus) require `overrideReason`. This does **not** grant Custom Actions
  (Crawl Plus + model top-up only). The row is detached from Stripe
  (`stripe_customer_id = admin_activated_<userId>`) so a later
  subscription webhook cannot clobber it. Cancel with the existing
  `POST /admin/users/:id/cancel-subscription` path. There is no
  self-serve Full Custom checkout.
- `GET /admin/abuse-flags` / `POST /admin/abuse-flags/:id/review` — review
  chatbots flagged by automated abuse detection
  (`src/services/abuseDetection.service.ts`).

Every write above is recorded in `admin_audit_log` (who, what, on which
user, when) independent of the normal request logs.

## Frontend

`Chatmate360-main/app/admin/` is a small, separate route tree in the same
Next.js app — it does NOT share `lib/session.ts` (the customer auth
storage) at all; it keeps its own `admin_access_token` in
`sessionStorage` under a different key, and its layout has no link to or
from the customer dashboard. There's no reason it couldn't be split into
its own deployable app later if that becomes worth the operational cost;
for MVP it's simpler to ship as one more route in the existing app.
