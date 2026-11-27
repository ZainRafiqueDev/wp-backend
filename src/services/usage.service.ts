import type { AiUsage } from "../lib/ai.js"
import { env } from "../env.js"
import { estimateCostUsd } from "../lib/aiPricing.js"
import type { ModelKey } from "../lib/plans.js"
import { log } from "../lib/logger.js"
import { pool } from "../lib/db.js"
import { cacheRedis } from "../lib/redis.js"
import { fromMicroUsd, toMicroUsd } from "../lib/microUsd.js"
import { getEntitlementForChatbot, type Entitlement } from "./billing.service.js"
import { createNotification } from "./notification.service.js"
import { verifyAccessToken } from "../lib/auth.js"
import { requireOwnedChatbotId } from "../lib/chatbotOwnership.js"
import { resolveTenantContext } from "../lib/tenancy.js"
import { AppError } from "../lib/errors.js"
import { incrementUsageMetric } from "../lib/usageMetrics.js"


export function currentBillingPeriod(): string {
  const now = new Date()
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`
}

// Calendar-day period key, UTC — e.g. "2026-09-18". A new key every day
// means the daily cap "refreshes" for free: there's nothing to reset, the
// previous day's key simply stops being the current one.
export function currentDayPeriod(): string {
  const now = new Date()
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`
}

// ISO-8601 week period key, UTC — e.g. "2026-W38". Same "refreshes for
// free" reasoning as currentDayPeriod: a new week gets a new key.
export function currentWeekPeriod(): string {
  const now = new Date()
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const isoDayOfWeek = (date.getUTCDay() + 6) % 7 // Monday = 0 ... Sunday = 6
  date.setUTCDate(date.getUTCDate() - isoDayOfWeek + 3) // nearest Thursday determines the ISO week/year
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4))
  const firstThursdayDayOfWeek = (firstThursday.getUTCDay() + 6) % 7
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThursdayDayOfWeek + 3)
  const weekNumber = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86400000))
  return `${date.getUTCFullYear()}-W${String(weekNumber).padStart(2, "0")}`
}

export type UsageWindow = "day" | "week" | "month"
export const USAGE_WINDOWS: UsageWindow[] = ["day", "week", "month"]

export function periodKeyForWindow(window: UsageWindow): string {
  if (window === "day") return currentDayPeriod()
  if (window === "week") return currentWeekPeriod()
  return currentBillingPeriod()
}

function capForWindow(entitlement: Entitlement, window: UsageWindow): number {
  if (window === "day") return entitlement.perModelDailyCapUsd
  if (window === "week") return entitlement.perModelWeeklyCapUsd
  return entitlement.perModelCapUsd
}

const USAGE_CACHE_PREFIX = "chatbot-usage-cost"
const USAGE_CACHE_TTL_SECONDS = 3600

// cacheRedis (lib/redis.ts) now carries a bounded maxRetriesPerRequest of
// its own, separate from the BullMQ-constrained `redis` client this file
// used to share — so this wrapper is no longer the *only* thing standing
// between an unreachable Redis and a hung request. Left in place anyway as
// a second, explicit bound: every catch block below exists to fail the
// request open, and this guarantees that happens within 1.5s regardless of
// whatever the client's own retry/backoff timing works out to.
const REDIS_OP_TIMEOUT_MS = 1500

function withRedisTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`redis operation timed out after ${REDIS_OP_TIMEOUT_MS}ms`)), REDIS_OP_TIMEOUT_MS)
    }),
  ])
}

// Same defensive pattern, for the reservation ledger's Postgres writes
// (insertOrGetReservation / reconcileReservation / expireReservationNow
// below) — these are brand-new query paths this session; a slow/contended
// pool connection here must degrade to a fast, caught failure (falling
// back to Redis-only enforcement, same as a Redis timeout does) rather
// than hang the whole answer indefinitely, exactly the class of bug the
// Redis timeout above was already written to prevent.
const PG_OP_TIMEOUT_MS = 2000

function withPgTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`postgres operation timed out after ${PG_OP_TIMEOUT_MS}ms`)), PG_OP_TIMEOUT_MS)
    }),
  ])
}

function modelUsageCacheKey(chatbotId: string, period: string, model: string): string {
  return `${USAGE_CACHE_PREFIX}:${chatbotId}:${period}:${model}`
}

function accountUsageCacheKey(userId: string, period: string): string {
  return `account-usage-cost:${userId}:${period}`
}

async function getChatbotOwnerId(chatbotId: string): Promise<string | null> {
  if (!pool) return null
  const { rows } = await withPgTimeout(pool.query<{ user_id: string }>(
    "select user_id from chatbots where id = $1",
    [chatbotId],
  ))
  return rows[0]?.user_id ?? null
}

async function getAccountCreditUsd(userId: string, window: UsageWindow): Promise<number> {
  if (!pool || window !== "month") return 0
  const { rows } = await withPgTimeout(pool.query<{ total: string | null }>(
    `select sum(mc.credited_usd) as total
     from chatbot_model_credits mc
     join chatbots c on c.id = mc.chatbot_id
     where c.user_id = $1 and mc.billing_period = $2`,
    [userId, currentBillingPeriod()],
  ))
  return Number(rows[0]?.total) || 0
}

