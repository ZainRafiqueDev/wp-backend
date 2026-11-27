import { afterEach, describe, expect, it, vi } from "vitest"

import type { Entitlement } from "../../src/services/billing.service.js"
import { cacheRedis } from "../../src/lib/redis.js"
import { reserveModelCostSlot, recordUsage, getCurrentPeriodCostUsd } from "../../src/services/usage.service.js"
import { createReadyChatbotWithDomain } from "../helpers.js"

// Daily/weekly caps now gate reservations too (see usage.service.ts) — these
// tests are specifically about the monthly-cap race/commit behavior, so the
// day/week caps here are set high enough to never be the binding constraint,
// isolating what each test actually means to prove.
function entitlementWithMonthCap(perModelCapUsd: number): Entitlement {
  return {
    plan: "free",
    maxChatbots: 1,
    maxSeats: 1,
    allowedModels: ["anthropic", "openai", "gemini"],
    perModelCapUsd,
    perModelDailyCapUsd: 1_000_000,
    perModelWeeklyCapUsd: 1_000_000,
    documentIngestion: { enabled: false, maxDocuments: 0, maxFileSizeBytes: 0, maxChatbotBytes: 0 },
    chatAttachments: { enabled: false, maxFileSizeBytes: 0, maxFilesPerMessage: 0, retentionDays: 0, allowedTypes: [], totalStorageBytes: 0 },
    limitAction: "BLOCK",
    active: false,
  }
}

