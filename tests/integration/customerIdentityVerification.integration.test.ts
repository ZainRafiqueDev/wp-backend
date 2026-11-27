import { randomUUID } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"

// CS-04 (VER-02 = B04-001, B04-008, B06-023, B09-002, S3-014, B08-019).
// The public Bookly and commerce graphs used to treat an email typed into the
// chat as the customer's identity: anyone could list, cancel, reschedule or
// annotate another customer's appointments, read their order status and
// booking number, and consume their queued notifications, and the "no
// appointments under that email" reply told them which emails had bookings.
// Now the visitor has to enter a one-time code sent to that email (the
// existing ORDER_ACCESS OTP), or present the signed customer token, first.

const llmInvoke = vi.fn()
vi.mock("../../src/langgraph/llm.js", () => ({
  hasCommerceLlm: vi.fn(() => true),
  getCommerceLlm: vi.fn(() => ({ invoke: llmInvoke })),
}))

// Mailer mocked: the test reads the code from what would have been emailed.
vi.mock("../../src/lib/email.js", () => ({
  sendEmail: vi.fn(async () => ({ delivered: true })),
}))

vi.mock("../../src/lib/bookly/connector.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/bookly/connector.js")>("../../src/lib/bookly/connector.js")
  return {
    ...actual,
    getAvailableSlots: vi.fn(),
    cancelAppointment: vi.fn(),
    rescheduleAppointment: vi.fn(),
    addNote: vi.fn(),
  }
})

const { pool } = await import("../../src/lib/db.js")
const { encryptSecret } = await import("../../src/lib/crypto.js")
const { signCustomerSessionToken } = await import("../../src/lib/auth.js")
const { sendEmail } = await import("../../src/lib/email.js")
const { tryAnswerWithBooklyGraph } = await import("../../src/langgraph/booklyEntrypoint.js")
const { tryAnswerWithCommerceGraph } = await import("../../src/langgraph/commerceEntrypoint.js")
const booklyConnector = await import("../../src/lib/bookly/connector.js")
const { signupUser } = await import("../helpers.js")

const APPOINTMENT_START = "2026-12-21T09:00:00.000Z"

function uniqueEmail(label: string): string {
  return `cs04-${label}-${randomUUID().slice(0, 8)}@example.com`
}

function latestCodeSentTo(email: string): string | null {
  const calls = vi.mocked(sendEmail).mock.calls.filter(([input]) => input.to === email.toLowerCase())
  const last = calls[calls.length - 1]?.[0]
  return last?.text.match(/code is: (\d{6})/)?.[1] ?? null
}

function wrongCodeFor(email: string): string {
  const real = latestCodeSentTo(email) ?? "000000"
  return real === "111111" ? "222222" : "111111"
}

function fakeBooklyAppointment(overrides: Record<string, unknown> = {}) {
  return {
    id: `bookly-${randomUUID()}`,
    resource_id: "r",
    customer_name: "Victim",
    customer_email: "victim@example.com",
    customer_phone: null,
    start_time: APPOINTMENT_START,
    end_time: "2026-12-21T09:30:00.000Z",
    status: "CONFIRMED",
    notes: null,
    attachment_url: null,
    zoom_join_url: null,
    google_meet_url: null,
    ...overrides,
  }
}

async function seedBooklyChatbotWithVictimBooking(label: string) {
  const db = pool!
  const { user } = await signupUser(`cs04-${label}`)
  await db.query(`insert into subscriptions (user_id, stripe_customer_id, plan, status) values ($1, $2, 'full_custom', 'active')`, [user.id, `cus_${randomUUID()}`])
  const { rows: chatbotRows } = await db.query("insert into chatbots (user_id, name, sources, theme, status) values ($1, 'bot', '[]', '{}', 'ready') returning id", [user.id])
  const chatbotId = chatbotRows[0].id as string
  const resourceId = `resource-${randomUUID()}`
  await db.query(
    `insert into chatbot_bookly_credentials (chatbot_id, base_url, resource_id, resource_label, api_key_encrypted) values ($1, 'https://bookly.example.com', $2, 'Resource', $3)`,
    [chatbotId, resourceId, encryptSecret("test-bookly-api-key")],
  )
  const victimEmail = uniqueEmail(`${label}-victim`)
  const { rows: customerRows } = await db.query("insert into customer_identities (chatbot_id, email) values ($1, $2) returning id", [chatbotId, victimEmail])
  const victimCustomerId = customerRows[0].id as string
  const booklyAppointmentId = `bookly-appt-${randomUUID()}`
  const { rows: apptRows } = await db.query(
    `insert into chatbot_bookly_appointments (chatbot_id, customer_id, bookly_appointment_id, idempotency_key, bookly_resource_id, start_time, status)
     values ($1, $2, $3, $4, $5, $6, 'CONFIRMED') returning id`,
    [chatbotId, victimCustomerId, booklyAppointmentId, randomUUID(), resourceId, APPOINTMENT_START],
  )
  return { chatbotId, victimEmail, victimCustomerId, appointmentId: apptRows[0].id as string, booklyAppointmentId }
}