async function accountCapForWindow(userId: string, entitlement: Entitlement, window: UsageWindow): Promise<number> {
  return capForWindow(entitlement, window) + await getAccountCreditUsd(userId, window)
}


export async function getModelPeriodCostUsd(chatbotId: string, model: string, window: UsageWindow = "month"): Promise<number> {
  const period = periodKeyForWindow(window)
  const key = modelUsageCacheKey(chatbotId, period, model)

  try {
    const cached = await withRedisTimeout(cacheRedis.get(key))
    if (cached !== null) return Number(cached) || 0
  } catch (err) {
    log().warn({ chatbotId, model, window, err: err instanceof Error ? err.message : String(err) }, "usage cache read failed")
  }

  if (!pool) return 0
  const { rows } = await pool.query<{ estimated_cost: string }>(
    "select estimated_cost from chatbot_usage where chatbot_id = $1 and billing_period = $2 and model = $3",
    [chatbotId, period, model],
  )
  const cost = rows[0] ? Number(rows[0].estimated_cost) : 0
  try {
    await withRedisTimeout(cacheRedis.set(key, String(cost), "EX", USAGE_CACHE_TTL_SECONDS))
  } catch {

  }
  return cost
}


export async function getCurrentPeriodCostUsd(chatbotId: string): Promise<number> {
  if (!pool) return 0
  const { rows } = await pool.query<{ total: string | null }>(
    "select sum(estimated_cost) as total from chatbot_usage where chatbot_id = $1 and billing_period = $2",
    [chatbotId, currentBillingPeriod()],
  )
  return Number(rows[0]?.total) || 0
}


const CONVERSATION_PERIOD_FORMAT: Record<UsageWindow, string> = {
  day: "YYYY-MM-DD",
  week: 'IYYY-"W"IW', // Postgres ISO year/week — matches currentWeekPeriod()'s "2026-W38" shape
  month: "YYYY-MM",
}

export async function getConversationCountForPeriod(chatbotId: string, period: string, window: UsageWindow = "month"): Promise<number> {
  if (!pool) return 0
  const { rows } = await pool.query<{ count: string }>(
    `select count(*) as count from conversations where chatbot_id = $1 and to_char(created_at, '${CONVERSATION_PERIOD_FORMAT[window]}') = $2`,
    [chatbotId, period],
  )
  return Number(rows[0]?.count) || 0
}


export async function getModelPeriodCreditUsd(chatbotId: string, model: string): Promise<number> {
  if (!pool) return 0
  const { rows } = await pool.query<{ total: string | null }>(
    "select sum(credited_usd) as total from chatbot_model_credits where chatbot_id = $1 and billing_period = $2 and model = $3",
    [chatbotId, currentBillingPeriod(), model],
  )
  return Number(rows[0]?.total) || 0
}


// Top-up credits (topup.service.ts) are sold and tracked per calendar
// month — applying them to the day/week windows too would let one top-up
// silently blow through the whole point of a daily/weekly cap (smoothing
// burst spend), so credit only ever offsets the monthly cap.
export async function getEffectiveModelCapUsd(
  chatbotId: string,
  entitlement: Entitlement,
  model: string,
  window: UsageWindow = "month",
): Promise<number> {
  if (window !== "month") return capForWindow(entitlement, window)
  const credit = await getModelPeriodCreditUsd(chatbotId, model)
  return entitlement.perModelCapUsd + credit
}

// --- Platform-wide budget ceiling (tokenallocation.md §2) ---------------
// Same day/week/month windowing as per-tenant caps, but summed across every
// chatbot, keyed by a constant instead of chatbotId. Checked as "step 0",
// before any per-tenant logic, in reserveModelCostSlot below.

const PLATFORM_USAGE_CACHE_KEY_PREFIX = "platform-usage-cost"

function platformUsageCacheKey(period: string): string {
  return `${PLATFORM_USAGE_CACHE_KEY_PREFIX}:${period}`
}

function platformCapForWindow(window: UsageWindow): number {
  if (window === "day") return env.platformDailyCostCapUsd
  if (window === "week") return env.platformWeeklyCostCapUsd
  return env.platformMonthlyCostCapUsd
}

// UTC start-of-window instant, used only to seed the platform counter from
// `reservations` (see below) — deliberately NOT derived from
// chatbot_usage.billing_period, which predates this feature and can carry
// arbitrarily large historical/test/fixture totals for "the current
// month" that have nothing to do with real spend since the platform
// ceiling was deployed.
function periodStartForWindow(window: UsageWindow): Date {
  const now = new Date()
  if (window === "day") return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  if (window === "month") return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const isoDayOfWeek = (date.getUTCDay() + 6) % 7 // Monday = 0 ... Sunday = 6
  date.setUTCDate(date.getUTCDate() - isoDayOfWeek)
  return date
}

