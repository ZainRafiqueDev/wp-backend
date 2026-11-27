import { env } from "../env.js"
import { pool } from "./db.js"
import { AppError } from "./errors.js"
import { log } from "./logger.js"
import { cacheRedis } from "./redis.js"
import { setTenantContext } from "./tenantContext.js"

export type EmbedMetricName = "embed.calls" | "embed.blocked_budget"

export type EmbeddingBudgetReservation = {
  userId: string
  usageDay: string
  callCount: number
  tokenCount: number
  costUsd: number
}

export class EmbeddingBudgetError extends AppError {
  constructor(message = "Daily embedding budget exceeded.") {
    super(429, message)
    this.name = "EmbeddingBudgetError"
  }
}

export function embeddingUsageDay(now = new Date()): string {
  return now.toISOString().slice(0, 10)
}

/** Short queries cost less than 1e-6 USD; still bill a micro so the ledger cannot stall at 0. */
export function billedEmbeddingUsd(costUsd: number, tokenCount: number): number {
  if (tokenCount > 0) return Math.max(costUsd, 0.000001)
  return costUsd
}

export async function incrementEmbedMetric(
  name: EmbedMetricName,
  fields: Record<string, unknown> = {},
): Promise<void> {
  log().info({ event: name, metric: name, ...fields }, name)
  try {
    const day = embeddingUsageDay()
    const key = `metric:${name}:${day}`
    await cacheRedis.incr(key)
    await cacheRedis.expire(key, 3 * 24 * 60 * 60)
    const costUsd = typeof fields.costUsd === "number" ? fields.costUsd : null
    if (costUsd != null && Number.isFinite(costUsd) && costUsd > 0) {
      const costKey = `metric:embed.cost_usd:${day}`
      await cacheRedis.incrbyfloat(costKey, costUsd)
      await cacheRedis.expire(costKey, 3 * 24 * 60 * 60)
    }
  } catch {
    // Metrics must never take embedding down.
  }
}

export async function resolveEmbeddingTenantUserId(chatbotId: string): Promise<string> {
  if (!pool) throw new AppError(503, "Database is not configured. Set DATABASE_URL and JWT_SECRET.")
  const { rows } = await pool.query<{ user_id: string }>(`select user_id from chatbots where id = $1`, [chatbotId])
  if (!rows[0]?.user_id) {
    throw new AppError(404, "Chatbot not found.")
  }
  return rows[0].user_id
}

export async function reserveEmbeddingBudget(input: {
  chatbotId: string
  callCount: number
  tokenCount: number
  costUsd: number
  dailyBudgetUsd?: number
}): Promise<EmbeddingBudgetReservation> {
  if (!env.embeddingBudgetEnabled) {
    return {
      userId: "budget-disabled",
      usageDay: embeddingUsageDay(),
      callCount: input.callCount,
      tokenCount: input.tokenCount,
      costUsd: input.costUsd,
    }
  }
  if (!pool) {
    throw new EmbeddingBudgetError("Embedding budget cannot be checked because the database is unavailable.")
  }

  const dailyBudgetUsd = input.dailyBudgetUsd ?? env.embeddingDailyBudgetUsd
  if (!Number.isFinite(dailyBudgetUsd) || dailyBudgetUsd <= 0) {
    throw new EmbeddingBudgetError("Daily embedding budget is not configured.")
  }
  if (!Number.isFinite(input.costUsd) || input.costUsd < 0 || !Number.isFinite(input.tokenCount) || input.tokenCount < 0) {
    throw new EmbeddingBudgetError("Embedding cost estimate is invalid.")
  }
  const billedUsd = billedEmbeddingUsd(input.costUsd, input.tokenCount)

  if (billedUsd > dailyBudgetUsd) {
    await incrementEmbedMetric("embed.blocked_budget", {
      chatbotId: input.chatbotId,
      costUsd: input.costUsd,
      dailyBudgetUsd,
      reason: "single_call",
    })
    throw new EmbeddingBudgetError("This embedding request exceeds the daily embedding budget.")
  }

  const userId = await resolveEmbeddingTenantUserId(input.chatbotId)
  setTenantContext({ userId })
  const usageDay = embeddingUsageDay()
  const client = await pool.connect()
  try {
    await client.query("begin")
    await client.query(
      `insert into embedding_usage_daily (user_id, usage_day, call_count, token_count, cost_usd)
       values ($1, $2::date, 0, 0, 0)
       on conflict (user_id, usage_day) do nothing`,
      [userId, usageDay],
    )
    const { rows } = await client.query<{ call_count: number; token_count: string; cost_usd: string }>(
      `update embedding_usage_daily
       set call_count = call_count + $3,
           token_count = token_count + $4,
           cost_usd = cost_usd + $5
       where user_id = $1
         and usage_day = $2::date
         and cost_usd + $5 <= $6
       returning call_count, token_count, cost_usd`,
      [userId, usageDay, input.callCount, input.tokenCount, billedUsd, dailyBudgetUsd],
    )
    if (!rows[0]) {
      await client.query("rollback")
      await incrementEmbedMetric("embed.blocked_budget", {
        chatbotId: input.chatbotId,
        userId,
        costUsd: input.costUsd,
        dailyBudgetUsd,
        reason: "daily_cap",
      })
      throw new EmbeddingBudgetError("Daily embedding budget exceeded.")
    }
    await client.query("commit")
    return {
      userId,
      usageDay,
      callCount: Number(rows[0].call_count),
      tokenCount: Number(rows[0].token_count),
      costUsd: Number(rows[0].cost_usd),
    }
  } catch (err) {
    await client.query("rollback").catch(() => undefined)
    throw err
  } finally {
    client.release()
  }
}

export async function releaseEmbeddingBudget(input: {
  userId: string
  usageDay: string
  callCount: number
  tokenCount: number
  costUsd: number
}): Promise<void> {
  if (!env.embeddingBudgetEnabled || input.userId === "budget-disabled" || !pool) return
  setTenantContext({ userId: input.userId })
  const billedUsd = billedEmbeddingUsd(input.costUsd, input.tokenCount)
  await pool.query(
    `update embedding_usage_daily
     set call_count = greatest(0, call_count - $3),
         token_count = greatest(0, token_count - $4),
         cost_usd = greatest(0, cost_usd - $5)
     where user_id = $1 and usage_day = $2::date`,
    [input.userId, input.usageDay, input.callCount, input.tokenCount, billedUsd],
  )
}