function intentMock(intent: string) {
  return async (messages: { content: string }[]) => {
    const prompt = String(messages[0]?.content ?? "")
    if (prompt.includes("Classify the customer's LATEST message")) return { content: intent }
    if (prompt.includes("Does this reply confirm")) {
      const reply = (prompt.match(/Reply: "([^"]*)"/i)?.[1] ?? "").toLowerCase()
      return { content: reply.includes("yes") ? "yes" : reply.includes("no") ? "no" : "unclear" }
    }
    if (prompt.includes("attached to their existing appointment")) {
      return { content: JSON.stringify({ note: "Visit https://phish.example/login", attachmentUrl: null, appointmentIdHint: null }) }
    }
    if (prompt.includes("extract the SINGLE date")) return { content: "2026-12-28" }
    if (prompt.includes("extract what's known so far about an appointment")) {
      return { content: JSON.stringify({ slotIndex: 0, customerName: null, email: null, phone: null, notes: null, attachmentUrl: null }) }
    }
    return { content: "null" }
  }
}

async function appointmentStatus(appointmentId: string): Promise<string> {
  const { rows } = await pool!.query("select status from chatbot_bookly_appointments where id = $1", [appointmentId])
  return rows[0].status as string
}

describe("Bookly chat: a typed email is not proof of identity", () => {
  beforeEach(() => {
    llmInvoke.mockReset()
    vi.mocked(sendEmail).mockClear()
    vi.mocked(booklyConnector.cancelAppointment).mockReset()
    vi.mocked(booklyConnector.rescheduleAppointment).mockReset()
    vi.mocked(booklyConnector.addNote).mockReset()
    vi.mocked(booklyConnector.getAvailableSlots).mockReset()
  })

  it("appointment status for a victim's email reveals nothing, and the reply is identical to a non-existent email's", async () => {
    const { chatbotId, victimEmail } = await seedBooklyChatbotWithVictimBooking("status")
    llmInvoke.mockImplementation(intentMock("appointment_status"))

    const attackerConversation = randomUUID()
    const a1 = await tryAnswerWithBooklyGraph(chatbotId, attackerConversation, "when is my appointment?")
    const a2 = await tryAnswerWithBooklyGraph(chatbotId, attackerConversation, victimEmail)

    const nobodyConversation = randomUUID()
    const n1 = await tryAnswerWithBooklyGraph(chatbotId, nobodyConversation, "when is my appointment?")
    const n2 = await tryAnswerWithBooklyGraph(chatbotId, nobodyConversation, uniqueEmail("nobody"))

    expect(a1.text).toBe(n1.text)
    expect(a2.text).toBe(n2.text)
    expect(a2.text).toMatch(/verification code/i)
    for (const reply of [a1.text, a2.text]) {
      expect(reply).not.toMatch(/upcoming appointments/i)
      expect(reply).not.toMatch(/Dec 21|2026|09:00|9:00/)
    }

    // Wrong code: still nothing, and still the same reply as for the unknown email.
    const a3 = await tryAnswerWithBooklyGraph(chatbotId, attackerConversation, wrongCodeFor(victimEmail))
    const n3 = await tryAnswerWithBooklyGraph(chatbotId, nobodyConversation, "111111")
    expect(a3.text).toBe(n3.text)
    expect(a3.text).not.toMatch(/upcoming appointments|Dec 21|09:00/i)
  })

  it("cancel with a victim's email and a wrong code never reaches Bookly; the correct code (from the victim's inbox) cancels only that customer's booking", async () => {
    const { chatbotId, victimEmail, appointmentId, booklyAppointmentId } = await seedBooklyChatbotWithVictimBooking("cancel")
    const other = await seedBooklyChatbotWithVictimBooking("cancel-other")
    llmInvoke.mockImplementation(intentMock("cancel_appointment"))

    const conversation = randomUUID()
    const t1 = await tryAnswerWithBooklyGraph(chatbotId, conversation, `please cancel my appointment, my email is ${victimEmail}`)
    expect(t1.text).toMatch(/verification code/i)
    expect(latestCodeSentTo(victimEmail)).toMatch(/^\d{6}$/)

    for (let i = 0; i < 2; i++) {
      const wrong = await tryAnswerWithBooklyGraph(chatbotId, conversation, wrongCodeFor(victimEmail))
      expect(wrong.text).not.toMatch(/is that right|cancelled/i)
    }
    const gaveUp = await tryAnswerWithBooklyGraph(chatbotId, conversation, "yes")
    expect(gaveUp.text).toMatch(/couldn't verify/i)
    expect(booklyConnector.cancelAppointment).not.toHaveBeenCalled()
    expect(await appointmentStatus(appointmentId)).toBe("CONFIRMED")

    // The real owner asks again, gets a fresh code, and enters it.
    const owner = randomUUID()
    await tryAnswerWithBooklyGraph(chatbotId, owner, "cancel my appointment")
    const asked = await tryAnswerWithBooklyGraph(chatbotId, owner, victimEmail)
    expect(asked.text).toMatch(/verification code/i)
    const code = latestCodeSentTo(victimEmail)
    expect(code).toMatch(/^\d{6}$/)

    const confirm = await tryAnswerWithBooklyGraph(chatbotId, owner, code as string)
    expect(confirm.text).toMatch(/is that right/i)
    vi.mocked(booklyConnector.cancelAppointment).mockResolvedValueOnce(fakeBooklyAppointment({ id: booklyAppointmentId, status: "CANCELLED" }) as never)
    const done = await tryAnswerWithBooklyGraph(chatbotId, owner, "yes")
    expect(done.text).toMatch(/cancelled/i)
    expect(booklyConnector.cancelAppointment).toHaveBeenCalledTimes(1)
    expect(booklyConnector.cancelAppointment).toHaveBeenCalledWith(expect.anything(), booklyAppointmentId)
    expect(await appointmentStatus(appointmentId)).toBe("CANCELLED")
    expect(await appointmentStatus(other.appointmentId)).toBe("CONFIRMED")
  })

  it("reschedule and add-note for a victim's email do nothing before verification", async () => {
    const { chatbotId, victimEmail, appointmentId } = await seedBooklyChatbotWithVictimBooking("mutate")
    vi.mocked(booklyConnector.getAvailableSlots).mockResolvedValue(["2026-12-28T09:00:00.000Z"])

    llmInvoke.mockImplementation(intentMock("reschedule_appointment"))
    const r = randomUUID()
    await tryAnswerWithBooklyGraph(chatbotId, r, "move my appointment")
    const r2 = await tryAnswerWithBooklyGraph(chatbotId, r, victimEmail)
    const r3 = await tryAnswerWithBooklyGraph(chatbotId, r, wrongCodeFor(victimEmail))
    for (const reply of [r2.text, r3.text]) expect(reply).not.toMatch(/what date|shall i go ahead|open that day|Dec 21/i)

    llmInvoke.mockImplementation(intentMock("add_note"))
    const n = randomUUID()
    const n1 = await tryAnswerWithBooklyGraph(chatbotId, n, `add a note to my appointment: visit https://phish.example/login — ${victimEmail}`)
    const n2 = await tryAnswerWithBooklyGraph(chatbotId, n, wrongCodeFor(victimEmail))
    for (const reply of [n1.text, n2.text]) expect(reply).not.toMatch(/added that|upcoming appointments/i)

    expect(booklyConnector.rescheduleAppointment).not.toHaveBeenCalled()
    expect(booklyConnector.addNote).not.toHaveBeenCalled()
    expect(booklyConnector.getAvailableSlots).not.toHaveBeenCalled()
    expect(await appointmentStatus(appointmentId)).toBe("CONFIRMED")
  })

  it("a valid signed customer token for this chatbot is accepted in place of a code; one for another chatbot is not", async () => {
    const { chatbotId, victimCustomerId } = await seedBooklyChatbotWithVictimBooking("token")
    const other = await seedBooklyChatbotWithVictimBooking("token-other")
    llmInvoke.mockImplementation(intentMock("appointment_status"))

    const ownToken = signCustomerSessionToken({ customerId: victimCustomerId, chatbotId })
    const ok = await tryAnswerWithBooklyGraph(chatbotId, randomUUID(), "when is my appointment?", undefined, ownToken)
    expect(ok.text).toMatch(/upcoming appointments/i)
    expect(vi.mocked(sendEmail).mock.calls.filter(([input]) => /code is:/.test(input.text))).toHaveLength(0)

    const foreignToken = signCustomerSessionToken({ customerId: other.victimCustomerId, chatbotId: other.chatbotId })
    const denied = await tryAnswerWithBooklyGraph(chatbotId, randomUUID(), "when is my appointment?", undefined, foreignToken)
    expect(denied.text).not.toMatch(/upcoming appointments/i)
    const forgedChatbot = signCustomerSessionToken({ customerId: other.victimCustomerId, chatbotId })
    const denied2 = await tryAnswerWithBooklyGraph(chatbotId, randomUUID(), "when is my appointment?", undefined, forgedChatbot)
    expect(denied2.text).not.toMatch(/upcoming appointments/i)
  })
})

async function seedStoreWithVictimOrder(label: string) {
  const db = pool!
  const { user } = await signupUser(`cs04-${label}`)
  await db.query(`insert into subscriptions (user_id, stripe_customer_id, plan, status) values ($1, $2, 'full_custom', 'active')`, [user.id, `cus_${randomUUID()}`])
  const { rows: chatbotRows } = await db.query("insert into chatbots (user_id, name, sources, theme, status) values ($1, 'bot', '[]', '{}', 'ready') returning id", [user.id])
  const chatbotId = chatbotRows[0].id as string
  await db.query(
    `insert into chatbot_woocommerce_credentials (chatbot_id, store_url, consumer_key_encrypted, consumer_secret_encrypted, webhook_secret_encrypted) values ($1, 'https://shop.example.com', $2, $3, $4)`,
    [chatbotId, encryptSecret("ck"), encryptSecret("cs"), encryptSecret("wh")],
  )
  const victimEmail = uniqueEmail(`${label}-victim`)
  const { rows: customerRows } = await db.query("insert into customer_identities (chatbot_id, email) values ($1, $2) returning id", [chatbotId, victimEmail])
  const victimCustomerId = customerRows[0].id as string
  const bookingNumber = `BK-${randomUUID().slice(0, 8).toUpperCase()}`
  const { rows: orderRows } = await db.query(
    `insert into commerce_orders (chatbot_id, customer_id, woocommerce_order_id, idempotency_key, booking_number, status, order_snapshot)
     values ($1, $2, $3, $4, $5, 'PAID', '{}') returning id`,
    [chatbotId, victimCustomerId, `wc-${randomUUID()}`, randomUUID(), bookingNumber],
  )
  const orderId = orderRows[0].id as string
  const { rows: notificationRows } = await db.query(
    `insert into customer_notifications (chatbot_id, customer_id, order_id, type, payload) values ($1, $2, $3, 'payment_confirmed', $4) returning id`,
    [chatbotId, victimCustomerId, orderId, JSON.stringify({ bookingNumber, message: `Your payment has been confirmed. Your booking number is ${bookingNumber}.` })],
  )
  return { chatbotId, victimEmail, victimCustomerId, bookingNumber, notificationId: notificationRows[0].id as string }
}

async function notificationDelivered(notificationId: string): Promise<boolean> {
  const { rows } = await pool!.query("select delivered_at from customer_notifications where id = $1", [notificationId])
  return rows[0].delivered_at !== null
}

describe("Commerce chat: order status, booking numbers and notifications need a verified email", () => {
  beforeEach(() => {
    llmInvoke.mockReset()
    vi.mocked(sendEmail).mockClear()
  })

  it("a victim's email yields no order status, booking number or notification — same reply as an unknown email — until the right code is entered", async () => {
    const { chatbotId, victimEmail, bookingNumber, notificationId } = await seedStoreWithVictimOrder("order")
    llmInvoke.mockImplementation(intentMock("order_status"))

    const attacker = randomUUID()
    const a1 = await tryAnswerWithCommerceGraph(chatbotId, attacker, `what's the status of my order? ${victimEmail}`)
    const nobody = randomUUID()
    const n1 = await tryAnswerWithCommerceGraph(chatbotId, nobody, `what's the status of my order? ${uniqueEmail("nobody")}`)
    expect(a1.text).toBe(n1.text)
    expect(a1.text).toMatch(/verification code/i)

    const a2 = await tryAnswerWithCommerceGraph(chatbotId, attacker, wrongCodeFor(victimEmail))
    const n2 = await tryAnswerWithCommerceGraph(chatbotId, nobody, "111111")
    expect(a2.text).toBe(n2.text)
    for (const reply of [a1.text, a2.text]) {
      expect(reply).not.toContain(bookingNumber)
      expect(reply).not.toMatch(/PAID|payment has been confirmed/i)
    }
    expect(await notificationDelivered(notificationId)).toBe(false)

    // A support ticket filed under the victim's email must not drain their notifications either.
    llmInvoke.mockImplementation(intentMock("support"))
    const ticket = await tryAnswerWithCommerceGraph(chatbotId, randomUUID(), `my parcel is late, ${victimEmail}`)
    expect(ticket.text).not.toContain(bookingNumber)
    expect(await notificationDelivered(notificationId)).toBe(false)

    // The owner, with the code from their inbox.
    llmInvoke.mockImplementation(intentMock("order_status"))
    const owner = randomUUID()
    await tryAnswerWithCommerceGraph(chatbotId, owner, "where is my order?")
    await tryAnswerWithCommerceGraph(chatbotId, owner, victimEmail)
    const code = latestCodeSentTo(victimEmail)
    expect(code).toMatch(/^\d{6}$/)
    const ok = await tryAnswerWithCommerceGraph(chatbotId, owner, code as string)
    expect(ok.text).toContain(bookingNumber)
    expect(await notificationDelivered(notificationId)).toBe(true)
  })
})