// Seeded from the durable `reservations` ledger (scope='platform',
// reconciled, created since this window began) rather than any
// pre-existing usage table — the platform ceiling only ever needs to know
// "how much have we spent since this protection existed", never spend
// that predates it (tokenallocation.md §2). This also means a fresh
// deployment or a newly-crossed window always starts the ceiling at $0,
// exactly as intended, with no backfill step required.
async function getPlatformPeriodCostUsd(window: UsageWindow): Promise<number> {
  const period = periodKeyForWindow(window)
  const key = platformUsageCacheKey(period)

  try {
    const cached = await withRedisTimeout(cacheRedis.get(key))
    if (cached !== null) return Number(cached) || 0
  } catch (err) {
    log().warn({ window, err: err instanceof Error ? err.message : String(err) }, "platform usage cache read failed")
  }

  if (!pool) return 0
  const { rows } = await pool.query<{ total: string | null }>(
    "select sum(actual_micro_usd) as total from reservations where scope = 'platform' and status = 'reconciled' and created_at >= $1",
    [periodStartForWindow(window)],
  )
  const cost = fromMicroUsd(BigInt(rows[0]?.total ?? "0"))
  try {
    await withRedisTimeout(cacheRedis.set(key, String(cost), "EX", USAGE_CACHE_TTL_SECONDS))
  } catch {

  }
  return cost
}

export interface PlatformBudgetStatus {
  window: UsageWindow
  period: string
  spentUsd: number
  capUsd: number
  percentUsed: number
}

// Powers the admin "Platform Budget" panel (admin.service.ts).
export async function getPlatformBudgetStatus(): Promise<PlatformBudgetStatus[]> {
  return Promise.all(
    USAGE_WINDOWS.map(async (window) => {
      const spentUsd = await getPlatformPeriodCostUsd(window)
      const capUsd = platformCapForWindow(window)
      return { window, period: periodKeyForWindow(window), spentUsd, capUsd, percentUsed: capUsd > 0 ? (spentUsd / capUsd) * 100 : 0 }
    }),
  )
}


// --- Durable reservation ledger (tokenallocation.md §1, §3, §17) --------
// Every reservation attempt writes a row here BEFORE touching Redis, so it
// can always be recovered/expired from Postgres even if Redis is flushed or
// the process crashes mid-request. request_id is the idempotency key: a
// second attempt with the same request_id is always DENIED (never admitted
// for free). The key comes from the server-generated request id
// (middleware/requestId.ts) — never from a client header (finding VER-01).

type ReservationScope = "tenant" | "platform"
type ReservationStatus = "held" | "reconciled" | "expired"

interface ReservationRow {
  id: string
  status: ReservationStatus
  reserved_micro_usd: string
  actual_micro_usd: string | null
}

async function insertOrGetReservation(params: {
  requestId: string
  chatbotId: string
  model: string
  scope: ReservationScope
  reservedUsd: number
}): Promise<{ row: ReservationRow | null; isNew: boolean } | null> {
  if (!pool) return null
  try {
    const expiresAt = new Date(Date.now() + env.reservationTtlSeconds * 1000)
    const inserted = await withPgTimeout(
      pool.query<ReservationRow>(
        `insert into reservations (request_id, chatbot_id, model, scope, reserved_micro_usd, status, expires_at)
         values ($1, $2, $3, $4, $5, 'held', $6)
         on conflict (request_id) do nothing
         returning id, status, reserved_micro_usd, actual_micro_usd`,
        [params.requestId, params.chatbotId, params.model, params.scope, toMicroUsd(params.reservedUsd), expiresAt],
      ),
    )
    if (inserted.rows[0]) return { row: inserted.rows[0], isNew: true }

    // The insert conflicted, so the key is already taken. Report it as a
    // duplicate even when the row belongs to another chatbot (row: null) —
    // never as "no guard", which would let the caller carry on unreserved.
    const existing = await withPgTimeout(
      pool.query<ReservationRow>(
        "select id, status, reserved_micro_usd, actual_micro_usd from reservations where request_id = $1 and chatbot_id = $2",
        [params.requestId, params.chatbotId],
      ),
    )
    return { row: existing.rows[0] ?? null, isNew: false }
  } catch (err) {
    log().warn(
      { requestId: params.requestId, err: err instanceof Error ? err.message : String(err) },
      "durable reservation write failed, continuing without the idempotency guard",
    )
    return null
  }
}

async function reconcileReservation(id: string, actualCostUsd: number): Promise<void> {
  if (!pool) return
  try {
    await withPgTimeout(
      pool.query(
        "update reservations set status = 'reconciled', actual_micro_usd = $2, reconciled_at = now() where id = $1 and status = 'held'",
        [id, toMicroUsd(actualCostUsd)],
      ),
    )
  } catch (err) {
    log().warn({ id, err: err instanceof Error ? err.message : String(err) }, "reservation reconcile write failed")
  }
}

async function expireReservationNow(id: string): Promise<void> {
  if (!pool) return
  try {
    await withPgTimeout(pool.query("update reservations set status = 'expired' where id = $1 and status = 'held'", [id]))
  } catch (err) {
    log().warn({ id, err: err instanceof Error ? err.message : String(err) }, "reservation expire write failed")
  }
}

