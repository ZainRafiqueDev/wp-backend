import { describe, expect, it } from "vitest"
import request from "supertest"

import { app, cookieValue, uniqueEmail } from "../helpers.js"
import { pool } from "../../src/lib/db.js"
import { hashToken, generateOpaqueToken } from "../../src/services/notification.service.js"
import { verifyOtpProofToken } from "../../src/lib/auth.js"

const FIXED_CODE = "482193"

/** Point the latest OTP row at a known code so tests don't need ESM spy tricks. */
async function plantKnownOtp(email: string, purpose: string) {
  const { rowCount } = await pool!.query(
    `update auth_otps set otp_hash = $1
     where id = (
       select id from auth_otps
       where email = $2 and purpose = $3 and verified_at is null
       order by created_at desc limit 1
     )`,
    [hashToken(FIXED_CODE), email, purpose],
  )
  expect(rowCount).toBe(1)
}

describe("POST /auth/otp — purpose-based email OTP", () => {
  it("sends an EMAIL_VERIFY OTP for an unverified account and verifies it", async () => {
    const email = uniqueEmail("otp-verify")
    const signup = await request(app)
      .post("/auth/signup")
      .send({ name: "OTP User", email, password: "correct horse battery staple" })
    expect(signup.status).toBe(201)
    expect(signup.body.user.emailVerified).toBe(false)

    const send = await request(app)
      .post("/auth/otp/send")
      .send({ email, purpose: "EMAIL_VERIFY" })
    expect(send.status).toBe(200)
    expect(send.body.message).toMatch(/verification code/i)

    const { rows } = await pool!.query<{ otp_hash: string }>(
      `select otp_hash from auth_otps where email = $1 and purpose = 'EMAIL_VERIFY' order by created_at desc limit 1`,
      [email],
    )
    expect(rows[0]?.otp_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(rows[0]?.otp_hash).not.toBe(FIXED_CODE)

    await plantKnownOtp(email, "EMAIL_VERIFY")

    const verify = await request(app)
      .post("/auth/otp/verify")
      .send({ email, purpose: "EMAIL_VERIFY", code: FIXED_CODE })
    expect(verify.status).toBe(200)
    expect(verify.body.emailVerified).toBe(true)
    expect(verify.body.proofToken).toBeTypeOf("string")

    const proof = verifyOtpProofToken(verify.body.proofToken)
    expect(proof?.purpose).toBe("EMAIL_VERIFY")
    expect(proof?.email).toBe(email)

    const { rows: users } = await pool!.query<{ email_verified: boolean }>(
      "select email_verified from users where email = $1",
      [email],
    )
    expect(users[0]?.email_verified).toBe(true)

    const replay = await request(app)
      .post("/auth/otp/verify")
      .send({ email, purpose: "EMAIL_VERIFY", code: FIXED_CODE })
    expect(replay.status).toBe(400)
  })

  it("rejects a wrong code and counts attempts", async () => {
    const email = uniqueEmail("otp-bad")
    await request(app)
      .post("/auth/signup")
      .send({ name: "OTP User", email, password: "correct horse battery staple" })

    await request(app).post("/auth/otp/send").send({ email, purpose: "EMAIL_VERIFY" })
    await plantKnownOtp(email, "EMAIL_VERIFY")

    const bad = await request(app)
      .post("/auth/otp/verify")
      .send({ email, purpose: "EMAIL_VERIFY", code: "000000" })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toMatch(/incorrect|attempt/i)

    const { rows } = await pool!.query<{ attempts: number }>(
      `select attempts from auth_otps where email = $1 order by created_at desc limit 1`,
      [email],
    )
    expect(rows[0]?.attempts).toBe(1)
  })

  it("does not reveal whether an unknown email exists on send", async () => {
    const res = await request(app)
      .post("/auth/otp/send")
      .send({ email: uniqueEmail("never-signed-up"), purpose: "EMAIL_VERIFY" })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })

  it("promotes a commerce customer to EMAIL_VERIFIED on ORDER_ACCESS OTP (Express only)", async () => {
    const ownerEmail = uniqueEmail("otp-order-owner")
    const signup = await request(app)
      .post("/auth/signup")
      .send({ name: "Owner", email: ownerEmail, password: "correct horse battery staple" })
    await pool!.query("update users set email_verified = true where id = $1", [signup.body.user.id])

    const bot = await request(app)
      .post("/chatbots")
      .set("Authorization", `Bearer ${cookieValue(signup, "chatmate360_access_token")}`)
      .send({
        name: "Order bot",
        sources: [{ type: "pdf", label: "a.pdf", characters: 20, content: "Hello support." }],
      })
    expect(bot.status).toBe(201)
    const chatbotId = bot.body.chatbot.id as string
    const customerEmail = uniqueEmail("otp-customer")

    const send = await request(app)
      .post("/auth/otp/send")
      .send({ email: customerEmail, purpose: "ORDER_ACCESS", chatbotId })
    expect(send.status).toBe(200)

    await plantKnownOtp(customerEmail, "ORDER_ACCESS")

    const verify = await request(app)
      .post("/auth/otp/verify")
      .send({ email: customerEmail, purpose: "ORDER_ACCESS", chatbotId, code: FIXED_CODE })
    expect(verify.status).toBe(200)
    expect(verify.body.customerId).toBeTypeOf("string")
    expect(verify.body.verificationLevel).toBe("EMAIL_VERIFIED")

    const { rows } = await pool!.query<{ verification_level: string }>(
      "select verification_level from customer_identities where id = $1",
      [verify.body.customerId],
    )
    expect(rows[0]?.verification_level).toBe("EMAIL_VERIFIED")

    expect(verifyOtpProofToken("not-a-token")).toBeNull()
  })
})

describe("POST /auth/password/* — high-entropy reset tokens", () => {
  it("forgot always returns the same enumeration-safe message", async () => {
    const known = uniqueEmail("pw-known")
    await request(app)
      .post("/auth/signup")
      .send({ name: "Reset User", email: known, password: "correct horse battery staple" })

    const exists = await request(app).post("/auth/password/forgot").send({ email: known })
    const missing = await request(app)
      .post("/auth/password/forgot")
      .send({ email: uniqueEmail("pw-missing") })

    expect(exists.status).toBe(200)
    expect(missing.status).toBe(200)
    expect(exists.body.message).toBe(missing.body.message)
  })

  it("resets password with a stored hashed token, marks used_at, and revokes sessions", async () => {
    const email = uniqueEmail("pw-reset")
    const password = "correct horse battery staple"
    const signup = await request(app).post("/auth/signup").send({ name: "Reset User", email, password })
    const oldRefresh = cookieValue(signup, "chatmate360_refresh_token")

    await request(app).post("/auth/password/forgot").send({ email })

    const raw = generateOpaqueToken()
    await pool!.query("delete from password_reset_tokens where user_id = $1", [signup.body.user.id])
    await pool!.query(
      `insert into password_reset_tokens (user_id, token_hash, expires_at)
       values ($1, $2, now() + interval '30 minutes')`,
      [signup.body.user.id, hashToken(raw)],
    )

    const reset = await request(app)
      .post("/auth/password/reset")
      .send({ token: raw, password: "brand new password 99" })
    expect(reset.status).toBe(200)

    const { rows: tokens } = await pool!.query<{ used_at: Date | null }>(
      `select used_at from password_reset_tokens where token_hash = $1`,
      [hashToken(raw)],
    )
    expect(tokens[0]?.used_at).toBeTruthy()

    const replay = await request(app)
      .post("/auth/password/reset")
      .send({ token: raw, password: "another password 99" })
    expect(replay.status).toBe(400)

    const login = await request(app)
      .post("/auth/login")
      .send({ email, password: "brand new password 99" })
    expect(login.status).toBe(200)

    const oldSession = await request(app).post("/auth/refresh").send({ refresh_token: oldRefresh })
    expect(oldSession.status).toBe(401)
  })
})
