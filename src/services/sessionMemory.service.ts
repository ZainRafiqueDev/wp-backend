import { completeCheaply, type AiUsage } from "../lib/ai.js"
import { cheapCallAuthorizer } from "../lib/cheapCallBilling.js"
import { env } from "../env.js"
import { pool } from "../lib/db.js"
import { log } from "../lib/logger.js"
import { parseExtractedFacts, type ExtractedFact } from "../lib/memoryFacts.js"
import { hashToken } from "./notification.service.js"
import { recordUsage } from "./usage.service.js"

export interface SessionSummary {
  customerIdentifier: string
  summaryMd: string
  tokenCount: number
  interruptedByCreditExhaustion: boolean
}

/** WP-3.4: a durable, structured memory item, as opposed to the prose summary. */
export interface CustomerFact {
  key: string
  value: string
  confidence: number
  firstSeenAt: string
  lastSeenAt: string
}

function requireDbPool() {
  if (!pool) throw new Error("Database is not configured.")
  return pool
}

/** Hashed, chatbot-scoped identifier — never the plain email (master prompt's explicit rule for this table). */
export function customerIdentifierFromEmail(chatbotId: string, email: string): string {
  return hashToken(`${chatbotId}:${email.trim().toLowerCase()}`)
}

export async function getSessionSummary(chatbotId: string, customerIdentifier: string): Promise<SessionSummary | null> {
  if (!pool) return null
  const { rows } = await pool.query<{
    customer_identifier: string
    summary_md: string
    token_count: number
    interrupted_by_credit_exhaustion: boolean
  }>(
    `select customer_identifier, summary_md, token_count, interrupted_by_credit_exhaustion
     from session_summaries where chatbot_id = $1 and customer_identifier = $2`,
    [chatbotId, customerIdentifier],
  )
  const row = rows[0]
  if (!row) return null
  return {
    customerIdentifier: row.customer_identifier,
    summaryMd: row.summary_md,
    tokenCount: row.token_count,
    interruptedByCreditExhaustion: row.interrupted_by_credit_exhaustion,
  }
}