// Orphan-recovery sweep (tokenallocation.md §17) — run periodically by
// worker.ts's "reservation-sweep-tick" job. A row stuck in 'held' past its
// TTL means the process that made it crashed (or otherwise never called
// commit) between reserving and reconciling; expiring it here is what
// keeps that capacity from being locked out of the cap forever. Nothing
// else needs to happen: the Redis counters it corresponds to naturally
// self-correct on the next cache-TTL rollover (USAGE_CACHE_TTL_SECONDS),
// and no real spend was ever attributed to an expired reservation, so
// there's nothing to reverse in chatbot_usage.
export async function sweepExpiredReservations(): Promise<number> {
  if (!pool) return 0
  try {
    const { rows } = await withPgTimeout(
      pool.query<{ id: string }>("update reservations set status = 'expired' where status = 'held' and expires_at < now() returning id"),
    )
    if (rows.length > 0) {
      log().info({ count: rows.length }, "reservation sweep expired orphaned holds")
    }
    return rows.length
  } catch (err) {
    log().warn({ err: err instanceof Error ? err.message : String(err) }, "reservation sweep failed")
    return 0
  }
}


// A model is only available if it's under cap in EVERY window — day AND
// week AND month, checked independently (see the Task 4 daily/weekly test
// in tests/unit/usageWindows.test.ts for why this matters: a chatbot deep
// under its monthly cap can still be correctly blocked by a single bad
// day, and the monthly check alone would never catch that).
// Customers are only ever blocked by monthly exhaustion (master prompt rule
// 5) — day/week are tracked (recordUsage still writes all three windows)
// and alerted on (checkAndSendUsageAlert) for internal anomaly detection,
// but no longer gate whether a model is selectable.
export async function isModelQuotaAvailable(chatbotId: string, entitlement: Entitlement, model: ModelKey): Promise<boolean> {
  const [spent, cap] = await Promise.all([
    getModelPeriodCostUsd(chatbotId, model, "month"),
    getEffectiveModelCapUsd(chatbotId, entitlement, model, "month"),
  ])
  return spent < cap
}


export interface ReservationCommitResult {
  isDuplicate: boolean
}

// Reserves capacity for one model-answer attempt across three boundaries
// (tokenallocation.md §1–§3):
//   step 0 — platform-wide ceiling (checked first; a small pre-revenue
//            business can't rely on per-tenant caps alone to stay under
//            total AI budget)
//   step 1 — account-wide allowance shared by every chatbot/provider
//   step 2 — this chatbot's per-model day/week/month defense-in-depth caps
// `requestId` must be unique per logical attempt (one HTTP request may make
// several attempts — see ai.ts's fallback loop — each gets its own model +
// requestId combination, so each is reserved and reconciled independently;
// this is also what fixed a real attribution bug where a fallback answer
// used to get billed against the *originally preferred* model's cap
// instead of the model that actually answered).
interface BudgetSlot {
  window: UsageWindow
  key: string
  capUsd: number
  loadSeed: () => Promise<string>
}

const RESERVE_ALL_BUDGETS_LUA = `
local budgetCount = #KEYS - 1
local markerKey = KEYS[#KEYS]
if redis.call("GET", markerKey) then
  return {0, 0}
end
for i = 1, budgetCount do
  local key = KEYS[i]
  if redis.call("EXISTS", key) == 0 then
    local seed = ARGV[2 + budgetCount + i]
    if seed == "__MISSING__" then
      return {-1, i}
    end
    redis.call("SET", key, seed, "EX", tonumber(ARGV[2]), "NX")
  end
end
for i = 1, budgetCount do
  local key = KEYS[i]
  local total = tonumber(redis.call("INCRBYFLOAT", key, ARGV[1]))
  if total > tonumber(ARGV[i + 2]) then
    for rollbackIndex = 1, i do
      redis.call("INCRBYFLOAT", KEYS[rollbackIndex], -tonumber(ARGV[1]))
    end
    return {0, i}
  end
end
redis.call("SET", markerKey, ARGV[1], "EX", tonumber(ARGV[2]))
return {1, 0}
`

const ADJUST_ALL_BUDGETS_LUA = `
for i = 1, #KEYS - 1 do
  redis.call("INCRBYFLOAT", KEYS[i], ARGV[1])
end
redis.call("DEL", KEYS[#KEYS])
return 1
`

const RELEASE_RESERVED_BUDGETS_LUA = `
local amount = redis.call("GET", KEYS[#KEYS])
if not amount then return 0 end
for i = 1, #KEYS - 1 do
  redis.call("INCRBYFLOAT", KEYS[i], -tonumber(amount))
end
redis.call("DEL", KEYS[#KEYS])
return 1
`

