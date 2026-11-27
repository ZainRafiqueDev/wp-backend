import { randomInt, randomUUID } from "node:crypto"

import request from "supertest"
import { afterEach, describe, expect, it, vi } from "vitest"

// CS-09 (B10-013, B05-015, S3-011, B05-023). Low limits for this file only,
// stubbed before the app (and src/env.ts) load. Trust proxy is enabled
// (exactly one hop) so every request can carry its own X-Forwarded-For IP:
// each test uses fresh random IPs and emails, so nothing here shares a
// Redis key with another test file or an earlier run, and no key is ever
// deleted or flushed.
const LIMIT = 3
vi.stubEnv("TRUST_PROXY_HOPS", "1")
for (const name of [
  "LOGIN_RATE_LIMIT_PER_MIN",
  "LOGIN_EMAIL_RATE_LIMIT_PER_15_MIN",
  "OTP_SEND_RATE_LIMIT_PER_MIN",
  "OTP_VERIFY_RATE_LIMIT_PER_MIN",
  "OTP_VERIFY_EMAIL_RATE_LIMIT_PER_15_MIN",
  "PASSWORD_FORGOT_RATE_LIMIT_PER_MIN",
  "PASSWORD_FORGOT_EMAIL_RATE_LIMIT_PER_15_MIN",
  "PASSWORD_RESET_RATE_LIMIT_PER_MIN",
  "SIGNUP_RATE_LIMIT_PER_MIN",
  "VERIFY_EMAIL_RATE_LIMIT_PER_MIN",
  "RESEND_VERIFICATION_USER_RATE_LIMIT_PER_15_MIN",
  "ADMIN_LOGIN_RATE_LIMIT_PER_MIN",
  "ADMIN_LOGIN_EMAIL_RATE_LIMIT_PER_15_MIN",
]) {
  vi.stubEnv(name, String(LIMIT))
}

const { app } = await import("../../src/app.js")
const { cacheRedis } = await import("../../src/lib/redis.js")

function freshIp(): string {
  return `10.${randomInt(0, 256)}.${randomInt(0, 256)}.${randomInt(1, 255)}`
}

function freshEmail(label: string): string {
  return `cs09-${label}-${randomUUID()}@example.test`
}

function post(path: string, ip: string, body: object) {
  return request(app).post(path).set("X-Forwarded-For", ip).send(body)
}

const LIMITER_MESSAGE = /^Too many/

afterEach(() => {
  vi.restoreAllMocks()
})

describe("CS-09: previously unlimited auth routes now return 429", () => {
  it.each([
    ["/auth/signup", () => ({ name: "Cs09 User", email: freshEmail("signup"), password: "x" })],
    ["/auth/verify-email", () => ({ token: "not-a-real-token" })],
    ["/auth/password/reset", () => ({ token: "not-a-real-token", password: "x" })],
  ])("%s is capped per IP", async (path, body) => {
    const ip = freshIp()
    for (let i = 0; i < LIMIT; i++) {
      const res = await post(path, ip, body())
      expect(res.status).not.toBe(429)
    }
    const blocked = await post(path, ip, body())
    expect(blocked.status).toBe(429)
    expect(blocked.body.error).toMatch(LIMITER_MESSAGE)
  })

  it("the legacy /auth/reset-password alias shares the /auth/password/reset bucket", async () => {
    const ip = freshIp()
    for (let i = 0; i < LIMIT; i++) {
      const res = await post("/auth/password/reset", ip, { token: "x" })
      expect(res.status).not.toBe(429)
    }
    const blocked = await post("/auth/reset-password", ip, { token: "x" })
    expect(blocked.status).toBe(429)
  })

  it("/auth/resend-verification is capped per user even across rotating IPs", async () => {
    const signup = await post("/auth/signup", freshIp(), {
      name: "Cs09 Resend",
      email: freshEmail("resend"),
      password: "correct horse battery staple",
    })
    expect(signup.status).toBe(201)
    const raw = signup.headers["set-cookie"] as unknown as string[]
    const token = decodeURIComponent(raw.find((c) => c.startsWith("chatmate360_access_token="))!.split(";")[0].split("=")[1])

    for (let i = 0; i < LIMIT; i++) {
      const res = await request(app)
        .post("/auth/resend-verification")
        .set("X-Forwarded-For", freshIp())
        .set("Authorization", `Bearer ${token}`)
      expect(res.status).not.toBe(429)
    }
    const blocked = await request(app)
      .post("/auth/resend-verification")
      .set("X-Forwarded-For", freshIp())
      .set("Authorization", `Bearer ${token}`)
    expect(blocked.status).toBe(429)
  })
})

