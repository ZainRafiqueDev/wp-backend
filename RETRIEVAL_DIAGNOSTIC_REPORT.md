# RETRIEVAL_DIAGNOSTIC_REPORT.md

_Generated 2026-09-22 against real local Postgres (`localhost:5435`) + Redis + live OpenAI answers. No mocks._

## 1. Current request pipeline

Traced from code (not docs). Authenticated dashboard chat and public widget share the same answering core.

| # | Stage | File / function |
|---|--------|-----------------|
| 1 | User query reception | `POST /chatbots/:chatbotId/chat` → `chatbot.controller.ts` → `chatWithOwnChatbot` (`services/chatbot.service.ts`); widget: `POST /public/chatbots/:chatbotId/chat` → `public.service.ts` |
| 2 | Conversation-context handling | `loadConversationContext` / `recordTurn` (`services/conversation.service.ts`); history passed into `answerChatbotQuestion` |
| 3 | Scope checking (pre-LLM) | **`hasRelevantContent`** (`lib/relevance.ts`) inside `answerChatbotQuestion` (`lib/answerChatbotQuestion.ts`). Fail → default fallback, **no AI call** |
| 4 | Embedding generation | `embedTexts` (`services/embeddings.service.ts`) — **only** for paid-plan document chunks / product catalog, **not** for crawled website pages |
| 5 | pgvector retrieval | `lookupRelevantDocumentChunks` (`services/documentIngestion.service.ts`): `ORDER BY embedding <=> $query LIMIT K`. No similarity threshold |
| 6 | Similarity filtering / thresholds | **None** on document path. Crawled pages are not vector-retrieved |
| 7 | Document chunk selection | Top-K chunks merged as `kind: "document"` pages |
| 8 | Grounding validation | Post-generation `verifyGroundedClaims` (`lib/groundingCheck.ts`) — prices/phones/emails/dates must appear in context |
| 9 | Prompt / context construction | `buildSystemPrompt` (`lib/ai.ts`) — LIVE / CRAWLED / DOCUMENT tiers + `_SCOPE_GUARD` / `_GROUNDING_GUARD` / `_INJECTION_GUARD` |
| 10 | Final LLM generation | `answerQuestion` (`lib/ai.ts`) — OpenAI-first selection via `selectModelForConversation` |
| 11 | Fallback / out-of-scope response | Relevance miss or grounding fail → `defaultFallbackMessage` / `answerFromSources` |

**Critical architectural fact:** crawled website content is **stuffed into the prompt** after a **keyword-overlap relevance gate**. Synonym “retrieval” failures on crawl-backed chatbots are therefore **gate failures**, not pgvector failures. This workspace’s chatbots under test had **zero** `chatbot_document_chunks` rows.

Also upstream of the RAG path (skipped when they handle the turn): commerce LangGraph (`tryAnswerWithCommerceGraph`) and Bookly LangGraph (`tryAnswerWithBooklyGraph`).

---

## 2. Historical reason for current scope behavior

### `_SCOPE_GUARD` (LLM prompt)

- **Git history exists** in this backend repo (unlike some other trees in the wider workspace that previously had none).
- Introduced in commit `40885ed` (2026-08-28) — *“Production hardening pass…”* by `ZainRafqiueDev`.
- Original inline comment (later removed in `79069d0` but preserved in git history):

  > Matches the project's own architecture doc, section 8 ("AI Hallucination Protection") … distinguish "on topic but not covered" from "genuinely unrelated" rather than collapsing both into a flat refusal.

- `IMPLEMENTATION_STATUS.md` confirms guards were ported from `aichatbot` as anti-hallucination measures.

**Classification: A + B (deliberate)** — intentional anti-hallucination **and** out-of-scope refusal, with an explicit two-case distinction (insufficient evidence vs unrelated). **Not** incidental. Tradeoff accepted: stricter refusals over fabricated answers.

### Relevance keyword gate (`hasRelevantContent`)

Separate from `_SCOPE_GUARD`. Documented in `src/lib/README.md` as a cheap pre-filter so off-topic questions never spend an AI call. Same hardening era; purpose is **cost/latency**, not semantic understanding.

---

## 3. Regression matrix results

### Controlled source (Step 2)