export async function reserveModelCostSlot(
  chatbotId: string,
  model: string,
  entitlement: Entitlement,
  requestId: string,
  estimatedReservationUsd = env.perCallCostReservationUsd,
): Promise<{ ok: boolean; commit: (actualCostUsd: number) => Promise<ReservationCommitResult> }> {
  const noopCommit = async (): Promise<ReservationCommitResult> => ({ isDuplicate: false })
  const reservationUsd = Math.max(env.minPerCallCostReservationUsd, estimatedReservationUsd)
  if (!Number.isFinite(reservationUsd) || reservationUsd > env.perCallCostReservationUsd) {
    log().warn(
      { chatbotId, model, estimatedReservationUsd: reservationUsd, maxPerCallUsd: env.perCallCostReservationUsd },
      "AI request rejected because its estimated cost exceeds the per-call safety limit",
    )
    return { ok: false, commit: noopCommit }
  }

  const tenantReservation = await insertOrGetReservation({
    requestId: `${requestId}:tenant:${model}`,
    chatbotId,
    model,
    scope: "tenant",
    reservedUsd: reservationUsd,
  })

  // Replay of a key that already has a reservation (in any state): deny.
  // A duplicate must never authorize a provider call — returning ok here
  // without a fresh reservation is what let VER-01 make unlimited unbilled
  // AI calls. Keys are server-generated, so a legitimate caller never
  // collides; a collision means a bug or an attack.
  if (tenantReservation && !tenantReservation.isNew) {
    log().warn(
      { chatbotId, model, status: tenantReservation.row?.status ?? "other-tenant" },
      "usage reservation denied: duplicate reservation key",
    )
    return { ok: false, commit: noopCommit }
  }

  const platformReservation = await insertOrGetReservation({
    requestId: `${requestId}:platform:${model}`,
    chatbotId,
    model,
    scope: "platform",
    reservedUsd: reservationUsd,
  })

  if (platformReservation && !platformReservation.isNew) {
    log().warn({ chatbotId, model }, "usage reservation denied: duplicate platform reservation key")
    if (tenantReservation?.row) await expireReservationNow(tenantReservation.row.id)
    return { ok: false, commit: noopCommit }
  }

  let reservedSlots: BudgetSlot[] = []
  const reservationMarkerKey = `budget-reservation:${requestId}:${model}`

  try {
    // Step 0 — platform-wide ceiling.
    const platformSlots = await Promise.all(
      USAGE_WINDOWS.map(async (window) => {
        const period = periodKeyForWindow(window)
        const key = platformUsageCacheKey(period)
        const capUsd = platformCapForWindow(window)

        const loadSeed = async () => pool
          ? await withPgTimeout(pool.query<{ total: string | null }>(
                  "select sum(actual_micro_usd) as total from reservations where scope = 'platform' and status = 'reconciled' and created_at >= $1",
                  [periodStartForWindow(window)],
                )).then((r) => String(fromMicroUsd(BigInt(r.rows[0]?.total ?? "0"))))
          : "0"

        return { window, key, capUsd, loadSeed }
      }),
    )

    // Step 1 — account-wide cap shared by every chatbot and every model.
    // Without this, a $20 Crawl Plus account could independently spend its
    // $5 allowance across 5 chatbots and 3 providers ($75 total).
    const ownerId = await getChatbotOwnerId(chatbotId)
    const accountSlots = ownerId
      ? await Promise.all(
          USAGE_WINDOWS.map(async (window) => {
            const period = periodKeyForWindow(window)
            const key = accountUsageCacheKey(ownerId, period)
            const capUsd = await accountCapForWindow(ownerId, entitlement, window)
            const loadSeed = async () => pool
              ? await withPgTimeout(pool.query<{ total: string | null }>(
                      `select sum(u.estimated_cost) as total
                       from chatbot_usage u
                       join chatbots c on c.id = u.chatbot_id
                       where c.user_id = $1 and u.billing_period = $2`,
                      [ownerId, period],
                    )).then((r) => r.rows[0]?.total ?? "0")
              : "0"
            return { window, key, capUsd, loadSeed }
          }),
        )
      : []

    // Step 2 — this chatbot's own per-model cap. Month only (master prompt
    // rule 5: customers are never blocked by day/week pace, only monthly
    // exhaustion) — day/week are still recorded (recordUsage) and alerted
    // on (checkAndSendUsageAlert) for internal anomaly detection, they just
    // don't reserve/deny capacity here anymore. The platform-wide ceiling
    // (step 0) and account-wide cap (step 1) above are a different, unrelated
    // safety net against runaway spend across the whole platform/account and
    // deliberately keep their day/week enforcement.
    const tenantSlots = await Promise.all(
      (["month"] as const).map(async (window) => {
        const period = periodKeyForWindow(window)
        const key = modelUsageCacheKey(chatbotId, period, model)
        const capUsd = await getEffectiveModelCapUsd(chatbotId, entitlement, model, window)

        const loadSeed = async () => pool
          ? await withPgTimeout(pool.query<{ estimated_cost: string }>(
                  "select estimated_cost from chatbot_usage where chatbot_id = $1 and billing_period = $2 and model = $3",
                  [chatbotId, period, model],
                )).then((r) => r.rows[0]?.estimated_cost ?? "0")
          : "0"

        return { window, key, capUsd, loadSeed }
      }),
    )

    const slots: BudgetSlot[] = [...platformSlots, ...accountSlots, ...tenantSlots]
    reservedSlots = slots
    const seeds = slots.map(() => "__MISSING__")
    let reservationResult: [number, number]

    for (;;) {
      reservationResult = await withRedisTimeout(
        cacheRedis.eval(
          RESERVE_ALL_BUDGETS_LUA,
          slots.length + 1,
          ...slots.map((slot) => slot.key),
          reservationMarkerKey,
          String(reservationUsd),
          String(USAGE_CACHE_TTL_SECONDS),
          ...slots.map((slot) => String(slot.capUsd)),
          ...seeds,
        ),
      ) as [number, number]

      if (Number(reservationResult[0]) !== -1) break
      const missingIndex = Number(reservationResult[1]) - 1
      const missingSlot = slots[missingIndex]
      if (!missingSlot) throw new Error("Redis reported an unknown missing budget slot")
      seeds[missingIndex] = await missingSlot.loadSeed()
    }

    if (Number(reservationResult[0]) !== 1) {
      const exceeded = slots[Number(reservationResult[1]) - 1]
      log().info(
        { chatbotId, ownerId, model, scopeKey: exceeded?.key, window: exceeded?.window },
        "usage reservation rejected because a budget cap would be exceeded",
      )
      if (exceeded?.key.startsWith(PLATFORM_USAGE_CACHE_KEY_PREFIX)) {
        void incrementUsageMetric("usage.platform_limit", { chatbotId, window: exceeded.window })
      }
      if (tenantReservation?.row) await expireReservationNow(tenantReservation.row.id)
      if (platformReservation?.row) await expireReservationNow(platformReservation.row.id)
      return { ok: false, commit: noopCommit }
    }

    return {
      ok: true,
      commit: async (actualCostUsd: number): Promise<ReservationCommitResult> => {
        const delta = actualCostUsd - reservationUsd
        await withRedisTimeout(
          cacheRedis.eval(
            ADJUST_ALL_BUDGETS_LUA,
            slots.length + 1,
            ...slots.map((slot) => slot.key),
            reservationMarkerKey,
            String(delta),
          ),
        ).catch((err) => {
          log().error(
            { chatbotId, model, err: err instanceof Error ? err.message : String(err) },
            "failed to reconcile Redis budget counters",
          )
        })
        if (tenantReservation?.row) await reconcileReservation(tenantReservation.row.id, actualCostUsd)
        if (platformReservation?.row) await reconcileReservation(platformReservation.row.id, actualCostUsd)
        return { isDuplicate: false }
      },
    }
  } catch (err) {
    if (reservedSlots.length > 0) {
      // This command uses the same Redis connection as the timed-out acquire.
      // Redis preserves command order, so a late acquire is followed by a
      // token-specific release instead of leaking an untracked hold.
      void cacheRedis.eval(
        RELEASE_RESERVED_BUDGETS_LUA,
        reservedSlots.length + 1,
        ...reservedSlots.map((slot) => slot.key),
        reservationMarkerKey,
      ).catch(() => {})
    }
    if (tenantReservation?.row) await expireReservationNow(tenantReservation.row.id)
    if (platformReservation?.row) await expireReservationNow(platformReservation.row.id)
    log().error({ chatbotId, model, err: err instanceof Error ? err.message : String(err) }, "usage reservation failed closed")
    console.error(`[usage.service] reserveModelCostSlot: FAILED chatbotId=${chatbotId} model=${model}`, err)
    return { ok: false, commit: noopCommit }
  }
}


