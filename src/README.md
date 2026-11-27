# src/ — map

Express + TypeScript backend. Standard layering, strictly one-directional (routes → controllers → services → lib; nothing in `lib/` imports from `services/`, nothing in `services/` imports from `controllers/`):

| Directory | Role | Detail |
|---|---|---|
| **`routes/`** | Wires middleware + validators + controllers together per endpoint. No business logic, no handler bodies. | [`routes/README.md`](./routes/README.md) |
| **`controllers/`** | Thin: pull the request's inputs, await one service call, shape the JSON response. Never touches Postgres/Redis or checks ownership itself. | [`controllers/README.md`](./controllers/README.md) |
| **`services/`** | Owns business logic, database access, and every cross-tenant ownership/authorization check. The biggest directory by far (~6,100 lines). | [`services/README.md`](./services/README.md) |
| **`validators/`** | Zod request schemas, consumed by `middleware/validate.ts`. No logic beyond shape/format validation. | [`validators/README.md`](./validators/README.md) |
| **`middleware/`** | Auth gates, rate limiters (note: they don't all fail the same way on a Redis outage — see the README), request-id/error-handling plumbing. | [`middleware/README.md`](./middleware/README.md) |
| **`lib/`** | Framework-agnostic building blocks: the AI answering pipeline, crawler, document ingestion, crypto, auth tokens, caching, and the external-service connector subdirectories below. | [`lib/README.md`](./lib/README.md) |
| **`lib/crawler/`** | The website crawler + the shared SSRF guard (`assertSafeUrl`) reused by every other outbound connector in this codebase. | [`lib/crawler/README.md`](./lib/crawler/README.md) |
| **`lib/bookly/`** | HTTP client for a customer's own Bookly (booking engine) resource — two connectors, customer-facing and admin-facing, differently authenticated. | [`lib/bookly/README.md`](./lib/bookly/README.md) |
| **`lib/woocommerce/`** | HTTP client + deterministic payment-confirmation policy for a customer's own WooCommerce store. | [`lib/woocommerce/README.md`](./lib/woocommerce/README.md) |
| **`langgraph/`** | Three LangGraph conversational state machines (Bookly booking, WooCommerce ordering, Bookly admin-chat automation), all Full Custom plan only, all "propose → confirm → commit." | [`langgraph/README.md`](./langgraph/README.md) |
| **`data/`** | One static JSON file backing the sandboxed marketing-site demo chat. | [`data/README.md`](./data/README.md) |
| **`public/`** | The hand-written `embed.js` widget script, served directly by Express. | [`public/README.md`](./public/README.md) |

## Two things worth knowing before you start changing anything

1. **The answering pipeline is the center of gravity.** `lib/ai.ts` (multi-provider chain + prompt) and `lib/answerChatbotQuestion.ts` (the real orchestrator: gate check → context assembly → cache → relevance → model selection → cost-cap reservation → AI call → usage recording → grounding check) are what almost everything else in this backend ultimately feeds into or reads from. If you're not sure where a new context source or gating rule belongs, it's very likely one of these two files.
2. **This codebase has three separate "commit boundaries"** — `services/booklyBooking.service.ts`'s `commitBooking`, `services/commerceOrder.service.ts`'s `commitOrder` (via `services/orderState.service.ts`'s validated transition table), and Custom Actions' `lib/actionExecutor.ts`. Each is the *only* place its respective external write is allowed to happen, each is gated by an atomic idempotency claim or an explicit state-transition check before the external call, and none of them are called directly from a LangGraph node or the LLM's tool-calling loop — the LLM/graph only ever reaches a commit node, which then calls the service. If you're adding a new kind of external write, follow this same shape rather than calling a connector directly from wherever the idea to write originated.

## Where to look for project-level (not code-level) status

This `src/` tree and its READMEs describe *what the code does and how it's wired*, verified by reading it directly. For *current build/test status, known gaps, and what's changed recently*, see (repo root, one level up from `src/`):
- `CHATMATE360_SESSION_UPDATE.md` — the most recent session's changes (OTP, password-reset hardening, Stripe checkout UX, Google OAuth env, OpenAI-first model selection); read this **first** for anything touching auth/billing/model-selection, it supersedes older docs on those specific topics.
- `../PROJECT_STATE.md` (workspace root, one level above this repo) — a full, code-verified feature inventory across all four repos in this workspace (both ChatMate360 repos plus the separate Bookly/`helebooker` product), including a real trace of how ChatMate360 and Bookly communicate.
- `IMPLEMENTATION_STATUS.md` — the long-running, section-numbered implementation history (§1 through §24 as of this pass). Treat it as a lead list to verify against the real code, not as ground truth on its own — it has gone stale before and been corrected in place (see its own §8 and §23-24, and `PROJECT_STATE.md` §8 for a specific example of two sections that are easy to misread together).
- `RISK_LOG.md`, `PRODUCTION_READINESS_REPORT.md`, `INDEPENDENT_VERIFICATION_REPORT.md`, `DEPLOYMENT.md` — accepted risks, the original hardening pass, an outside verification pass, and how to actually deploy this.