Inserted diagnostic chatbot `aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee` (**Acme Web Dev Diagnostic**) with a single known source:

> “Acme Co offers web development for small businesses. Contact us for a quote.”

Also cross-checked live crawl-backed bots:

- **DeveloperTag** (`c72f2a4c-…`) — rich pages including `/service/web-development` (vocabulary already overlaps paraphrases → many positives already passed *before* the fix).
- **ZARAR_PORTFOLIO** — “Web Developer” without “websites”/“development” → keyword gate fails most paraphrases (probe only).

Primary matrix below is on the **controlled Acme** bot (isolates the gate).

### Before (exact keyword gate, `length > 3`, no synonyms)

| # | Query | Relevance gate | Final user-visible result | Class |
|---|--------|----------------|---------------------------|--------|
| 1 | web development | PASS | Grounded AI answer | PASS |
| 2 | web dev | PASS* | Grounded AI answer | PASS |
| 3 | website development | PASS | Grounded AI answer | PASS |
| 4 | do you build websites? | **FAIL** | Default fallback (treated as OOS) | **A + B** |
| 5 | do you make sites? | **FAIL** | Default fallback | **A + B** |
| 6 | what web services do you provide? | **FAIL** | Default fallback | **A + B** |
| 7 | what is the weather tomorrow? | FAIL | Fallback | negative_control_ok |
| 8 | who won the world cup in 2018? | FAIL | Fallback | negative_control_ok |
| 9 | What programming languages do your web developers use? | **FAIL** | Fallback (wrongly OOS) | **A** (scope/evidence conflation) |

\*“web dev” passed only because both tokens are length ≤ 3 and were dropped → empty meaningful-word list → gate returns `true` (documented edge case).

Raw traces: `scripts/retrieval-diagnostic-before.json`.

---

## 4. Retrieval traces (summary)

For every Acme query:

- **Transformed query:** none (no rewriter in code path).
- **Embedding / pgvector:** skipped — free-plan entitlement `documentIngestion=false`; zero document chunks.
- **Top-5 pgvector candidates:** `[]` with note *“no document chunks for this chatbot (crawled-page path only)”*.
- **Similarity threshold:** N/A.
- **Grounding:** passed on all AI answers in the matrix (no fabricated prices/contacts).
- **Context to model:** the single Acme page text when the relevance gate allowed the call.

DeveloperTag secondary run (rich crawl) showed unrelated “world cup” can **false-positive** the old gate via substring overlap (`world` ∈ `world-class`), then `_SCOPE_GUARD` correctly declined — evidence the keyword gate is both **too strict** (synonyms) and **too loose** (accidental substrings) depending on corpus.

---

## 5. Failure classification per query (before)

| Query | Classes |
|--------|---------|
| 1–3 | None (pass) |
| 4–6 | **A** Scope classification failure (relevance keyword gate) + **B** Retrieval never reached (blocked before AI) |
| 7–8 | Correct reject |
| 9 | **A** — IN_SCOPE topic forced into OOS fallback; never reached `_SCOPE_GUARD` case (1) “don’t have that information” |

Not primarily: C (threshold), D (grounding), E (prompt) for 4–6 — those stages never ran.

---

## 6. Scope vs evidence (Step 6)

The architecture **incorrectly collapses** these at the relevance gate:

| | Intended | Actual pre-fix behavior |
|--|----------|---------------------------|
| Scope | IN / OUT / UNCERTAIN about the *site* | Approximated by **exact keyword overlap** with page text |
| Evidence | SUPPORTED / PARTIAL / INSUFFICIENT | Only applied later by `_SCOPE_GUARD` + grounding **if** the gate lets the call through |

Example (query 9): “What programming languages do your web developers use?” is **IN_SCOPE** for a web-dev business, evidence **INSUFFICIENT** on Acme’s one-line source. Before fix → OOS fallback. After fix → AI: *“I don’t have that information here…”* (correct `_SCOPE_GUARD` case 1). **No fabrication.**

---

## 7. Root cause(s)

**Smallest plausible root cause (proven):**

The pre-LLM relevance gate `hasRelevantContent` requires a question token (length > 3, minus stopwords) to appear as a **literal substring** of crawled page text. Synonym / paraphrase questions about content that *is* indexed therefore receive the **out-of-scope fallback** without ever consulting the LLM or embeddings.

