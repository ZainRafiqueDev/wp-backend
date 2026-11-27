import { env } from "../env.js"
import { pool } from "../lib/db.js"
import { log } from "../lib/logger.js"
import { purgeExpiredCustomerMemory } from "./sessionMemory.service.js"

interface ChatMessage {
  role: "user" | "assistant"
  content: string
}


const MAX_SUMMARY_CHARS = 1500

function requireDbPool() {
  if (!pool) throw new Error("Database is not configured.")
  return pool
}


/** WP-3.4 idle TTL. Refreshed on every turn, so it measures silence, not age. */
function ttlExpiryClause(): string {
  return `now() + (${Number(env.conversationTtlDays)} * interval '1 day')`
}

async function getOrCreateConversation(
  chatbotId: string,
  sessionId: string,
): Promise<{ id: string; summary: string | null; turnCount: number; pinnedModel: string | null }> {
  const db = requireDbPool()
  const { rows } = await db.query<{ id: string; summary: string | null; turn_count: number; pinned_model: string | null }>(
    `insert into conversations (chatbot_id, session_id, expires_at)
     values ($1, $2, ${ttlExpiryClause()})
     on conflict (chatbot_id, session_id) do update set updated_at = conversations.updated_at
     returning id, summary, turn_count, pinned_model`,
    [chatbotId, sessionId],
  )
  const row = rows[0]
  return { id: row.id, summary: row.summary, turnCount: row.turn_count, pinnedModel: row.pinned_model }
}

export interface ConversationContext {
  conversationId: string
  history: ChatMessage[]
  pinnedModel: string | null
}


export async function loadConversationContext(chatbotId: string, sessionId: string): Promise<ConversationContext> {
  const db = requireDbPool()
  const conversation = await getOrCreateConversation(chatbotId, sessionId)

  const { rows } = await db.query<{ role: string; content: string }>(
    "select role, content from messages where conversation_id = $1 order by created_at desc limit $2",
    [conversation.id, env.conversationContextTurns * 2],
  )
  const recent: ChatMessage[] = rows.reverse().map((r) => ({ role: r.role as "user" | "assistant", content: r.content }))

  const history: ChatMessage[] = conversation.summary
    ? [{ role: "assistant", content: `[Summary of earlier conversation: ${conversation.summary}]` }, ...recent]
    : recent

  return { conversationId: conversation.id, history, pinnedModel: conversation.pinnedModel }
}

// Phase 3 follow-up (2026-10-27): names only, never content — used to build
// an always-included "the bot can't see this file" reminder in
// answerChatbotQuestion.ts, independent of the chat_attachments module
// (lives here, not in chatAttachments.service.ts, to avoid a service
// import cycle through public.service.ts). Only 'clean' attachments count —
// a quarantined or denied one was never shown to the visitor as accepted,
// so the bot has nothing to reference. Most recent few only, chronological.
export async function listRecentAttachmentFilenames(conversationId: string, limit = 3): Promise<string[]> {
  const db = requireDbPool()
  const { rows } = await db.query<{ original_file_name: string }>(
    `select original_file_name from chatbot_attachments
       where conversation_id = $1 and status = 'clean'
       order by created_at desc limit $2`,
    [conversationId, limit],
  )
  return rows.map((r) => r.original_file_name).reverse()
}


export async function pinModelIfUnset(conversationId: string, model: string): Promise<void> {
  if (!pool) return
  try {
    await pool.query(
      "update conversations set pinned_model = $1 where id = $2 and pinned_model is null",
      [model, conversationId],
    )
  } catch (err) {
    log().warn({ conversationId, model, err: err instanceof Error ? err.message : String(err) }, "failed to pin conversation model")
  }
}


function foldIntoSummary(existingSummary: string | null, oldMessages: { role: string; content: string }[]): string {
  const userQuestions = oldMessages
    .filter((m) => m.role === "user")
    .map((m) => m.content.trim())
    .filter(Boolean)
  const merged = [existingSummary, ...userQuestions].filter(Boolean).join(" | ")
  return merged.length > MAX_SUMMARY_CHARS ? merged.slice(merged.length - MAX_SUMMARY_CHARS) : merged
}


/**
 * WP-3.4: compaction runs on the worker (see `conversation-maintenance-tick`),
 * never on the chat request path — ADR 0001 flags compact-on-hot-path as a
 * scale problem, since it reads every message of the longest conversations
 * while a visitor waits for an answer.
 *
 * Returns the number of messages folded away, 0 when this conversation turned
 * out not to need compaction after all (the flag is set optimistically by
 * `recordTurn`, which deliberately does not read the message table).
 */
