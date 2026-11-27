# Session memory (WP-3.4)

Cross-session memory lets a returning visitor be recognised without re-explaining themselves, while keeping the reply path fast and the stored data deletable on request.

```
turn ends
   ├─ updateSessionSummaryAfterTurn  → session_summaries (rolling prose summary)
   └─ extractFactsAfterTurn          → conversation_facts (structured key/value)

next turn
   listCustomerFacts + getSessionSummary  (loaded in parallel)
        ↓
   buildMemoryPages()  → memory:customer-facts, memory:customer-summary
        ↓
   answer prompt
```

## Identity

Memory is keyed by `customer_identifier` = `sha256(<chatbotId>:<lowercased email>)`, never a plain email. The hash is chatbot-scoped, so the same person talking to two different chatbots produces two unrelated identifiers and memory cannot be correlated across tenants.

A visitor with no identifier gets no memory at all — there is no device or IP fallback.

## What is stored

| Table | Contents | Scope |
| --- | --- | --- |
| `session_summaries` | Rolling prose summary of the relationship. | chatbot + customer |
| `conversation_facts` | Durable key/value facts with a confidence and first/last-seen timestamps. | chatbot + customer + fact key |
| `conversations.expires_at` | Idle TTL, refreshed on every turn. | conversation |
| `conversations.needs_compaction` | Set when the turn count crosses the summary threshold. | conversation |

All four are covered by RLS. `session_summaries` predates WP-3.4 and had **no** RLS policy before it; that gap is now closed in `db/rls.sql`.

Facts are capped at `SESSION_MEMORY_MAX_FACTS` per customer per chatbot. Past the cap, the least recently seen facts are evicted, so memory tracks what is still current rather than growing forever.

## Fact extraction

After each turn, `extractFactsAfterTurn` asks `completeCheaply()` (the same cheap Gemini→OpenAI fallback chain used for query rewriting and reranking) to pull durable facts out of the exchange. Parsing lives in `src/lib/memoryFacts.ts`, which is deliberately free of DB and AI imports so it can be unit-tested directly. It tolerates the usual model output sloppiness: prose wrapped around the JSON, duplicate keys (later wins), out-of-range confidences (clamped to 0–1, defaulting to 0.5), and over-long values (truncated to 500 characters).

Extraction is fail-open. It runs after the answer has already been produced, and any error is swallowed — a memory failure must never cost the visitor their reply. Its tokens are charged to the tenant via `recordUsage` like every other model call.

Set `SESSION_MEMORY_FACTS_ENABLED=false` to fall back to summary-only memory.

## Prompt assembly

`buildMemoryPages()` emits facts as a `memory:customer-facts` page **before** the `memory:customer-summary` page. Ordering is load-bearing: when the context budget forces truncation, the prose summary is dropped first and the compact structured facts survive, because the facts carry more signal per token.

## Compaction and TTL

Compaction used to run inline on the turn that crossed the threshold, making that one visitor pay for summarising the whole conversation. It is now a flag:

```sql
set needs_compaction = needs_compaction or (turn_count + 1) >= $2
```

The worker's conversation-maintenance tick (`runConversationMaintenanceTick`, every `CONVERSATION_MAINTENANCE_INTERVAL_MS`) picks up flagged conversations in batches of `CONVERSATION_COMPACT_BATCH_SIZE`, compacts them, sweeps conversations past `expires_at`, and purges cross-session memory older than `SESSION_MEMORY_RETENTION_DAYS`.

`CONVERSATION_TTL_DAYS` is an *idle* TTL — refreshed on every turn, so it means "days since the visitor last said anything", not age since creation.

## Privacy: export and delete

```
POST /public/chatbots/:chatbotId/memory/export
POST /public/chatbots/:chatbotId/memory/delete
```

## Who can reach a customer's memory

A `customerId` on its own is **not** a credential. It can leak through logs, screenshots or a shared device, so nothing accepts it as proof of identity.

- **Chat** (`POST /public/chatbots/:chatbotId/chat`) unlocks cross-session memory only with `customerToken`: a signed token bound to one customer and one chatbot, returned by `POST /auth/otp/verify` after an `ORDER_ACCESS` or `SENSITIVE_ACTION` code. Its lifetime is `CUSTOMER_SESSION_TTL_SECONDS` (default 30 days). Without a valid token the visitor is treated as anonymous. A `customerId` in the body is ignored.
- **Export and delete** need a **fresh** OTP `proofToken` in the body: `{ "proofToken": "..." }`, from the same verify call, with purpose `ORDER_ACCESS` or `SENSITIVE_ACTION`, issued for this chatbot and valid for `OTP_PROOF_TTL_SECONDS` (default 15 minutes). The customer is read from the token, never from the body. A missing, forged, expired, wrong-purpose or wrong-chatbot token returns **401**. A valid token whose customer has no memory here returns **404**.

The token goes in the **body**, not the URL. Export is a POST for exactly this reason: a GET would leave credentials in browser history, referrer headers, and access logs. Both endpoints share the `rateLimitPublicChat` bucket.

**Widget change required:** after OTP verification, store `customerToken` (not `customerId`) and send it on chat. For export/delete, run an OTP verification and send the resulting `proofToken`.

## Environment

| Env | Default | Meaning |
| --- | --- | --- |
| `CONVERSATION_TTL_DAYS` | `30` | Idle TTL before a conversation is swept. |
| `CONVERSATION_MAINTENANCE_INTERVAL_MS` | `60000` | Worker tick interval. |
| `CONVERSATION_COMPACT_BATCH_SIZE` | `25` | Conversations compacted per tick. |
| `SESSION_MEMORY_RETENTION_DAYS` | `180` | Memory purge age. `0` disables the purge. |
| `SESSION_MEMORY_FACTS_ENABLED` | `true` | Off = summary-only memory. |
| `SESSION_MEMORY_MAX_FACTS` | `25` | Facts kept per customer per chatbot. |
| `CUSTOMER_SESSION_TTL_SECONDS` | `2592000` | Lifetime of the widget `customerToken` (30 days). |

## Testing hazard

`tests/integration/advancedSessionMemory.integration.test.ts` mocks `completeCheaply` and branches on `prompt.includes("Extract durable facts")`. Any new test that reaches `lookupRelevantDocumentChunks` with real document chunks seeded **must** carry the same `src/lib/ai.js` mock, or it will quietly make real network calls against the production API keys in this environment's `.env`.
