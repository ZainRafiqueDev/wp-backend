import { randomUUID } from "node:crypto"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

// CS-04 review round 2 (B04-002, S3-021, B06-021, B07-001/S3-010 and the
// attachment identity part of VER-02): a verified chat identity must not be
// reachable by anyone who merely knows or reuses a session string, from
// another chatbot, or from the dashboard preview; OTP guesses must be capped
// atomically; the code must not be checkpointed; and attachment uploads must
// take the customer from the verified identity, not the request body.

const llmInvoke = vi.fn()
vi.mock("../../src/langgraph/llm.js", () => ({
  hasCommerceLlm: vi.fn(() => true),
  getCommerceLlm: vi.fn(() => ({ invoke: llmInvoke })),
}))
vi.mock("../../src/lib/email.js", () => ({
  sendEmail: vi.fn(async () => ({ delivered: true })),
}))
vi.mock("../../src/lib/bookly/connector.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/bookly/connector.js")>("../../src/lib/bookly/connector.js")
  return { ...actual, getAvailableSlots: vi.fn(), cancelAppointment: vi.fn(), rescheduleAppointment: vi.fn(), addNote: vi.fn() }
})

const { pool } = await import("../../src/lib/db.js")
const { encryptSecret } = await import("../../src/lib/crypto.js")
const { signCustomerSessionToken } = await import("../../src/lib/auth.js")
const { sendEmail } = await import("../../src/lib/email.js")
const { sendOtp, verifyOtp } = await import("../../src/services/otp.service.js")
const { chatWithOwnChatbot } = await import("../../src/services/chatbot.service.js")
const { tryAnswerWithBooklyGraph } = await import("../../src/langgraph/booklyEntrypoint.js")
const booklyConnector = await import("../../src/lib/bookly/connector.js")
const { app, signupUser, createReadyChatbotWithDomain } = await import("../helpers.js")

const START = "2026-12-21T09:00:00.000Z"

function uniqueEmail(label: string): string {
  return `cs04b-${label}-${randomUUID().slice(0, 8)}@example.com`
}

function codeSentTo(email: string): string {
  const calls = vi.mocked(sendEmail).mock.calls.filter(([input]) => input.to === email.toLowerCase())
  const code = calls[calls.length - 1]?.[0].text.match(/code is: (\d{6})/)?.[1]
  if (!code) throw new Error(`no code sent to ${email}`)
  return code
}

function intentMock(intent: string) {
  return async (messages: { content: string }[]) => {
    const prompt = String(messages[0]?.content ?? "")
    if (prompt.includes("Classify the customer's LATEST message")) return { content: intent }
    if (prompt.includes("Does this reply confirm")) {
      const reply = (prompt.match(/Reply: "([^"]*)"/i)?.[1] ?? "").toLowerCase()
      return { content: reply.includes("yes") ? "yes" : "no" }
    }
    return { content: "null" }
  }
}

async function seedBookly(label: string) {
  const db = pool!
  const signup = await signupUser(`cs04b-${label}`)
  const domain = `cs04b-${label}-${randomUUID().slice(0, 6)}.example`
  await db.query(`insert into subscriptions (user_id, stripe_customer_id, plan, status) values ($1, $2, 'full_custom', 'active')`, [signup.user.id, `cus_${randomUUID()}`])
  const { rows } = await db.query(
    "insert into chatbots (user_id, name, sources, theme, status, allowed_domain) values ($1, 'bot', '[]', '{}', 'ready', $2) returning id",
    [signup.user.id, domain],
  )
  const chatbotId = rows[0].id as string
  const resourceId = `resource-${randomUUID()}`
  await db.query(
    `insert into chatbot_bookly_credentials (chatbot_id, base_url, resource_id, resource_label, api_key_encrypted) values ($1, 'https://bookly.example.com', $2, 'Resource', $3)`,
    [chatbotId, resourceId, encryptSecret("test-bookly-api-key")],
  )
  return { chatbotId, resourceId, domain, ownerToken: signup.session.access_token }
}

