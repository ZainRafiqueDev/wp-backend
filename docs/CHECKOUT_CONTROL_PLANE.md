# WP-1.8 Checkout control plane

Self-serve Crawl Plus checkout is enabled by backend Stripe configuration, not a frontend boolean.

- `GET /billing/summary` returns `stripeConfigured` from `STRIPE_SECRET_KEY`.
- The dashboard (`shouldShowCrawlPlusCheckout`) shows Upgrade to Crawl Plus only when that flag is true and the account is not already on an active Crawl Plus or Full Custom plan.
- `POST /billing/checkout` still requires auth, valid grant env (`requireCreditGrantingEnabled`), and a live Stripe client.
- `billing.checkout_started` increments when Checkout session creation returns a URL.
- `billing.checkout_activated` increments after `checkout.session.completed` syncs a paid subscription (not a top-up).

Do not reintroduce `UPGRADE_CHECKOUT_ENABLED`. To stop offering checkout, unset Stripe keys or disable credit grants on the API host.