export type CostCapBlockKind = "monthly"

export interface CostCapBlock {
  kind: CostCapBlockKind
}

export function usageWindowPresentation(window: UsageWindow): {
  kind: "credits" | "burst"
  label: string
  customerFacingCredits: boolean
} {
  if (window === "month") {
    return { kind: "credits", label: "Monthly AI credits", customerFacingCredits: true }
  }
  if (window === "day") {
    return { kind: "burst", label: "Today's request pace", customerFacingCredits: false }
  }
  return { kind: "burst", label: "This week's request pace", customerFacingCredits: false }
}

/**
 * Why answering is blocked, if it is. Monthly exhaustion is the only
 * customer-facing block (master prompt rule 5) — day/week overage is
 * tracked and alerted on internally (recordUsage / checkAndSendUsageAlert)
 * but never stops a chatbot from answering.
 */
export async function getCostCapBlock(chatbotId: string): Promise<CostCapBlock | null> {
  try {
    const entitlement = await getEntitlementForChatbot(chatbotId)
    if (entitlement.allowedModels.length === 0) return { kind: "monthly" }

    for (const model of entitlement.allowedModels) {
      const [spent, cap] = await Promise.all([
        getModelPeriodCostUsd(chatbotId, model, "month"),
        getEffectiveModelCapUsd(chatbotId, entitlement, model, "month"),
      ])
      if (spent < cap) return null
    }

    return { kind: "monthly" }
  } catch (err) {
    log().warn({ chatbotId, err: err instanceof Error ? err.message : String(err) }, "cost cap check failed, allowing request")
    return null
  }
}

export async function isOverCostCap(chatbotId: string): Promise<boolean> {
  return (await getCostCapBlock(chatbotId)) !== null
}


