import { env } from "../env.js"
import { pool } from "../lib/db.js"
import { log } from "../lib/logger.js"
import { cacheRedis } from "../lib/redis.js"

const ABUSE_COUNTER_PREFIX = "abuse-window"


export async function recordCacheMissAndCheckAbuse(chatbotId: string, question: string): Promise<void> {
  try {
    const key = `${ABUSE_COUNTER_PREFIX}:${chatbotId}`
    const count = await cacheRedis.incr(key)
    if (count === 1) {
      await cacheRedis.expire(key, env.abuseWindowSeconds)
    }
    
    if (count === env.abuseRequestThreshold) {
      await flagAbuse(chatbotId, "sustained rate of cache-missing questions", {
        count,
        windowSeconds: env.abuseWindowSeconds,
        sampleQuestion: question.slice(0, 200),
      })
    }
  } catch (err) {
    log().warn({ chatbotId, err: err instanceof Error ? err.message : String(err) }, "abuse detection check failed")
  }
}

async function flagAbuse(chatbotId: string, reason: string, detail: Record<string, unknown>): Promise<void> {
  if (!pool) return

  const autoDeactivate = env.abuseAutoDeactivate
  try {
    await pool.query(
      "insert into chatbot_abuse_flags (chatbot_id, reason, detail, auto_deactivated) values ($1, $2, $3, $4)",
      [chatbotId, reason, JSON.stringify(detail), autoDeactivate],
    )
    log().warn({ chatbotId, reason, detail, autoDeactivated: autoDeactivate }, "chatbot flagged for suspected abuse")

  
    if (autoDeactivate) {
      await pool.query("update chatbots set is_active = false where id = $1", [chatbotId])
      log().warn({ chatbotId }, "chatbot auto-deactivated due to suspected abuse")
    }
  } catch (err) {
    log().warn({ chatbotId, err: err instanceof Error ? err.message : String(err) }, "failed to record abuse flag")
  }
}
