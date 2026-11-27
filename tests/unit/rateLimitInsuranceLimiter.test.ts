import { RateLimiterMemory, RateLimiterRedis } from "rate-limiter-flexible"
import { describe, expect, it } from "vitest"

// rateLimitAdminLogin.ts and rateLimitPublicAttachment.ts configure
// RateLimiterRedis's own `insuranceLimiter` option so a real Redis outage
// degrades to a per-process in-memory cap instead of no cap at all.
// rateLimitFailOpen.test.ts proves the middleware funnels a non-quota
// rejection to next() when consume() fails outright (mocking .consume()
// itself); that mock bypasses rate-limiter-flexible's own internals, so it
// can't prove the insuranceLimiter wiring actually engages. This test
// exercises the REAL RateLimiterRedis implementation with a storeClient
// stub that fails exactly the way an unreachable Redis does (every command
// rejects) — no live/dead network connection needed, just the same
// `rlflxIncr` call `_upsert()` makes internally.
function brokenRedisClient() {
  return {
    rlflxIncr: () => Promise.reject(new Error("Redis down (simulated)")),
  }
}

describe("RateLimiterRedis + insuranceLimiter: the real fallback a Redis outage engages", () => {
  it("admits requests up to the in-memory fallback's own points budget when Redis is unreachable", async () => {
    const limiter = new RateLimiterRedis({
      storeClient: brokenRedisClient(),
      keyPrefix: "test-insurance-admit",
      points: 3,
      duration: 60,
      insuranceLimiter: new RateLimiterMemory({ points: 3, duration: 60 }),
    })

    await expect(limiter.consume("1.2.3.4")).resolves.toBeDefined()
    await expect(limiter.consume("1.2.3.4")).resolves.toBeDefined()
    await expect(limiter.consume("1.2.3.4")).resolves.toBeDefined()
  })

  it("rejects with a real quota-shaped rejection (msBeforeNext) once the in-memory fallback's budget is exhausted", async () => {
    const limiter = new RateLimiterRedis({
      storeClient: brokenRedisClient(),
      keyPrefix: "test-insurance-exhaust",
      points: 2,
      duration: 60,
      insuranceLimiter: new RateLimiterMemory({ points: 2, duration: 60 }),
    })

    await limiter.consume("5.6.7.8")
    await limiter.consume("5.6.7.8")

    await expect(limiter.consume("5.6.7.8")).rejects.toMatchObject({ msBeforeNext: expect.any(Number) })
  })

  it("without an insuranceLimiter, the same broken Redis rejects with a plain error (no msBeforeNext)", async () => {
    const limiter = new RateLimiterRedis({
      storeClient: brokenRedisClient(),
      keyPrefix: "test-no-insurance",
      points: 3,
      duration: 60,
    })

    await expect(limiter.consume("9.9.9.9")).rejects.not.toMatchObject({ msBeforeNext: expect.any(Number) })
  })
})