// 80/90% pre-emptive usage alerting (tokenallocation.md §8 / spec §11).
// 100% is deliberately NOT handled here — accessGate.service.ts already
// sends a "usage limit reached" notification, deduped to once/UTC day,
// whenever a request is actually blocked by an exhausted cap; duplicating
// that here would just double-notify at the moment that matters most.
// Per spec §11, only the monthly threshold emails/in-app-notifies —
// day/week crossings are dashboard-only (computed live from chatbot_usage,
// not stored) plus this same dedup ledger for internal telemetry.
const ALERT_THRESHOLDS = [90, 80] as const

async function checkAndSendUsageAlert(chatbotId: string, model: string, window: UsageWindow, spentUsd: number, capUsd: number): Promise<void> {
  if (!pool || capUsd <= 0) return
  const percentUsed = (spentUsd / capUsd) * 100
  const crossed = ALERT_THRESHOLDS.find((threshold) => percentUsed >= threshold)
  if (crossed === undefined) return

  try {
    const period = periodKeyForWindow(window)
    const inserted = await pool.query(
      `insert into usage_alerts_sent (chatbot_id, model, billing_period, usage_window, threshold)
       values ($1, $2, $3, $4, $5)
       on conflict do nothing
       returning threshold`,
      [chatbotId, model, period, window, crossed],
    )
    if (inserted.rows.length === 0) return // already alerted this threshold this period

    const { rows: owner } = await pool.query<{ user_id: string; email: string }>(
      "select u.id as user_id, u.email from chatbots c join users u on u.id = c.user_id where c.id = $1",
      [chatbotId],
    )
    if (!owner[0]) return

    await createNotification({
      userId: owner[0].user_id,
      type: "usage_limit",
      title: `${crossed}% of ${window}ly AI usage allowance used`,
      body: `${model} has used ${crossed}% of its ${window}ly allowance for this chatbot. Check Usage in your dashboard to avoid an interruption.`,
      emailTo: window === "month" ? owner[0].email : undefined,
      metadata: { chatbotId, model, window, threshold: crossed, spentUsd, capUsd },
    })
  } catch (err) {
    log().warn({ chatbotId, model, window, err: err instanceof Error ? err.message : String(err) }, "usage threshold alert failed")
  }
}


// Writes the SAME per-model totals into all three windows' rows (day, week,
// month), reusing this one upsert query rather than running a separate
// tracking system per window — chatbot_usage.billing_period is just a text
// key, so a day-string and a week-string live in it exactly like the
// existing month-string always has, no schema change needed.
export async function recordUsage(chatbotId: string, usages: AiUsage[], entitlement?: Entitlement): Promise<void> {
  if (usages.length === 0 || !pool) return

  const byModel = new Map<string, { inputTokens: number; outputTokens: number; cost: number }>()
  for (const usage of usages) {
    const entry = byModel.get(usage.provider) ?? { inputTokens: 0, outputTokens: 0, cost: 0 }
    entry.inputTokens += usage.inputTokens
    entry.outputTokens += usage.outputTokens
    entry.cost += estimateCostUsd(usage.model, usage.inputTokens, usage.outputTokens)
    byModel.set(usage.provider, entry)
  }

  console.log(`[usage.service] recordUsage: chatbotId=${chatbotId} models=${[...byModel.keys()].join(",")}`)

  for (const window of USAGE_WINDOWS) {
    const period = periodKeyForWindow(window)
    for (const [model, { inputTokens, outputTokens, cost }] of byModel) {
      try {
        const { rows } = await pool.query<{ estimated_cost: string }>(
          `insert into chatbot_usage (chatbot_id, billing_period, model, input_tokens, output_tokens, estimated_cost)
           values ($1, $2, $3, $4, $5, $6)
           on conflict (chatbot_id, billing_period, model) do update set
             input_tokens = chatbot_usage.input_tokens + excluded.input_tokens,
             output_tokens = chatbot_usage.output_tokens + excluded.output_tokens,
             estimated_cost = chatbot_usage.estimated_cost + excluded.estimated_cost,
             updated_at = now()
           returning estimated_cost`,
          [chatbotId, period, model, inputTokens, outputTokens, cost],
        )

        await withRedisTimeout(
          cacheRedis.set(modelUsageCacheKey(chatbotId, period, model), rows[0].estimated_cost, "EX", USAGE_CACHE_TTL_SECONDS),
        ).catch(() => {})
        console.log(`[usage.service] recordUsage: window=${window} period=${period} chatbotId=${chatbotId} model=${model} newTotalCost=${rows[0].estimated_cost}`)

        const effectiveEntitlement = entitlement ?? (await getEntitlementForChatbot(chatbotId))
        const capUsd = await getEffectiveModelCapUsd(chatbotId, effectiveEntitlement, model, window)
        void checkAndSendUsageAlert(chatbotId, model, window, Number(rows[0].estimated_cost), capUsd)
      } catch (err) {
        log().warn(
          { chatbotId, model, window, err: err instanceof Error ? err.message : String(err) },
          "failed to record ai usage, metering for this call is lost",
        )
        console.error(`[usage.service] recordUsage: FAILED window=${window} chatbotId=${chatbotId} model=${model}`, err)
      }
    }
  }
}

