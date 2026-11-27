# src/public

Static assets served directly by Express — not a build output directory, hand-written files checked into the repo.

- **`embed.js`** (105 lines, vanilla JS, no build step, no dependencies) — the script every ChatMate360 customer pastes onto their own website. Reads `data-chatbot-id`/`data-widget-base`/`data-primary-color`/`data-bg-color`/`data-text-color` off its own `<script>` tag, renders a floating chat bubble, and on click mounts a hidden `<iframe>` pointing at `{data-widget-base}/widget/{chatbotId}?apiBase=...&parentOrigin=...` — i.e. the iframe is served from the **ChatMate360 frontend's own origin**, not the customer's page. This is the deliberate design that avoids needing permissive CORS for arbitrary customer domains: the iframe (same-origin as the frontend) is what actually calls the backend API, not the customer's page directly. See `Chatmate360-main/app/widget/[chatbotId]/page.tsx` for the iframe's own code, and `src/services/public.service.ts`'s `authorizePublicRequest` for how the backend still verifies the *customer's* real origin (via the `X-Widget-Origin` header the widget iframe sends, checked against the chatbot's configured `allowed_domain`).

Served two ways from `src/app.ts` (both `res.sendFile` the same file, both set `Cross-Origin-Resource-Policy: cross-origin` so it can be loaded as a `<script src>` from any customer domain):
- `GET /embed/v1/embed.js` — versioned path, cached 24h (`Cache-Control: public, max-age=86400, immutable`).
- `GET /embed.js` — short alias, cached 5min — kept for backward-compat with already-pasted snippets from before the versioned path existed.

If you edit `embed.js`, remember it ships to production the instant this file changes (no build/deploy step in front of it) — it's not compiled or bundled, what's in this file is byte-for-byte what a customer's browser downloads.
