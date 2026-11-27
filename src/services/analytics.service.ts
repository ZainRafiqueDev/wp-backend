import { verifyAccessToken } from "../lib/auth.js"
import { requireOwnedChatbotId } from "../lib/chatbotOwnership.js"
import { pool } from "../lib/db.js"
import { AppError } from "../lib/errors.js"
import { resolveTenantContext } from "../lib/tenancy.js"
import { currentBillingPeriod } from "./usage.service.js"

function requireDbPool() {
  if (!pool) throw new AppError(503, "Database is not configured. Set DATABASE_URL and JWT_SECRET.")
  return pool
}

export type AnalyticsSummary = {
  totalConversations: number
  totalVisitors: number
  tokensConsumed: number
  estimatedCostUsd: number
  billingPeriod: string
  note: string
}

export async function getAnalyticsForChatbot(accessToken: string, chatbotId: string): Promise<AnalyticsSummary> {
  const db = requireDbPool()
  const actorUserId = verifyAccessToken(accessToken)
  if (!actorUserId) throw new AppError(401, "Please sign in again.")
  const { tenantUserId } = await resolveTenantContext(actorUserId, "viewer")
  const ownedId = await requireOwnedChatbotId(tenantUserId, chatbotId)
  const billingPeriod = currentBillingPeriod()

  const [conversations, usage] = await Promise.all([
    db.query<{ conversations: string; visitors: string }>(
      `select count(*)::text as conversations,
              count(distinct session_id)::text as visitors
       from conversations where chatbot_id = $1`,
      [ownedId],
    ),
    db.query<{ tokens: string; cost: string }>(
      `select coalesce(sum(input_tokens + output_tokens), 0)::text as tokens,
              coalesce(sum(estimated_cost), 0)::text as cost
       from chatbot_usage
       where chatbot_id = $1 and billing_period = $2`,
      [ownedId, billingPeriod],
    ),
  ])

  return {
    totalConversations: Number(conversations.rows[0]?.conversations || 0),
    // Spec "visitors" — distinct widget session IDs until a dedicated visitor capture exists.
    totalVisitors: Number(conversations.rows[0]?.visitors || 0),
    tokensConsumed: Number(usage.rows[0]?.tokens || 0),
    estimatedCostUsd: Number(usage.rows[0]?.cost || 0),
    billingPeriod,
    note: "Visitors are counted as distinct chat session IDs (no conversation content is shown).",
  }
}
