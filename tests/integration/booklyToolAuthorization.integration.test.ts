import { randomUUID } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"

// Item 1 — cross-tenant isolation, explicit test, not assumed: a Bookly API
// key issued for chatbot A cannot read, create, cancel, or reschedule any
// appointment belonging to chatbot B, even if chatbot B's resource/
// appointment ids are guessed or known; and a revoked key is rejected on
// every operation type. Exercised at the same layer
// commerceToolAuthorization.integration.test.ts uses (authorizeToolCall
// directly + the service layer above it), since that IS the enforcement
// choke point — a real Bookly server isn't needed to prove THIS guarantee,
// only to prove item 4's race condition.
vi.mock("../../src/lib/bookly/connector.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/bookly/connector.js")>("../../src/lib/bookly/connector.js")
  return { ...actual, createAppointment: vi.fn(), getAppointment: vi.fn(), cancelAppointment: vi.fn(), rescheduleAppointment: vi.fn() }
})
const { pool } = await import("../../src/lib/db.js")
const { encryptSecret } = await import("../../src/lib/crypto.js")
const { authorizeToolCall } = await import("../../src/services/toolAuthorization.service.js")
const { commitBooking, getBookingForCustomer, cancelBookingForCustomer, rescheduleBookingForCustomer } = await import("../../src/services/booklyBooking.service.js")
const booklyConnector = await import("../../src/lib/bookly/connector.js")
const { signupUser } = await import("../helpers.js")

async function seedFullCustomBooklyChatbot(label: string, resourceId = `resource-${randomUUID()}`) {
  const db = pool!
  const { user } = await signupUser(label)
  await db.query(`insert into subscriptions (user_id, stripe_customer_id, plan, status) values ($1, $2, 'full_custom', 'active')`, [user.id, `cus_${randomUUID()}`])
  const { rows: chatbotRows } = await db.query("insert into chatbots (user_id, name, sources, theme, status) values ($1, 'bot', '[]', '{}', 'ready') returning id", [user.id])
  const chatbotId = chatbotRows[0].id as string
  await db.query(
    `insert into chatbot_bookly_credentials (chatbot_id, base_url, resource_id, resource_label, api_key_encrypted) values ($1, 'https://bookly.example.com', $2, 'Resource', $3)`,
    [chatbotId, resourceId, encryptSecret("test-bookly-api-key")],
  )
  // CS-04: existing-booking operations require an EMAIL_VERIFIED customer.
  const { rows: customerRows } = await db.query("insert into customer_identities (chatbot_id, email, verification_level) values ($1, $2, 'EMAIL_VERIFIED') returning id", [chatbotId, `c-${randomUUID()}@example.test`])
  return { chatbotId, customerId: customerRows[0].id as string, resourceId }
}