async function upsertSummary(
  chatbotId: string,
  customerIdentifier: string,
  summaryMd: string,
  tokenCount: number,
  interruptedByCreditExhaustion: boolean,
): Promise<void> {
  const db = requireDbPool()
  // Hard ceiling regardless of the ~400-word target the prompt asks for —
  // defense against a runaway/misbehaving model output growing this row
  // without bound.
  const trimmed = summaryMd.trim().slice(-8000)
  await db.query(
    `insert into session_summaries (chatbot_id, customer_identifier, summary_md, token_count, interrupted_by_credit_exhaustion)
     values ($1, $2, $3, $4, $5)
     on conflict (chatbot_id, customer_identifier) do update set
       summary_md = excluded.summary_md,
       token_count = excluded.token_count,
       interrupted_by_credit_exhaustion = excluded.interrupted_by_credit_exhaustion,
       updated_at = now()`,
    [chatbotId, customerIdentifier, trimmed, tokenCount, interruptedByCreditExhaustion],
  )
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function summaryPrompt(previousSummary: string, transcript: string): string {
  return `You are summarising a customer support conversation for future reference.
Create a concise summary (under 400 words) covering:
1. Customer's main question or problem
2. Products, orders, or topics discussed
3. Solutions or answers provided
4. Any unresolved questions or follow-up needed
5. Customer sentiment (satisfied / frustrated / neutral)

Be factual. Do not add opinions. Do not invent details not in the conversation.

Previous summary (if any):
${previousSummary || "(none)"}

New conversation to summarise:
${transcript}

Output only the summary. No preamble. No headings.`
}

/**
 * Regenerates the cross-session summary after a normal (non-blocked) turn,
 * folding the new exchange into whatever summary already existed. Costs
 * tenant AI credits (master prompt: "cost of summary generation is
 * deducted from tenant's AI credits") via a real, cheap-model LLM call —
 * unrelated to conversation.service.ts's free keyword-concatenation
 * in-session compaction, which solves a different problem (capping one
 * long-running conversation's own history, not cross-visit memory).
 *
 * Failures here are logged and swallowed, never thrown — this runs after
 * the turn has already been answered and recorded, so a memory-update
 * failure must never turn an already-successful answer into a failed
 * request.
 */
export async function updateSessionSummaryAfterTurn(
  chatbotId: string,
  customerIdentifier: string,
  question: string,
  answerText: string,
): Promise<void> {
  if (!pool) return
  try {
    const existing = await getSessionSummary(chatbotId, customerIdentifier)
    const transcript = `Customer: ${question}\nAssistant: ${answerText}`
    const usageSink: AiUsage[] = []
    const generated = await completeCheaply(
      summaryPrompt(existing?.summaryMd ?? "", transcript),
      "Output the summary now.",
      usageSink,
      cheapCallAuthorizer(chatbotId),
    )
    if (usageSink.length > 0) await recordUsage(chatbotId, usageSink)

    if (!generated) {
      log().warn({ chatbotId }, "session summary generation failed, no model available — keeping prior summary")
      return
    }

    // A new successful turn just happened, so any prior credit-exhaustion
    // interruption has been resolved — clear the flag here rather than
    // requiring a separate "acknowledgement" round trip.
    await upsertSummary(chatbotId, customerIdentifier, generated, estimateTokens(generated), false)
  } catch (err) {
    log().warn({ chatbotId, err: err instanceof Error ? err.message : String(err) }, "failed to update session summary")
  }
}

// ---------------------------------------------------------------------------
// WP-3.4 structured facts
// ---------------------------------------------------------------------------

export async function listCustomerFacts(chatbotId: string, customerIdentifier: string): Promise<CustomerFact[]> {
  if (!pool) return []
  const { rows } = await pool.query<{
    fact_key: string
    fact_value: string
    confidence: number
    first_seen_at: Date
    last_seen_at: Date
  }>(
    `select fact_key, fact_value, confidence, first_seen_at, last_seen_at
       from conversation_facts
      where chatbot_id = $1 and customer_identifier = $2
      order by last_seen_at desc
      limit $3`,
    [chatbotId, customerIdentifier, env.sessionMemoryMaxFacts],
  )
  return rows.map((row) => ({
    key: row.fact_key,
    value: row.fact_value,
    confidence: Number(row.confidence),
    firstSeenAt: row.first_seen_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
  }))
}

/**
 * Upserts by (chatbot, customer, key) so a restated fact refreshes rather than
 * duplicates, and keeps `first_seen_at` from the original sighting. Trims to
 * the configured ceiling afterwards, evicting least-recently-seen facts — this
 * table must not grow without bound per customer.
 */
export async function upsertCustomerFacts(
  chatbotId: string,
  customerIdentifier: string,
  facts: ExtractedFact[],
): Promise<number> {
  if (!pool || facts.length === 0) return 0

  for (const fact of facts) {
    await pool.query(
      `insert into conversation_facts (chatbot_id, customer_identifier, fact_key, fact_value, confidence)
       values ($1, $2, $3, $4, $5)
       on conflict (chatbot_id, customer_identifier, fact_key) do update set
         fact_value = excluded.fact_value,
         confidence = excluded.confidence,
         last_seen_at = now()`,
      [chatbotId, customerIdentifier, fact.key, fact.value, fact.confidence],
    )
  }

  await pool.query(
    `delete from conversation_facts
      where chatbot_id = $1
        and customer_identifier = $2
        and id not in (
          select id from conversation_facts
           where chatbot_id = $1 and customer_identifier = $2
           order by last_seen_at desc
           limit $3
        )`,
    [chatbotId, customerIdentifier, env.sessionMemoryMaxFacts],
  )

  return facts.length
}

function factExtractionPrompt(existingFacts: CustomerFact[], transcript: string): string {
  const known = existingFacts.length > 0
    ? existingFacts.map((fact) => `${fact.key}: ${fact.value}`).join("\n")
    : "(none)"

  return `Extract durable facts about this customer from a support conversation.

A durable fact is still true next week: their order number, product owned, shipping city,
plan, stated preference, or an open commitment made to them. Do NOT extract small talk,
the question itself, anything the assistant merely guessed, or anything already listed as known
unless the conversation changes its value.

Known facts:
${known}

Conversation:
${transcript}

Respond with ONLY a JSON array, no prose, no code fence:
[{"key":"snake_case_name","value":"short factual value","confidence":0.0-1.0}]
Return [] when the conversation contains no durable fact.`
}

/**
 * Extracts structured facts after a normal turn. Like the summary update this
 * charges the tenant's AI credits (ADR 0001: "charge summary tokens to the $8
 * budget") and never throws — memory is an enhancement layered on an answer
 * that has already been delivered.
 */
export async function extractFactsAfterTurn(
  chatbotId: string,
  customerIdentifier: string,
  question: string,
  answerText: string,
): Promise<number> {
  if (!pool || !env.sessionMemoryFactsEnabled) return 0
  try {
    const existing = await listCustomerFacts(chatbotId, customerIdentifier)
    const usageSink: AiUsage[] = []
    const raw = await completeCheaply(
      factExtractionPrompt(existing, `Customer: ${question}\nAssistant: ${answerText}`),
      "Output the JSON array now.",
      usageSink,
      cheapCallAuthorizer(chatbotId),
    )
    if (usageSink.length > 0) await recordUsage(chatbotId, usageSink)

    const facts = parseExtractedFacts(raw, env.sessionMemoryMaxFacts)
    if (facts.length === 0) return 0

    await upsertCustomerFacts(chatbotId, customerIdentifier, facts)
    log().info({ chatbotId, factCount: facts.length }, "extracted customer memory facts")
    return facts.length
  } catch (err) {
    log().warn({ chatbotId, err: err instanceof Error ? err.message : String(err) }, "failed to extract customer facts")
    return 0
  }
}

// ---------------------------------------------------------------------------
// WP-3.4 privacy: export, delete, retention
// ---------------------------------------------------------------------------

export interface CustomerMemoryExport {
  chatbotId: string
  customerIdentifier: string
  summary: { summaryMd: string; interruptedByCreditExhaustion: boolean; updatedAt: string } | null
  facts: CustomerFact[]
  exportedAt: string
}

/** Everything this product stores against one customer's memory identity. */
export async function exportCustomerMemory(
  chatbotId: string,
  customerIdentifier: string,
): Promise<CustomerMemoryExport> {
  const exportedAt = new Date().toISOString()
  if (!pool) {
    return { chatbotId, customerIdentifier, summary: null, facts: [], exportedAt }
  }

  const { rows } = await pool.query<{
    summary_md: string
    interrupted_by_credit_exhaustion: boolean
    updated_at: Date
  }>(
    `select summary_md, interrupted_by_credit_exhaustion, updated_at
       from session_summaries where chatbot_id = $1 and customer_identifier = $2`,
    [chatbotId, customerIdentifier],
  )
  const row = rows[0]

  return {
    chatbotId,
    customerIdentifier,
    summary: row
      ? {
          summaryMd: row.summary_md,
          interruptedByCreditExhaustion: row.interrupted_by_credit_exhaustion,
          updatedAt: row.updated_at.toISOString(),
        }
      : null,
    facts: await listCustomerFacts(chatbotId, customerIdentifier),
    exportedAt,
  }
}

/** Hard delete — GDPR erasure, not a soft flag. Returns rows removed. */
export async function deleteCustomerMemory(
  chatbotId: string,
  customerIdentifier: string,
): Promise<{ summariesDeleted: number; factsDeleted: number }> {
  if (!pool) return { summariesDeleted: 0, factsDeleted: 0 }

  const summaries = await pool.query(
    "delete from session_summaries where chatbot_id = $1 and customer_identifier = $2",
    [chatbotId, customerIdentifier],
  )
  const facts = await pool.query(
    "delete from conversation_facts where chatbot_id = $1 and customer_identifier = $2",
    [chatbotId, customerIdentifier],
  )

  log().info(
    { chatbotId, summariesDeleted: summaries.rowCount ?? 0, factsDeleted: facts.rowCount ?? 0 },
    "deleted customer memory on request",
  )
  return { summariesDeleted: summaries.rowCount ?? 0, factsDeleted: facts.rowCount ?? 0 }
}

/**
 * Retention sweep for cross-session memory. Run from the worker, never the
 * request path. A retention of 0 disables the purge entirely.
 */
export async function purgeExpiredCustomerMemory(): Promise<{ summariesPurged: number; factsPurged: number }> {
  if (!pool || env.sessionMemoryRetentionDays <= 0) return { summariesPurged: 0, factsPurged: 0 }

  const summaries = await pool.query(
    `delete from session_summaries where updated_at < now() - ($1 * interval '1 day')`,
    [env.sessionMemoryRetentionDays],
  )
  const facts = await pool.query(
    `delete from conversation_facts where last_seen_at < now() - ($1 * interval '1 day')`,
    [env.sessionMemoryRetentionDays],
  )

  const purged = { summariesPurged: summaries.rowCount ?? 0, factsPurged: facts.rowCount ?? 0 }
  if (purged.summariesPurged > 0 || purged.factsPurged > 0) {
    log().info({ ...purged, retentionDays: env.sessionMemoryRetentionDays }, "purged expired customer memory")
  }
  return purged
}

/**
 * Save-before-block: called right when monthly credit exhaustion is about
 * to block the customer (answerChatbotQuestion.ts), BEFORE the block
 * response is returned. Deliberately does NOT call the LLM — the tenant is
 * already out of monthly credit, so spending more on a summarization call
 * here would make the deficit worse (or simply get denied by the same cap
 * this function exists to react to). Instead it cheaply appends the
 * unanswered question to whatever summary already exists and flags the
 * interruption; the next successful turn (post top-up) calls
 * updateSessionSummaryAfterTurn above, which does the real LLM
 * re-summarization and clears the flag.
 */
export async function saveInterruptedByCreditExhaustion(
  chatbotId: string,
  customerIdentifier: string,
  question: string,
): Promise<void> {
  if (!pool) return
  try {
    const existing = await getSessionSummary(chatbotId, customerIdentifier)
    const note = `[Conversation interrupted — ran out of monthly AI credits before answering: "${question.trim().slice(0, 300)}"]`
    const nextSummary = [existing?.summaryMd, note].filter(Boolean).join("\n\n")
    await upsertSummary(chatbotId, customerIdentifier, nextSummary, estimateTokens(nextSummary), true)
  } catch (err) {
    log().warn({ chatbotId, err: err instanceof Error ? err.message : String(err) }, "failed to save interrupted session summary")
  }
}