async function seedBooking(chatbotId: string, resourceId: string, email: string) {
  const { rows: c } = await pool!.query("insert into customer_identities (chatbot_id, email) values ($1, $2) returning id", [chatbotId, email])
  const { rows: a } = await pool!.query(
    `insert into chatbot_bookly_appointments (chatbot_id, customer_id, bookly_appointment_id, idempotency_key, bookly_resource_id, start_time, status)
     values ($1, $2, $3, $4, $5, $6, 'CONFIRMED') returning id`,
    [chatbotId, c[0].id, `bookly-${randomUUID()}`, randomUUID(), resourceId, START],
  )
  return { customerId: c[0].id as string, appointmentId: a[0].id as string }
}

function widgetChat(chatbotId: string, domain: string, body: Record<string, unknown>) {
  return request(app)
    .post(`/public/chatbots/${chatbotId}/chat`)
    .set("X-Widget-Origin", `https://${domain}`)
    .send({ history: [], ...body })
}

/** Victim verifies over the widget; returns the session string it used and the server token. */
async function victimVerifiesOverWidget(chatbotId: string, domain: string, email: string, legacySessionId: string) {
  const t1 = await widgetChat(chatbotId, domain, { message: "when is my appointment?", sessionId: legacySessionId })
  expect(t1.status).toBe(200)
  const token = t1.body.sessionToken as string | undefined
  const t2 = await widgetChat(chatbotId, domain, { message: email, sessionId: legacySessionId, sessionToken: token })
  expect(t2.body.text).toMatch(/verification code/i)
  const t3 = await widgetChat(chatbotId, domain, { message: codeSentTo(email), sessionId: legacySessionId, sessionToken: token })
  expect(t3.body.text).toMatch(/upcoming appointments/i)
  return token
}

