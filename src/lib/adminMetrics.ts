import { log } from "./logger.js"
import { cacheRedis } from "./redis.js"

export type AdminMetricName = "admin.plan_activated"

/**
 * Structured log plus Redis `metric:<name>:<YYYY-MM-DD>` with a 3-day TTL —
 * same scrape shape as billing and usage metrics.
 */
export async function incrementAdminMetric(
  name: AdminMetricName,
  fields: Record<string, unknown> = {},
): Promise<void> {
  log().info({ event: name, metric: name, ...fields }, name)
  try {
    const day = new Date().toISOString().slice(0, 10)
    const key = `metric:${name}:${day}`
    await cacheRedis.incr(key)
    await cacheRedis.expire(key, 3 * 24 * 60 * 60)
  } catch {
    // Metrics must never take an admin write down.
  }
}

/** Detaches admin-activated Full Custom from Stripe so webhooks cannot clobber it. */
export function adminActivatedCustomerId(userId: string): string {
  return `admin_activated_${userId}`
}
