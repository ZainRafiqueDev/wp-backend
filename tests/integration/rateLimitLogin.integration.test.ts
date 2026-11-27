import { randomInt } from "node:crypto"

import request from "supertest"
import { describe, expect, it, vi } from "vitest"

// /auth/login had no rate limit at all until this fix — real
// credential-stuffing exposure. vitest.config.ts sets a high global
// LOGIN_RATE_LIMIT_PER_MIN so the rest of the suite (which signs users in
// far more than 10 times per run) never trips it; this file stubs its own
// low value before importing the app, matching the ADMIN_LOGIN_RATE_LIMIT_PER_MIN
// precedent's local-override style used elsewhere for the same reason.
vi.stubEnv("LOGIN_RATE_LIMIT_PER_MIN", "5")
// CS-17: the limiter is IP-keyed and every test file hits from the same
// loopback address, so parallel files' logins (and earlier runs) shared this
// bucket and made the counts below flaky. Trusting exactly one proxy hop lets
// this file send its own random X-Forwarded-For IP — a bucket nothing else
// touches — instead of deleting shared login:* keys in Redis.
vi.stubEnv("TRUST_PROXY_HOPS", "1")

const { app, signupUser } = await import("../helpers.js")

const TEST_IP = `10.${randomInt(0, 256)}.${randomInt(0, 256)}.${randomInt(1, 255)}`

describe("POST /auth/login — rate limiting (5/min in this test)", () => {
  // The limiter is IP-keyed (there's no authenticated user yet to key on —
  // by design, so an attacker rotating target emails from one IP is still
  // caught). A fresh signup therefore does NOT give a fresh bucket; the
  // random TEST_IP above does.
  // Single IP-keyed quota window covers the whole test: the first few
  // attempts use a wrong password (proving the limiter engages in front of
  // credential checking, not only after a successful login — a limiter that
  // only counted successes would let an attacker guess passwords
  // indefinitely), then a correct login still counts against the same
  // quota, then the limit kicks in regardless of credential correctness.
  it("counts both failed and successful attempts against one per-IP quota, then rejects further attempts", async () => {
    const { email, password } = await signupUser("login-ratelimit")

    const wrongAttempts: number[] = []
    for (let i = 0; i < 3; i++) {
      const res = await request(app).post("/auth/login").set("X-Forwarded-For", TEST_IP).send({ email, password: "wrong-password-attempt" })
      wrongAttempts.push(res.status)
    }
    expect(wrongAttempts.every((s) => s === 401)).toBe(true)

    // 2 more attempts (now at 5 total) — the last one still succeeds.
    const correctAttempts: number[] = []
    for (let i = 0; i < 2; i++) {
      const res = await request(app).post("/auth/login").set("X-Forwarded-For", TEST_IP).send({ email, password })
      correctAttempts.push(res.status)
    }
    expect(correctAttempts).toEqual([200, 200])

    // Quota (5) is now exhausted — the 6th attempt is rejected even with
    // the correct password.
    const overLimit = await request(app).post("/auth/login").set("X-Forwarded-For", TEST_IP).send({ email, password })
    expect(overLimit.status).toBe(429)
  })
})
