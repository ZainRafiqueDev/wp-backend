import { randomUUID } from "node:crypto"

import request from "supertest"
import { describe, expect, it, vi } from "vitest"

// Per-file config, applied before src/env.ts loads: trust one proxy hop so
// each test can send from its own X-Forwarded-For address. The OTP/forgot
// limiters are per-IP in the shared Redis, so this keeps this file from
// eating otpAndPasswordReset.integration.test.ts's budget (and vice versa).
vi.hoisted(() => {
  process.env.TRUST_PROXY_HOPS = "1"
})

import { pool } from "../../src/lib/db.js"
import { app, signupUser, uniqueEmail } from "../helpers.js"
import { captureLogs } from "../helpers/captureLogs.js"

// CS-10 / owner's "Test D": representative requests carrying synthetic
// secret markers are driven through the real app while every byte written
// to stdout/stderr is captured; no marker, OTP code or token link may reach
// any log line.

const CANARY = /CANARY/i
// A link carrying a live token/code, e.g. ...?token=abc or /reset/abc.
const LIVE_TOKEN_LINK = /(?:token|code)=(?!\[redacted\])[A-Za-z0-9_-]{8,}/
const SIX_DIGIT_CODE = /(?<![\d.])\d{6}(?![\d.])/

function testIp(): string {
  const n = () => Math.floor(Math.random() * 250) + 1
  return `10.${n()}.${n()}.${n()}`
}

// One fresh client address per run of this file.
const CLIENT_IP = testIp()

function emailLines(lines: string[]) {
  return lines.filter((l) => l.includes("email not sent"))
}

describe("Test D — secrets never reach logs", () => {
  it("signup / login / auth headers / cookies / query tokens: no CANARY marker in any log line", async () => {
    const suffix = randomUUID().slice(0, 8)
    const password = `CANARY-PW-${suffix}`
    const email = uniqueEmail("cs10-logs")
    const cap = captureLogs()
    try {
      await request(app).post("/auth/signup").set("X-Forwarded-For", CLIENT_IP).send({ name: "Log Canary", email, password })
      await request(app).post("/auth/login").set("X-Forwarded-For", CLIENT_IP).send({ email, password: `${password}-wrong` })
      await request(app).post("/auth/login").set("X-Forwarded-For", CLIENT_IP).send({ email, password })
      await request(app)
        .get("/auth/me").set("X-Forwarded-For", CLIENT_IP)
        .set("Authorization", `Bearer CANARY-TOK-${suffix}`)
        .set("Cookie", `chatmate360_access_token=CANARY-CK-${suffix}; chatmate360_refresh_token=CANARY-CK2-${suffix}`)
      await request(app).get(`/auth/me?token=CANARY-Q-${suffix}`).set("X-Forwarded-For", CLIENT_IP).set("X-Api-Key", `CANARY-XAPI-${suffix}`)
      await request(app).post("/auth/password/reset").set("X-Forwarded-For", CLIENT_IP).send({ token: `CANARY-RESET-${suffix}`, password: `CANARY-NEWPW-${suffix}` })
      await request(app).post("/auth/login").set("X-Forwarded-For", CLIENT_IP).set("Content-Type", "application/json").send(`{"password":"CANARY-BADJSON-${suffix}"`)
    } finally {
      cap.restore()
    }
    expect(cap.text()).not.toMatch(CANARY)
  })

  it("OTP e-mail: the code is never logged (default non-production redaction)", async () => {
    const email = uniqueEmail("cs10-otp")
    const cap = captureLogs()
    try {
      const signup = await request(app).post("/auth/signup").set("X-Forwarded-For", CLIENT_IP).send({ name: "OTP Canary", email, password: "correct horse battery staple" })
      expect(signup.status).toBe(201)
      const send = await request(app).post("/auth/otp/send").set("X-Forwarded-For", CLIENT_IP).send({ email, purpose: "EMAIL_VERIFY" })
      expect(send.status, JSON.stringify(send.body)).toBe(200)
    } finally {
      cap.restore()
    }
    const lines = emailLines(cap.lines()).filter((l) => l.includes(email))
    expect(lines.some((l) => l.includes("verification code"))).toBe(true)
    for (const line of lines) {
      // Only the body preview: request ids / e-mail suffixes are UUIDs that can contain digit runs.
      const { emailPreview } = JSON.parse(line) as { emailPreview?: string }
      expect(emailPreview).toBeTypeOf("string")
      expect(emailPreview).not.toMatch(SIX_DIGIT_CODE)
      expect(line).not.toMatch(LIVE_TOKEN_LINK)
    }
    expect(cap.text()).not.toMatch(LIVE_TOKEN_LINK)
  })

  it("verify-email, password-reset and invite e-mails: links with live tokens are never logged", async () => {
    const owner = await signupUser("cs10-reset")
    // Inviting members needs a paid plan (same setup as workspaceMembers.integration.test.ts).
    await pool!.query(
      `insert into subscriptions (user_id, stripe_customer_id, plan, status) values ($1, $2, 'crawl_plus', 'active')`,
      [owner.user.id, `cus_cs10_${randomUUID()}`],
    )
    const inviteEmail = uniqueEmail("cs10-invitee")
    const cap = captureLogs()
    try {
      await request(app).post("/auth/password/forgot").set("X-Forwarded-For", CLIENT_IP).send({ email: owner.email })
      const invite = await request(app)
        .post("/account/members/invite").set("X-Forwarded-For", CLIENT_IP)
        .set("Authorization", `Bearer ${owner.session.access_token}`)
        .send({ email: inviteEmail, role: "viewer" })
      expect(invite.status).toBe(201)
    } finally {
      cap.restore()
    }
    const lines = emailLines(cap.lines())
    expect(lines.some((l) => l.includes(owner.email) && /reset/i.test(l))).toBe(true)
    expect(lines.some((l) => l.includes(inviteEmail) && /invited/i.test(l))).toBe(true)
    const out = cap.text()
    expect(out).not.toMatch(LIVE_TOKEN_LINK)
    expect(out).not.toContain("/auth/reset-password")
    expect(out).not.toContain("/invite/accept")
  })
})