export interface UsageSummary {
  billingPeriod: string
  totalInputTokens: number
  totalOutputTokens: number
  totalCostUsd: number
  conversationCount: number
  byModel: { model: string; inputTokens: number; outputTokens: number; costUsd: number }[]
}

// Kept exactly as before (period defaults to the current month) — this is
// what the existing dashboard usage panel already calls; unchanged shape,
// so nothing that already consumes it breaks.
export async function getUsageSummaryForOwner(accessToken: string, chatbotId: string, period?: string): Promise<UsageSummary> {
  const actorUserId = verifyAccessToken(accessToken)
  if (!actorUserId) throw new AppError(401, "Please sign in again.")
  const { tenantUserId } = await resolveTenantContext(actorUserId, "viewer")
  const ownedId = await requireOwnedChatbotId(tenantUserId, chatbotId)
  const billingPeriod = period || currentBillingPeriod()

  const [usageRows, conversationCount] = await Promise.all([
    pool
      ? pool
          .query<{ model: string; input_tokens: string; output_tokens: string; estimated_cost: string }>(
            "select model, input_tokens, output_tokens, estimated_cost from chatbot_usage where chatbot_id = $1 and billing_period = $2",
            [ownedId, billingPeriod],
          )
          .then((r) => r.rows)
      : Promise.resolve([]),
    getConversationCountForPeriod(ownedId, billingPeriod),
  ])

  const byModel = usageRows.map((row) => ({
    model: row.model,
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    costUsd: Number(row.estimated_cost),
  }))

  return {
    billingPeriod,
    totalInputTokens: byModel.reduce((sum, m) => sum + m.inputTokens, 0),
    totalOutputTokens: byModel.reduce((sum, m) => sum + m.outputTokens, 0),
    totalCostUsd: byModel.reduce((sum, m) => sum + m.costUsd, 0),
    conversationCount,
    byModel,
  }
}

export interface UsageWindowSummary {
  window: UsageWindow
  period: string
  kind: "credits" | "burst"
  label: string
  customerFacingCredits: boolean
  totalInputTokens: number
  totalOutputTokens: number
  totalCostUsd: number
  conversationCount: number
  byModel: { model: string; inputTokens: number; outputTokens: number; costUsd: number; capUsd: number }[]
}

async function usageSummaryForWindow(ownedId: string, entitlement: Entitlement, window: UsageWindow): Promise<UsageWindowSummary> {
  const period = periodKeyForWindow(window)

  const [usageRows, conversationCount] = await Promise.all([
    pool
      ? pool
          .query<{ model: string; input_tokens: string; output_tokens: string; estimated_cost: string }>(
            "select model, input_tokens, output_tokens, estimated_cost from chatbot_usage where chatbot_id = $1 and billing_period = $2",
            [ownedId, period],
          )
          .then((r) => r.rows)
      : Promise.resolve([]),
    getConversationCountForPeriod(ownedId, period, window),
  ])

  const rowByModel = new Map(usageRows.map((row) => [row.model, row]))
  // Every allowed model shows up even with zero usage, each with its own
  // cap for this window — lets the dashboard show "$0.00 of $0.50 used"
  // for a model the owner hasn't hit yet, not just silently omit it.
  const byModel = await Promise.all(
    entitlement.allowedModels.map(async (model) => {
      const row = rowByModel.get(model)
      const capUsd = await getEffectiveModelCapUsd(ownedId, entitlement, model, window)
      return {
        model,
        inputTokens: row ? Number(row.input_tokens) : 0,
        outputTokens: row ? Number(row.output_tokens) : 0,
        costUsd: row ? Number(row.estimated_cost) : 0,
        capUsd,
      }
    }),
  )

  return {
    window,
    period,
    ...usageWindowPresentation(window),
    totalInputTokens: byModel.reduce((sum, m) => sum + m.inputTokens, 0),
    totalOutputTokens: byModel.reduce((sum, m) => sum + m.outputTokens, 0),
    totalCostUsd: byModel.reduce((sum, m) => sum + m.costUsd, 0),
    conversationCount,
    byModel,
  }
}

export interface UsageWindowSummaries {
  day: UsageWindowSummary
  week: UsageWindowSummary
  month: UsageWindowSummary
}

// The Crawl Plus dashboard's real ask: daily AND weekly AND monthly usage
// against each window's own limit, each window refreshing automatically
// (a new day/week/month just means a new billing_period key — see
// currentDayPeriod/currentWeekPeriod above — nothing to reset).
export async function getUsageWindowSummariesForOwner(accessToken: string, chatbotId: string): Promise<UsageWindowSummaries> {
  const actorUserId = verifyAccessToken(accessToken)
  if (!actorUserId) throw new AppError(401, "Please sign in again.")
  const { tenantUserId } = await resolveTenantContext(actorUserId, "viewer")
  const ownedId = await requireOwnedChatbotId(tenantUserId, chatbotId)
  const entitlement = await getEntitlementForChatbot(ownedId)

  const [day, week, month] = await Promise.all(USAGE_WINDOWS.map((window) => usageSummaryForWindow(ownedId, entitlement, window)))
  return { day, week, month }
}
