import { log } from "./logger.js"
import { cacheRedis } from "./redis.js"

export type BillingMetricName = "billing.checkout_started" | "billing.checkout_activated"

/**
 * Operational counters for WP-1.8 self-serve checkout.
 * Structured log (`event`) plus Redis `metric:<name>:<YYYY-MM-DD>` with a
 * 3-day TTL — same scrape shape as usage and Stripe inbox metrics.
 */
export async function incrementBillingMetric(
  name: BillingMetricName,
  fields: Record<string, unknown> = {},
): Promise<void> {
  log().info({ event: name, metric: name, ...fields }, name)
  try {
    const day = new Date().toISOString().slice(0, 10)
    const key = `metric:${name}:${day}`
    await cacheRedis.incr(key)
    await cacheRedis.expire(key, 3 * 24 * 60 * 60)
  } catch {
    // Metrics must never take checkout or webhook processing down.
  }
}
