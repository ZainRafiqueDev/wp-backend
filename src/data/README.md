# src/data

Static, non-code data bundled with the backend. Currently one file:

- **`demo-replies.json`** — an array of `{ keywords: string[], reply: string }` entries powering the public marketing site's "try a live demo" chat widget (`DEMO_MODE=sandbox`). Loaded once at import time by `src/services/demo.service.ts` via `readFileSync` (not a DB table) and matched by simple keyword lookup against the visitor's message — no AI call, no chatbot ownership, entirely sandboxed so a marketing-page visitor can never reach real chatbot data. Keep replies here generic/product-marketing in tone; this file has nothing to do with any real customer's chatbot content.

To add a new canned reply, add another `{ keywords, reply }` object — no code change needed, `demo.service.ts` reads the array length/shape dynamically.