describe("CS-09: per-email limits block an attacker rotating IPs", () => {
  it("/auth/login: one email from a fresh IP every attempt (case/whitespace variants count together)", async () => {
    const email = freshEmail("login")
    const variants = [email, email.toUpperCase(), `  ${email}  `]
    for (let i = 0; i < LIMIT; i++) {
      const res = await post("/auth/login", freshIp(), { email: variants[i % variants.length], password: "wrong-password" })
      expect(res.status).toBe(401)
    }
    const blocked = await post("/auth/login", freshIp(), { email, password: "wrong-password" })
    expect(blocked.status).toBe(429)
    expect(blocked.body.error).toMatch(LIMITER_MESSAGE)
  })

  it("/auth/otp/verify: one email from a fresh IP every attempt", async () => {
    const email = freshEmail("otp-verify")
    for (let i = 0; i < LIMIT; i++) {
      const res = await post("/auth/otp/verify", freshIp(), { email, purpose: "EMAIL_VERIFY", code: "000000" })
      expect(res.status).not.toBe(429)
    }
    const blocked = await post("/auth/otp/verify", freshIp(), { email, purpose: "EMAIL_VERIFY", code: "000000" })
    expect(blocked.status).toBe(429)
    expect(blocked.body.error).toMatch(LIMITER_MESSAGE)
  })

  it("/admin/login: one email from a fresh IP every attempt", async () => {
    const email = freshEmail("admin-login")
    for (let i = 0; i < LIMIT; i++) {
      const res = await post("/admin/login", freshIp(), { email: i === 1 ? email.toUpperCase() : email, password: "wrong-password" })
      expect(res.status).toBe(401)
    }
    const blocked = await post("/admin/login", freshIp(), { email, password: "wrong-password" })
    expect(blocked.status).toBe(429)
  })

  it("/auth/password/forgot: one email from a fresh IP every attempt", async () => {
    const email = freshEmail("forgot")
    for (let i = 0; i < LIMIT; i++) {
      const res = await post("/auth/password/forgot", freshIp(), { email })
      expect(res.status).toBe(200)
    }
    const blocked = await post("/auth/password/forgot", freshIp(), { email })
    expect(blocked.status).toBe(429)
  })
})

describe("CS-09: Redis errors degrade to the in-memory cap, never to unlimited", () => {
  function breakRedis() {
    // RateLimiterRedis's increment is the `rlflxIncr` script command on the
    // shared client; rejecting it is exactly what an unreachable Redis does.
    vi.spyOn(cacheRedis as unknown as { rlflxIncr: () => Promise<unknown> }, "rlflxIncr").mockRejectedValue(
      new Error("ECONNREFUSED (simulated)"),
    )
  }

  it.each([
    ["/auth/login", () => ({ email: freshEmail("rl-login"), password: "wrong-password" })],
    ["/auth/otp/send", () => ({ email: freshEmail("rl-otp-send"), purpose: "EMAIL_VERIFY" })],
    ["/auth/otp/verify", () => ({ email: freshEmail("rl-otp-verify"), purpose: "EMAIL_VERIFY", code: "000000" })],
    ["/auth/password/forgot", () => ({ email: freshEmail("rl-forgot") })],
    ["/auth/password/reset", () => ({ token: "not-a-real-token", password: "x" })],
    ["/auth/signup", () => ({ name: "Cs09 User", email: freshEmail("rl-signup"), password: "x" })],
    ["/auth/verify-email", () => ({ token: "not-a-real-token" })],
    ["/admin/login", () => ({ email: freshEmail("rl-admin"), password: "wrong-password" })],
  ])("%s still returns 429 after the per-IP insurance limit", async (path, body) => {
    breakRedis()
    const ip = freshIp()
    for (let i = 0; i < LIMIT; i++) {
      const res = await post(path, ip, body())
      expect(res.status).not.toBe(429)
    }
    const blocked = await post(path, ip, body())
    expect(blocked.status).toBe(429)
    expect(blocked.body.error).toMatch(LIMITER_MESSAGE)
  })

  it("/auth/login per-email limit also survives a Redis outage", async () => {
    breakRedis()
    const email = freshEmail("rl-login-email")
    for (let i = 0; i < LIMIT; i++) {
      const res = await post("/auth/login", freshIp(), { email, password: "wrong-password" })
      expect(res.status).toBe(401)
    }
    const blocked = await post("/auth/login", freshIp(), { email, password: "wrong-password" })
    expect(blocked.status).toBe(429)
  })
})