describe("CS-04: a verified identity is bound to a server-issued session for one chatbot", () => {
  beforeEach(() => {
    llmInvoke.mockReset()
    llmInvoke.mockImplementation(intentMock("appointment_status"))
    vi.mocked(sendEmail).mockClear()
    vi.mocked(booklyConnector.cancelAppointment).mockReset()
  })

  it("another visitor reusing the victim's session id gets a fresh session, not the victim's verified identity", async () => {
    const { chatbotId, resourceId, domain } = await seedBookly("reuse")
    const victimEmail = uniqueEmail("victim")
    await seedBooking(chatbotId, resourceId, victimEmail)
    const sharedSessionId = `widget-session-${randomUUID()}`
    await victimVerifiesOverWidget(chatbotId, domain, victimEmail, sharedSessionId)

    const attacker = await widgetChat(chatbotId, domain, { message: "when is my appointment?", sessionId: sharedSessionId })
    expect(attacker.status).toBe(200)
    expect(attacker.body.text).not.toMatch(/upcoming appointments|Dec 21|09:00/i)
    expect(attacker.body.text).toMatch(/what email/i)

    // A forged/foreign token is treated the same way.
    const forged = await widgetChat(chatbotId, domain, { message: "when is my appointment?", sessionToken: "not-a-real-token" })
    expect(forged.body.text).not.toMatch(/upcoming appointments/i)
  })

  it("the dashboard preview with the same session string does not inherit a widget visitor's verification", async () => {
    const { chatbotId, resourceId, domain, ownerToken } = await seedBookly("preview")
    const victimEmail = uniqueEmail("victim")
    await seedBooking(chatbotId, resourceId, victimEmail)
    const sharedSessionId = `widget-session-${randomUUID()}`
    await victimVerifiesOverWidget(chatbotId, domain, victimEmail, sharedSessionId)

    const preview = await chatWithOwnChatbot(ownerToken, chatbotId, { question: "when is my appointment?", history: [], sessionId: sharedSessionId })
    expect(preview.text).not.toMatch(/upcoming appointments|Dec 21|09:00/i)
    expect(preview.text).toMatch(/what email/i)
  })

  it("a thread key verified on chatbot A is never a verified session on chatbot B", async () => {
    const a = await seedBookly("cross-a")
    const b = await seedBookly("cross-b")
    const email = uniqueEmail("cross")
    await seedBooking(a.chatbotId, a.resourceId, email)
    await seedBooking(b.chatbotId, b.resourceId, email)
    const key = `same-key-${randomUUID()}`

    await tryAnswerWithBooklyGraph(a.chatbotId, key, "when is my appointment?")
    await tryAnswerWithBooklyGraph(a.chatbotId, key, email)
    const ok = await tryAnswerWithBooklyGraph(a.chatbotId, key, codeSentTo(email))
    expect(ok.text).toMatch(/upcoming appointments/i)

    const onB = await tryAnswerWithBooklyGraph(b.chatbotId, key, "when is my appointment?")
    expect(onB.text).not.toMatch(/upcoming appointments|don't see any/i)
    expect(onB.text).toMatch(/what email/i)
  })

  it("verified as A, asking about B's email requires B's code and touches nothing of B's", async () => {
    const { chatbotId, resourceId } = await seedBookly("a-then-b")
    const emailA = uniqueEmail("a")
    const emailB = uniqueEmail("b")
    await seedBooking(chatbotId, resourceId, emailA)
    const bookingB = await seedBooking(chatbotId, resourceId, emailB)
    const key = `a-then-b-${randomUUID()}`

    await tryAnswerWithBooklyGraph(chatbotId, key, "when is my appointment?")
    await tryAnswerWithBooklyGraph(chatbotId, key, emailA)
    await tryAnswerWithBooklyGraph(chatbotId, key, codeSentTo(emailA))

    llmInvoke.mockImplementation(intentMock("cancel_appointment"))
    const askB = await tryAnswerWithBooklyGraph(chatbotId, key, `cancel the appointment for ${emailB}`)
    expect(askB.text).toMatch(/verification code/i)
    const wrong = await tryAnswerWithBooklyGraph(chatbotId, key, "yes")
    expect(wrong.text).not.toMatch(/is that right|cancelled/i)
    expect(booklyConnector.cancelAppointment).not.toHaveBeenCalled()
    const { rows } = await pool!.query("select status from chatbot_bookly_appointments where id = $1", [bookingB.appointmentId])
    expect(rows[0].status).toBe("CONFIRMED")
  })

  it("the OTP the visitor typed is never written to the LangGraph checkpoint tables", async () => {
    const { chatbotId, resourceId } = await seedBookly("checkpoint")
    const email = uniqueEmail("cp")
    await seedBooking(chatbotId, resourceId, email)
    const key = `checkpoint-${randomUUID()}`
    await tryAnswerWithBooklyGraph(chatbotId, key, "when is my appointment?")
    await tryAnswerWithBooklyGraph(chatbotId, key, email)
    const code = codeSentTo(email)
    const ok = await tryAnswerWithBooklyGraph(chatbotId, key, code)
    expect(ok.text).toMatch(/upcoming appointments/i)

    const like = `%${key}`
    const { rows } = await pool!.query<{ n: string }>(
      `select (
         (select count(*) from checkpoint_writes where thread_id like $1 and position(convert_to($2, 'UTF8') in blob) > 0) +
         (select count(*) from checkpoint_blobs where thread_id like $1 and blob is not null and position(convert_to($2, 'UTF8') in blob) > 0) +
         (select count(*) from checkpoints where thread_id like $1 and checkpoint::text like '%' || $2 || '%')
       )::text as n`,
      [like, code],
    )
    expect(Number(rows[0].n)).toBe(0)
  })
})

describe("CS-04: OTP attempts are capped atomically (B07-001/S3-010)", () => {
  it("concurrent wrong guesses never push attempts past max_attempts, and the right code no longer works afterwards", async () => {
    const { chatbotId } = await seedBookly("otp-race")
    const email = uniqueEmail("race")
    vi.mocked(sendEmail).mockClear()
    await sendOtp({ email, purpose: "ORDER_ACCESS", chatbotId })
    const code = codeSentTo(email)
    const wrong = code === "000000" ? "111111" : "000000"

    const results = await Promise.allSettled(Array.from({ length: 20 }, () => verifyOtp({ email, purpose: "ORDER_ACCESS", code: wrong, chatbotId })))
    expect(results.every((r) => r.status === "rejected")).toBe(true)

    const { rows } = await pool!.query<{ attempts: number; max_attempts: number }>(
      "select attempts, max_attempts from auth_otps where email = $1 and chatbot_id = $2 order by created_at desc limit 1",
      [email, chatbotId],
    )
    expect(rows[0].attempts).toBeLessThanOrEqual(rows[0].max_attempts)
    await expect(verifyOtp({ email, purpose: "ORDER_ACCESS", code, chatbotId })).rejects.toThrow()
  })

  it("requesting a code for an unknown email creates no customer_identities row", async () => {
    const { chatbotId } = await seedBookly("otp-norow")
    const email = uniqueEmail("ghost")
    await sendOtp({ email, purpose: "ORDER_ACCESS", chatbotId })
    const { rows } = await pool!.query("select 1 from customer_identities where chatbot_id = $1 and email = $2", [chatbotId, email])
    expect(rows).toHaveLength(0)
  })
})

const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([1, 2, 3, 4, 5])])