Contributing factors (not primary for this matrix):

- Crawled pages do not use pgvector; there is no semantic retrieval stage to recover synonyms.
- Short tokens (`web`, `dev`, `site`) were excluded by `length > 3`.
- `_SCOPE_GUARD` itself is **not** the bug; when reached, it behaves as designed.

---

## 8. Scratch-fix experiment

**Change (only `lib/relevance.ts`):**

1. Count tokens with `length >= 3`.
2. Expand tokens via a **small closed synonym list** (web/site/website…, dev/development/developer…, service/services, app/application…) plus crude suffix stemming.
3. Match if any expanded question token appears in page text or expanded page tokens.

No query rewriter, no hybrid search, no threshold, no `_SCOPE_GUARD` edit, no pgvector replacement.

**Result:** fixing **only** this stage resolved the synonym failures. Hypothesis supported.

---

## 9. Before / after regression + negative controls

| # | Query | Before | After |
|---|--------|--------|-------|
| 1 | web development | PASS | PASS |
| 2 | web dev | PASS | PASS |
| 3 | website development | PASS | PASS |
| 4 | do you build websites? | **FAIL** | **PASS** (grounded) |
| 5 | do you make sites? | **FAIL** | **PASS** (grounded) |
| 6 | what web services do you provide? | **FAIL** | **PASS** (grounded) |
| 7 | weather | reject | reject |
| 8 | world cup | reject | reject |
| 9 | programming languages… | OOS fallback | **IN_SCOPE + insufficient** (“I don’t have that information here”) — **no fabrication** |

Raw after traces: `scripts/retrieval-diagnostic-after.json`.

---

## 10. Tradeoffs of the proposed / applied fix

| Upside | Downside |
|--------|----------|
| Synonym/paraphrase recall for common service vocabulary | Slightly more questions reach the LLM → more cost/latency |
| Restores intended Scope vs Evidence split for in-scope unsupported Qs | Closed synonym lists are incomplete (domain-specific jargon may still fail) |
| Negatives in this matrix still rejected | Broader synonym groups could increase false positives (mitigated by keeping the list narrow; `_SCOPE_GUARD` remains backstop) |
| No new infra (no File Search / Vector Store / hybrid) | Not a substitute for real semantic retrieval on large doc corpora |

---

## 11. Smallest recommended production change

**Apply the soft token expansion inside `hasRelevantContent` only** (`src/lib/relevance.ts`) — the scratch change above.

Do **not** (for this failure mode):

- Loosen `_SCOPE_GUARD`
- Replace PostgreSQL/pgvector
- Introduce OpenAI File Search / Vector Stores
- Add a general query-rewriting LLM hop
- Change document cosine thresholds (none exist; not on the failing path)

Optional follow-ups (only if new evidence appears): embedding-based relevance for large corpora; whole-word matching to reduce `world`∈`world-class` false positives.

**Status in this workspace:** the relevance change was **promoted from scratch after the after-matrix passed** so permanent unit tests are green. Reviewers who want a pure report-only tree can revert `src/lib/relevance.ts` and keep the failing-before cases documented here.

---

## 12. Permanent regression tests

Added to existing suite: `tests/unit/relevance.test.ts`

- Exact / abbreviation / synonym / paraphrase / informal / services paraphrases must pass against a “web development”-only page.
- Weather + world-cup negatives must fail the gate.
- Unsupported in-scope (“programming languages…”) must **pass the gate** (so the LLM can decline without fabricating) — locks the Scope≠Evidence distinction.

Verified: `npx vitest run tests/unit/relevance.test.ts` → **13/13 passed**.

---

## Repro helpers (not production)

- `scripts/retrievalDiagnostic.ts` — full live matrix + JSON traces
- `scripts/relevanceMatrixProbe.ts` — gate-only probe
- `scripts/seed-diagnostic-chatbot.sql` — controlled Acme chatbot seed
- Trace artifacts: `scripts/retrieval-diagnostic-before.json`, `scripts/retrieval-diagnostic-after.json`

```bash
# from backend repo root, with local Postgres/Redis/.env
npx tsx scripts/retrievalDiagnostic.ts
```
