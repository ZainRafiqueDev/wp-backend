import { describe, expect, it, vi } from "vitest"

const incr = vi.fn(async () => 1)
const expire = vi.fn(async () => 1)

vi.mock("../../src/lib/redis.js", () => ({
  cacheRedis: { incr, expire },
}))

const { incrementBillingMetric } = await import("../../src/lib/billingMetrics.js")

describe("WP-1.8 billing checkout metrics", () => {
  it("increments checkout_started and checkout_activated without throwing", async () => {
    incr.mockClear()
    expire.mockClear()
    await incrementBillingMetric("billing.checkout_started", { userId: "u1", plan: "crawl_plus" })
    await incrementBillingMetric("billing.checkout_activated", { userId: "u1", plan: "crawl_plus" })
    expect(incr).toHaveBeenCalledTimes(2)
    const startedKey = String(incr.mock.calls.at(0)?.at(0) ?? "")
    const activatedKey = String(incr.mock.calls.at(1)?.at(0) ?? "")
    expect(startedKey).toMatch(/^metric:billing\.checkout_started:\d{4}-\d{2}-\d{2}$/)
    expect(activatedKey).toMatch(/^metric:billing\.checkout_activated:\d{4}-\d{2}-\d{2}$/)
    expect(expire).toHaveBeenCalledTimes(2)
  })

  it("swallows Redis failures so checkout is not taken down", async () => {
    incr.mockRejectedValueOnce(new Error("redis down"))
    await expect(incrementBillingMetric("billing.checkout_started", { userId: "u2" })).resolves.toBeUndefined()
  })
})