describe("CS-04: attachment uploads take the customer from the verified identity", () => {
  async function seedAttachmentBot(label: string) {
    const domain = `cs04b-att-${label}-${randomUUID().slice(0, 6)}.example`
    const seeded = await createReadyChatbotWithDomain(`cs04b-att-${label}`, domain)
    await pool!.query(`insert into subscriptions (user_id, stripe_customer_id, plan, status) values ($1, $2, 'crawl_plus', 'active')`, [
      seeded.userId,
      `cus_${randomUUID()}`,
    ])
    const { rows: victim } = await pool!.query("insert into customer_identities (chatbot_id, email) values ($1, $2) returning id", [
      seeded.chatbotId,
      uniqueEmail("att-victim"),
    ])
    const start = await widgetChat(seeded.chatbotId, domain, { message: "hello", sessionId: `legacy-${randomUUID()}` })
    return { chatbotId: seeded.chatbotId as string, domain, victimCustomerId: victim[0].id as string, sessionToken: start.body.sessionToken as string }
  }

  it("a foreign customerId in the upload body is rejected and never stored", async () => {
    const { chatbotId, domain, victimCustomerId, sessionToken } = await seedAttachmentBot("foreign")
    const res = await request(app)
      .post(`/public/chatbots/${chatbotId}/attachments`)
      .set("X-Widget-Origin", `https://${domain}`)
      .field("sessionId", `legacy-${randomUUID()}`)
      .field("sessionToken", sessionToken ?? "")
      .field("customerId", victimCustomerId)
      .attach("file", PNG_BYTES, "x.png")
    expect(res.status).toBe(400)
    const { rows } = await pool!.query("select 1 from chatbot_attachments where chatbot_id = $1 and customer_identity_id = $2", [chatbotId, victimCustomerId])
    expect(rows).toHaveLength(0)
  })

  it("with a valid signed customer token the upload is linked to that customer only", async () => {
    const { chatbotId, domain, victimCustomerId, sessionToken } = await seedAttachmentBot("token")
    const customerToken = signCustomerSessionToken({ customerId: victimCustomerId, chatbotId })
    const res = await request(app)
      .post(`/public/chatbots/${chatbotId}/attachments`)
      .set("X-Widget-Origin", `https://${domain}`)
      .field("sessionToken", sessionToken)
      .field("customerToken", customerToken)
      .attach("file", PNG_BYTES, "x.png")
    expect(res.status).toBe(201)
    const { rows } = await pool!.query("select customer_identity_id from chatbot_attachments where id = $1", [res.body.attachment.id])
    expect(rows[0].customer_identity_id).toBe(victimCustomerId)
  })

  it("an upload without a server-issued session is refused", async () => {
    const { chatbotId, domain } = await seedAttachmentBot("nosession")
    const res = await request(app)
      .post(`/public/chatbots/${chatbotId}/attachments`)
      .set("X-Widget-Origin", `https://${domain}`)
      .field("sessionId", `legacy-${randomUUID()}`)
      .attach("file", PNG_BYTES, "x.png")
    expect(res.status).toBe(400)
  })
})