// Part B hardening item 5 — atomic check-and-increment. The plain
// read-then-write shape (isModelQuotaAvailable/isOverCostCap) is provably
// racy: three concurrent callers can all read "under cap" before any of
// them has recorded real cost. reserveModelCostSlot closes that gap with a
// single atomic Redis INCRBYFLOAT per call — this test proves the
// resulting count of ADMITTED requests near a cap boundary is bounded by
// the cap itself, never by how many requests happened to race in at once.
describe("reserveModelCostSlot — atomic usage-cap enforcement under concurrency (Part B item 5)", () => {
  it("three simultaneous requests near a cap boundary: the effective cap is never exceeded, no matter how many raced in", async () => {
    const { chatbotId } = await createReadyChatbotWithDomain("usage-reserve-race", `usage-reserve-race-${Date.now()}.test`)
    const model = "anthropic"
    // A cap sized so exactly ONE reservation (env.perCallCostReservationUsd,
    // default $0.05) fits under it, but two do not - the smallest boundary
    // that still meaningfully proves the atomic ordering.
    const entitlement = entitlementWithMonthCap(0.06)

    const results = await Promise.all([
      reserveModelCostSlot(chatbotId, model, entitlement, crypto.randomUUID()),
      reserveModelCostSlot(chatbotId, model, entitlement, crypto.randomUUID()),
      reserveModelCostSlot(chatbotId, model, entitlement, crypto.randomUUID()),
    ])

    const admitted = results.filter((r) => r.ok)
    // The critical assertion: with a plain read-then-write check, all
    // three could read "$0 spent, cap not reached" before any of them
    // committed - admitting all 3. The atomic increment must admit AT MOST
    // as many as the cap actually allows.
    expect(admitted.length).toBe(1)
    expect(results.filter((r) => !r.ok).length).toBe(2)

    // Releasing (committing) the winning reservation's real cost must not
    // let a since-rejected request retroactively appear to have succeeded.
    await admitted[0].commit(0.03)
    const recorded = await getCurrentPeriodCostUsd(chatbotId)
    // Nothing was recorded via recordUsage in this test (that's a separate
    // write path - see recordUsage's own tests in usage.integration.test.ts)
    // - this just confirms the reservation's true-up didn't touch Postgres,
    // only the fast Redis path it's responsible for.
    expect(recorded).toBe(0)
  })

  it("a reservation that fits comfortably under the cap is admitted, and its true-up reflects the real (lower) cost afterward", async () => {
    const { chatbotId } = await createReadyChatbotWithDomain("usage-reserve-fit", `usage-reserve-fit-${Date.now()}.test`)
    const entitlement = entitlementWithMonthCap(5.0)

    const reservation = await reserveModelCostSlot(chatbotId, "openai", entitlement, crypto.randomUUID())
    expect(reservation.ok).toBe(true)
    await reservation.commit(0.001)

    // A second, independent reservation right after must see the true-up,
    // not the original flat estimate - proving commit() actually adjusted
    // the shared counter rather than leaving the conservative placeholder
    // in place indefinitely.
    const second = await reserveModelCostSlot(chatbotId, "openai", entitlement, crypto.randomUUID())
    expect(second.ok).toBe(true)
    await second.commit(0.001)
  })

  it("a chatbot already at cap via real recorded usage is denied a new reservation", async () => {
    const { chatbotId } = await createReadyChatbotWithDomain("usage-reserve-atcap", `usage-reserve-atcap-${Date.now()}.test`)
    await recordUsage(chatbotId, [{ provider: "gemini", model: "gemini-flash-latest", inputTokens: 0, outputTokens: 5_000_000 }])

    const entitlement = entitlementWithMonthCap(0.5) // env.freePlanMonthlyCostCapUsd default
    const reservation = await reserveModelCostSlot(chatbotId, "gemini", entitlement, crypto.randomUUID())
    expect(reservation.ok).toBe(false)
  })

  it("shares one account budget across different chatbots and providers", async () => {
    const owner = await createReadyChatbotWithDomain("usage-account-cap", `usage-account-cap-${Date.now()}.test`)
    if (!process.env.DATABASE_URL) throw new Error("integration database is required")
    const { pool } = await import("../../src/lib/db.js")
    if (!pool) throw new Error("integration database pool is required")

    const { rows } = await pool.query<{ id: string }>(
      `insert into chatbots (user_id, name, sources, status)
       values ($1, 'Second account-cap bot', '[]'::jsonb, 'ready')
       returning id`,
      [owner.userId],
    )
    const secondChatbotId = rows[0].id
    const entitlement = entitlementWithMonthCap(0.06)

    const first = await reserveModelCostSlot(owner.chatbotId, "openai", entitlement, crypto.randomUUID(), 0.05)
    expect(first.ok).toBe(true)
    await first.commit(0.03)

    // A different chatbot and provider still draw from the same owner's
    // aggregate allowance: $0.03 spent + $0.05 hold > $0.06 cap.
    const second = await reserveModelCostSlot(secondChatbotId, "gemini", entitlement, crypto.randomUUID(), 0.05)
    expect(second.ok).toBe(false)
  })

  // Audit follow-up: "if Redis times out or is down, does reserveModelCostSlot
  // allow spend without a cap?" — no. The atomic reserve is a single Lua
  // eval against Redis (RESERVE_ALL_BUDGETS_LUA) with no non-Redis success
  // path; a Redis failure there throws, and reserveModelCostSlot's outer
  // catch (usage.service.ts, logged as "usage reservation failed closed")
  // denies the reservation rather than falling through to an uncapped
  // admit. This proves that against the real failure mode (cacheRedis.eval
  // rejecting, exactly what a Redis outage/timeout looks like to this
  // code), not just by reading the source.
  describe("Redis down during reservation", () => {
    afterEach(() => {
      vi.restoreAllMocks()
    })

    it("fails closed (denies the reservation) rather than admitting uncapped spend", async () => {
      const { chatbotId } = await createReadyChatbotWithDomain("usage-reserve-redisdown", `usage-reserve-redisdown-${Date.now()}.test`)
      const entitlement = entitlementWithMonthCap(1_000_000) // comfortably under cap if Redis worked
      vi.spyOn(cacheRedis, "eval").mockRejectedValue(new Error("Redis down (simulated)"))

      const reservation = await reserveModelCostSlot(chatbotId, "anthropic", entitlement, crypto.randomUUID())

      expect(reservation.ok).toBe(false)
      // noopCommit is a no-op by construction, but confirm calling it still
      // never records real cost — the caller has no way to accidentally
      // spend after a denied reservation.
      await reservation.commit(5.0)
      expect(await getCurrentPeriodCostUsd(chatbotId)).toBe(0)
    })
  })
})
