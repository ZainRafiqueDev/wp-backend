import { app } from "./app.js"
import { env, getCreditGrantConfigError, hasDatabase, isCreditGrantingEnabled, isDemoSandbox, assertProductionGuards } from "./env.js"
import { pool } from "./lib/db.js"
import { baseLogger, describeConnectionUrl } from "./lib/logger.js"
import { creditGrantMetricFields } from "./lib/planEconomics.js"
import { redis } from "./lib/redis.js"

assertProductionGuards()
void import("./services/modelCosts.service.js").then((mod) => mod.refreshModelCostCache()).catch(() => undefined)

// A Redis that's up but pointed at the wrong host/port is otherwise
// invisible: ioredis (configured with maxRetriesPerRequest: null, required
// by BullMQ's blocking commands) queues commands and retries forever rather
// than rejecting, so redis.ping() itself would hang right along with every
// other command — an explicit race against a timeout is the only way to
// notice. This turns a silent multi-hour outage into a loud boot warning.
// Host/port/db only — REDIS_URL can carry the Redis password (B03-002).
Promise.race([
  redis.ping().then(() => "ok" as const),
  new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 3000)),
])
  .then((outcome) => {
    if (outcome === "ok") {
      baseLogger.info({ redis: describeConnectionUrl(env.redisUrl) }, "redis reachable at boot")
    } else {
      baseLogger.error(
        { redis: describeConnectionUrl(env.redisUrl) },
        "REDIS UNREACHABLE AT BOOT (timed out after 3s) — caching, rate limiting, and queues will hang or fail. Check REDIS_URL.",
      )
    }
  })
  .catch((err: unknown) => {
    baseLogger.error(
      { redis: describeConnectionUrl(env.redisUrl), err: err instanceof Error ? err.message : String(err) },
      "REDIS UNREACHABLE AT BOOT — caching, rate limiting, and queues will hang or fail. Check REDIS_URL.",
    )
  })

const server = app.listen(env.port, () => {
  baseLogger.info(
    {
      port: env.port,
      demoMode: isDemoSandbox ? "sandbox" : env.demoMode,
      database: hasDatabase ? "configured" : "not configured",
      creditGrantsEnabled: isCreditGrantingEnabled(),
      creditGrantConfigError: getCreditGrantConfigError(),
      ...creditGrantMetricFields(env.topupCreditUsd, env.topupSaleUsd),
      crawlPlusGrantUsd: env.crawlPlusPlanMonthlyCostCapUsd,
      crawlPlusSaleUsd: env.crawlPlusSaleUsd,
    },
    "chatmate360 backend listening",
  )
})


async function shutdown(signal: string) {
  baseLogger.info({ signal }, "api shutting down")
  server.close(async () => {
    await redis.quit().catch(() => {})
    if (pool) await pool.end().catch(() => {})
    process.exit(0)
  })
  
  setTimeout(() => process.exit(1), 10000).unref()
}

process.on("SIGTERM", () => void shutdown("SIGTERM"))
process.on("SIGINT", () => void shutdown("SIGINT"))
