import express from "express"
import request from "supertest"
import { describe, expect, it, vi } from "vitest"

import { normalisedEmailKey } from "../../src/middleware/rateLimitAuthFlows.js"
import {
  BoundedMemoryLimiter,
  INSURANCE_KEY_BUCKETS,
  consumeInsured,
  createInsuredLimiter,
} from "../../src/middleware/rateLimitShared.js"
import { resolveTrustProxy } from "../../src/app.js"

// CS-09: insured limiters (rateLimitShared.ts) against a storeClient that
// fails exactly like an unreachable Redis — no live connection involved.
function brokenRedisClient() {
  return { rlflxIncr: () => Promise.reject(new Error("Redis down (simulated)")) }
}

describe("consumeInsured", () => {
  it("falls back to the in-memory cap when Redis errors, then rejects with a quota-shaped result", async () => {
    const limiter = createInsuredLimiter({ keyPrefix: "cs09-unit-a", points: 2, durationSeconds: 60, storeClient: brokenRedisClient() })
    expect(await consumeInsured(limiter, "k")).toBeNull()
    expect(await consumeInsured(limiter, "k")).toBeNull()
    expect(await consumeInsured(limiter, "k")).toMatchObject({ msBeforeNext: expect.any(Number) })
  })

  it("uses the in-memory limiter when an infra error escapes consume() itself", async () => {
    const limiter = createInsuredLimiter({ keyPrefix: "cs09-unit-b", points: 1, durationSeconds: 60, storeClient: brokenRedisClient() })
    vi.spyOn(limiter.redis, "consume").mockRejectedValue(new Error("boom"))
    expect(await consumeInsured(limiter, "k")).toBeNull()
    expect(await consumeInsured(limiter, "k")).toMatchObject({ msBeforeNext: expect.any(Number) })
  })

  it("fails closed when Redis and the in-memory fallback both error", async () => {
    const limiter = createInsuredLimiter({ keyPrefix: "cs09-unit-c", points: 5, durationSeconds: 60, storeClient: brokenRedisClient() })
    vi.spyOn(limiter.redis, "consume").mockRejectedValue(new Error("boom"))
    vi.spyOn(limiter.insurance, "consume").mockRejectedValue(new Error("boom too"))
    expect(await consumeInsured(limiter, "k")).toMatchObject({ msBeforeNext: 60_000 })
  })
})

describe("BoundedMemoryLimiter", () => {
  it("hashes keys into a bounded bucket space so rotating keys cannot grow memory without bound", async () => {
    const limiter = new BoundedMemoryLimiter({ points: 1_000_000, duration: 60 })
    for (let i = 0; i < 5000; i++) await limiter.consume(`rotating-${i}@example.test`)
    const storage = (limiter as unknown as { _memoryStorage: { _storage: Record<string, unknown> } })._memoryStorage._storage
    const keys = Object.keys(storage)
    expect(keys.length).toBeLessThanOrEqual(INSURANCE_KEY_BUCKETS)
    expect(keys.every((k) => Number(k.split(":").pop()) < INSURANCE_KEY_BUCKETS)).toBe(true)
    expect(keys.some((k) => k.includes("rotating-"))).toBe(false)
  })
})

describe("normalisedEmailKey", () => {
  it("treats case and surrounding whitespace as the same account and never stores the plaintext", () => {
    const key = normalisedEmailKey("Victim@Example.com")
    expect(key).toBe(normalisedEmailKey("  victim@example.COM "))
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(normalisedEmailKey(undefined)).toBeNull()
    expect(normalisedEmailKey(42)).toBeNull()
  })
})

describe("resolveTrustProxy", () => {
  function ipEcho(hops: number) {
    const app = express()
    app.set("trust proxy", resolveTrustProxy(hops))
    app.get("/", (req, res) => {
      res.json({ ip: req.ip })
    })
    return app
  }

  it("0 ignores X-Forwarded-For entirely", async () => {
    const res = await request(ipEcho(0)).get("/").set("X-Forwarded-For", "6.6.6.6")
    expect(res.body.ip).not.toBe("6.6.6.6")
    expect(res.body.ip).toMatch(/127\.0\.0\.1|::1/)
  })

  it("1 uses the address the single proxy appended, not a client-spoofed left entry", async () => {
    const res = await request(ipEcho(1)).get("/").set("X-Forwarded-For", "6.6.6.6, 203.0.113.7")
    expect(res.body.ip).toBe("203.0.113.7")
  })

  it.each([Number.NaN, -1, 1.5])("rejects invalid hop count %s", (value) => {
    expect(() => resolveTrustProxy(value)).toThrow(/TRUST_PROXY_HOPS/)
  })
})