export async function compactConversation(conversationId: string): Promise<number> {
  const db = requireDbPool()
  const { rows: convRows } = await db.query<{ summary: string | null; turn_count: number }>(
    "select summary, turn_count from conversations where id = $1",
    [conversationId],
  )
  const conversation = convRows[0]
  if (!conversation) return 0

  const clearFlag = async () => {
    await db.query("update conversations set needs_compaction = false where id = $1", [conversationId])
  }

  if (conversation.turn_count < env.conversationSummaryThresholdTurns) {
    await clearFlag()
    return 0
  }

  const keepMessages = env.conversationContextTurns * 2
  const { rows: allMessages } = await db.query<{ id: string; role: string; content: string }>(
    "select id, role, content from messages where conversation_id = $1 order by created_at asc",
    [conversationId],
  )
  if (allMessages.length <= keepMessages) {
    await clearFlag()
    return 0
  }

  const toCompact = allMessages.slice(0, allMessages.length - keepMessages)
  const nextSummary = foldIntoSummary(conversation.summary, toCompact)

  await db.query(
    "delete from messages where id = any($1::uuid[])",
    [toCompact.map((m) => m.id)],
  )
  await db.query(
    "update conversations set summary = $1, needs_compaction = false where id = $2",
    [nextSummary, conversationId],
  )
  log().info({ conversationId, compactedCount: toCompact.length }, "conversation history compacted into summary")
  return toCompact.length
}

/** Oldest-flagged first, so a busy chatbot cannot starve a quiet one. */
export async function findConversationsNeedingCompaction(limit: number): Promise<string[]> {
  if (!pool) return []
  const { rows } = await pool.query<{ id: string }>(
    `select id from conversations
      where needs_compaction
      order by updated_at asc
      limit $1`,
    [limit],
  )
  return rows.map((row) => row.id)
}

/**
 * Deletes conversations whose idle TTL has passed. `messages` rows go with
 * them via the existing on-delete-cascade foreign key. A new session with the
 * same localStorage id simply starts fresh — deliberately no inheritance of an
 * expired conversation's summary (ADR 0001).
 */
export async function sweepExpiredConversations(limit = 500): Promise<number> {
  if (!pool) return 0
  const { rowCount } = await pool.query(
    `delete from conversations
      where id in (
        select id from conversations
         where expires_at is not null and expires_at < now()
         order by expires_at asc
         limit $1
      )`,
    [limit],
  )
  const deleted = rowCount ?? 0
  if (deleted > 0) log().info({ deleted }, "expired idle conversations swept")
  return deleted
}

export interface ConversationMaintenanceResult {
  compacted: number
  compactedMessages: number
  expired: number
  memoryPurged: number
}

/**
 * One worker tick: compact flagged conversations, expire idle ones, purge
 * cross-session memory past its retention window. Each stage is independent,
 * so a failure in one never blocks the others — this is a janitor, and a
 * janitor that dies on the first locked door is worse than no janitor.
 */
export async function runConversationMaintenanceTick(): Promise<ConversationMaintenanceResult> {
  const result: ConversationMaintenanceResult = { compacted: 0, compactedMessages: 0, expired: 0, memoryPurged: 0 }
  if (!pool) return result

  for (const conversationId of await findConversationsNeedingCompaction(env.conversationCompactBatchSize)) {
    try {
      const messages = await compactConversation(conversationId)
      if (messages > 0) {
        result.compacted += 1
        result.compactedMessages += messages
      }
    } catch (err) {
      log().warn(
        { conversationId, err: err instanceof Error ? err.message : String(err) },
        "conversation compaction failed, will retry next tick",
      )
    }
  }

  try {
    result.expired = await sweepExpiredConversations()
  } catch (err) {
    log().warn({ err: err instanceof Error ? err.message : String(err) }, "conversation expiry sweep failed")
  }

  try {
    const purged = await purgeExpiredCustomerMemory()
    result.memoryPurged = purged.summariesPurged + purged.factsPurged
  } catch (err) {
    log().warn({ err: err instanceof Error ? err.message : String(err) }, "customer memory retention purge failed")
  }

  try {
    const { maybeAlertOkfStale } = await import("./alerts.service.js")
    await maybeAlertOkfStale()
  } catch (err) {
    log().warn({ err: err instanceof Error ? err.message : String(err) }, "okf stale alert tick failed")
  }

  return result
}

export async function recordTurn(conversationId: string, question: string, answer: string): Promise<void> {
  if (!pool) return
  try {
    await pool.query(
      "insert into messages (conversation_id, role, content) values ($1, 'user', $2), ($1, 'assistant', $3)",
      [conversationId, question, answer],
    )
    // One statement, no reads: flag compaction for the worker and push the
    // idle TTL out. The threshold comparison is against the incremented value.
    await pool.query(
      `update conversations
          set turn_count = turn_count + 1,
              updated_at = now(),
              expires_at = ${ttlExpiryClause()},
              needs_compaction = needs_compaction or (turn_count + 1) >= $2
        where id = $1`,
      [conversationId, env.conversationSummaryThresholdTurns],
    )
  } catch (err) {
    log().warn({ conversationId, err: err instanceof Error ? err.message : String(err) }, "failed to record conversation turn")
  }
}
