# Public chat API

For customers building a custom chat UI instead of using the default embedded
widget. This is the exact same API the widget (`embed.js` + `/widget/:chatbotId`)
calls — same authorization checks, same rate limits, no separate or less-protected
surface for a custom integration.

Base URL: your Chatmate360 backend's origin (e.g. `https://api.yourdomain.com`).

## Required headers

| Header | Required | Notes |
|---|---|---|
| `X-Widget-Origin` | Yes | The real origin of the page making the request (e.g. `https://yourcompany.com`), not the API caller's own origin if you're proxying server-side. Must match (or be a subdomain of) the chatbot's configured allowed domain, or every request is rejected with `403`. |
| `Referer` | Recommended | Set automatically by browsers. A request whose `Referer` doesn't match the allowed domain is still accepted but is held to a much stricter rate limit — see below. |
| `Content-Type: application/json` | On `POST` | Required for the chat endpoint. |

## `GET /public/chatbots/:chatbotId`

Fetches the chatbot's public display config (name, theme) — no message content.

```
GET /public/chatbots/abc123
X-Widget-Origin: https://yourcompany.com
```

Response:

```json
{ "ok": true, "id": "abc123", "name": "Your Company", "theme": { "primaryColor": "#769656", "bgColor": "#ffffff", "textColor": "#1f2937" } }
```

## `POST /public/chatbots/:chatbotId/chat`

Sends a message and gets a grounded reply.

```
POST /public/chatbots/abc123/chat
X-Widget-Origin: https://yourcompany.com
Content-Type: application/json

{
  "message": "What are your business hours?",
  "history": [
    { "role": "user", "content": "Hi" },
    { "role": "assistant", "content": "Hello! How can I help?" }
  ]
}
```

- `message`: required, 1–2000 characters.
- `history`: optional, up to the last 20 turns, alternating `role: "user" | "assistant"`.

Response:

```json
{ "ok": true, "text": "We're open Monday–Friday, 9am–5pm.", "aiGenerated": true }
```

`aiGenerated: false` means the reply came from either the plain keyword-matcher
fallback (no AI provider configured, or every provider failed) or the fixed
out-of-scope template — never an improvised guess either way.

## Rate limits

- **20 requests/minute** per chatbot per requester IP by default
  (`PUBLIC_CHAT_RATE_LIMIT_PER_MIN`).
- **5 requests/minute** instead of the above when `Referer` doesn't corroborate
  `X-Widget-Origin` (`PUBLIC_CHAT_RATE_LIMIT_STRICT_PER_MIN`) — send a real
  browser `Referer` if you're building a client-side integration to avoid this
  tier.
- Exceeding either returns `429` with `{ "ok": false, "error": "..." }`.

## Errors

All error responses share the shape `{ "ok": false, "error": "<message>" }` with
an appropriate HTTP status (`400` invalid input, `403` domain not allowed, `404`
chatbot not found, `429` rate limited, `5xx` server error).

## A note on `X-Widget-Origin`

This header is a client-supplied signal, not a browser-enforced one — the
Referer cross-check and rate limiting above are what actually bound abuse once a
chatbot ID is public. If you're calling this API from your own backend (not a
browser), set `X-Widget-Origin` to your registered domain and expect the
stricter rate limit tier, since there's no browser `Referer` in that case.
