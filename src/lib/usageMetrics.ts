import { log } from "./logger.js"
import { cacheRedis } from "./redis.js"

export type UsageMetricName =
  | "usage.monthly_blocked"
  | "usage.burst_blocked"
  | "usage.platform_limit"
  | "usage.provider_unavailable"

/**
 * Operational counters for WP-1.2 gate reasons.
 * Emits a structured log (searchable as `event`) and increments a Redis key
 * `metric:<name>:<YYYY-MM-DD>` with a 3-day TTL so production can scrape
 * without a separate metrics vendor.
 */
export async function incrementUsageMetric(
  name: UsageMetricName,
  fields: Record<string, unknown> = {},
): Promise<void> {
  log().info({ event: name, metric: name, ...fields }, name)
  try {
    const day = new Date().toISOString().slice(0, 10)
    const key = `metric:${name}:${day}`
    await cacheRedis.incr(key)
    await cacheRedis.expire(key, 3 * 24 * 60 * 60)
  } catch {
    // Metrics must never take the answering path down.
  }
}