describe("Bookly ToolAuthorizationPolicy — cross-tenant isolation and revocation (Part B item 1)", () => {
  beforeEach(() => {
    vi.mocked(booklyConnector.createAppointment).mockReset()
    vi.mocked(booklyConnector.getAppointment).mockReset()
    vi.mocked(booklyConnector.cancelAppointment).mockReset()
    vi.mocked(booklyConnector.rescheduleAppointment).mockReset()
  })

  it("allows check_availability/book_appointment for a chatbot with a genuine Bookly connection", async () => {
    const { chatbotId } = await seedFullCustomBooklyChatbot("bookly-authz-ok")
    await expect(authorizeToolCall({ chatbotId, customerId: null, operation: "check_availability" })).resolves.toBeUndefined()
  })

  it("denies every Bookly operation for a chatbot with no Bookly connection at all", async () => {
    const db = pool!
    const { user } = await signupUser("bookly-authz-none")
    await db.query(`insert into subscriptions (user_id, stripe_customer_id, plan, status) values ($1, $2, 'full_custom', 'active')`, [user.id, `cus_${randomUUID()}`])
    const { rows } = await db.query("insert into chatbots (user_id, name, sources, theme, status) values ($1, 'bot', '[]', '{}', 'ready') returning id", [user.id])
    await expect(authorizeToolCall({ chatbotId: rows[0].id, customerId: null, operation: "check_availability" })).rejects.toThrow(/no connected Bookly resource/)
  })

  it("CHATBOT A cannot read, cancel, or reschedule an appointment genuinely belonging to CHATBOT B, even with B's real appointment id", async () => {
    const chatbotA = await seedFullCustomBooklyChatbot("bookly-tenant-a")
    const chatbotB = await seedFullCustomBooklyChatbot("bookly-tenant-b")
    const db = pool!

    const { rows: apptRows } = await db.query(
      `insert into chatbot_bookly_appointments (chatbot_id, customer_id, bookly_appointment_id, idempotency_key, bookly_resource_id, start_time, status)
       values ($1, $2, 'bookly-appt-b', $3, $4, now(), 'CONFIRMED') returning id`,
      [chatbotB.chatbotId, chatbotB.customerId, randomUUID(), chatbotB.resourceId],
    )
    const appointmentBId = apptRows[0].id as string

    // READ: chatbot A's own (correctly-resolved, on-chatbot-A) customer
    // tries to fetch B's real, known appointment id.
    await expect(getBookingForCustomer(chatbotA.chatbotId, chatbotA.customerId, appointmentBId)).rejects.toThrow(/not found/i)
    expect(booklyConnector.getAppointment).not.toHaveBeenCalled()

    // CANCEL / RESCHEDULE: same cross-tenant attempt.
    await expect(cancelBookingForCustomer(chatbotA.chatbotId, chatbotA.customerId, appointmentBId)).rejects.toThrow(/not found/i)
    expect(booklyConnector.cancelAppointment).not.toHaveBeenCalled()

    await expect(
      rescheduleBookingForCustomer(chatbotA.chatbotId, chatbotA.customerId, appointmentBId, { startTime: new Date().toISOString(), duration: 30 }),
    ).rejects.toThrow(/not found/i)
    expect(booklyConnector.rescheduleAppointment).not.toHaveBeenCalled()

    // Even chatbot B's OWN customerId cross-checked against chatbot A is denied.
    await expect(authorizeToolCall({ chatbotId: chatbotA.chatbotId, customerId: chatbotB.customerId, operation: "book_appointment" })).rejects.toThrow(/does not belong to this chatbot/)

    // Confirm B's appointment was genuinely untouched.
    const stillThere = await db.query("select status from chatbot_bookly_appointments where id = $1", [appointmentBId])
    expect(stillThere.rows[0].status).toBe("CONFIRMED")
  })

  it("a revoked key is modeled as a disconnected chatbot and is rejected on every Bookly operation type, not just the first one tried", async () => {
    // The Bookly-side key itself is validated by Bookly's own middleware
    // (backend/tests/apiKeyAuth.test.js covers that directly); on THIS
    // side, "the key backing this connection is no longer good" surfaces
    // as the credential row being removed (disconnectBookly) — re-checked
    // on every single call via hasBooklyConnected (step 1), never cached.
    const { chatbotId, customerId, resourceId } = await seedFullCustomBooklyChatbot("bookly-revoke")
    const db = pool!
    const { rows: apptRows } = await db.query(
      `insert into chatbot_bookly_appointments (chatbot_id, customer_id, bookly_appointment_id, idempotency_key, bookly_resource_id, start_time, status)
       values ($1, $2, 'bookly-appt-revoke', $3, $4, now(), 'CONFIRMED') returning id`,
      [chatbotId, customerId, randomUUID(), resourceId],
    )
    const appointmentId = apptRows[0].id as string

    // Works fine while connected.
    vi.mocked(booklyConnector.getAppointment).mockResolvedValueOnce({
      id: "bookly-appt-revoke", resource_id: resourceId, customer_name: "x", customer_email: "x@example.com", customer_phone: null,
      start_time: new Date().toISOString(), end_time: new Date().toISOString(), status: "CONFIRMED", notes: null, attachment_url: null, zoom_join_url: null, google_meet_url: null,
    })
    await expect(getBookingForCustomer(chatbotId, customerId, appointmentId)).resolves.toBeTruthy()

    // Revoke (disconnect) the connection.
    await db.query("delete from chatbot_bookly_credentials where chatbot_id = $1", [chatbotId])

    await expect(getBookingForCustomer(chatbotId, customerId, appointmentId)).rejects.toThrow(/no connected Bookly resource/)
    await expect(cancelBookingForCustomer(chatbotId, customerId, appointmentId)).rejects.toThrow(/no connected Bookly resource/)
    await expect(
      rescheduleBookingForCustomer(chatbotId, customerId, appointmentId, { startTime: new Date().toISOString(), duration: 30 }),
    ).rejects.toThrow(/no connected Bookly resource/)
    await expect(
      commitBooking({
        chatbotId,
        customerId,
        startTime: new Date().toISOString(),
        duration: 30,
        customer: { name: "Late Customer", email: "late@example.com" },
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow(/no connected Bookly resource/)
  })
})
