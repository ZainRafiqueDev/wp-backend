import { randomUUID } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"

// Item 3 — explicit authorization ordering: possessing a valid, correctly-
// scoped Bookly API key must never be treated as sufficient authorization
// on its own. Step order (enforced in code, not just documented):
//   1. Plan entitlement (Full Custom, Bookly configured)
//   2. ToolAuthorizationPolicy (tenant, resolved customer, operation, resource)
//   3. ONLY THEN the authenticated request to Bookly using the decrypted key
// This test spies on the Bookly connector to prove step 3 is never reached
// when step 1 or 2 fails — booklyBooking.service.ts calls
// authorizeToolCall() before it ever calls getDecryptedBooklyCredentials or
// the connector (see its own doc comment).
vi.mock("../../src/lib/bookly/connector.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/bookly/connector.js")>("../../src/lib/bookly/connector.js")
  return { ...actual, createAppointment: vi.fn(), getAppointment: vi.fn(), cancelAppointment: vi.fn(), rescheduleAppointment: vi.fn(), addNote: vi.fn() }
})

const { pool } = await import("../../src/lib/db.js")
const { encryptSecret } = await import("../../src/lib/crypto.js")
const { commitBooking, getBookingForCustomer, cancelBookingForCustomer, rescheduleBookingForCustomer, addNoteToBooking } = await import("../../src/services/booklyBooking.service.js")
const booklyConnector = await import("../../src/lib/bookly/connector.js")
const { signupUser } = await import("../helpers.js")

async function seedChatbot(label: string, opts: { plan?: string; connectBookly?: boolean } = {}) {
  const db = pool!
  const { user } = await signupUser(label)
  await db.query(`insert into subscriptions (user_id, stripe_customer_id, plan, status) values ($1, $2, $3, 'active')`, [user.id, `cus_${randomUUID()}`, opts.plan ?? "full_custom"])
  const { rows: chatbotRows } = await db.query("insert into chatbots (user_id, name, sources, theme, status) values ($1, 'bot', '[]', '{}', 'ready') returning id", [user.id])
  const chatbotId = chatbotRows[0].id as string
  const resourceId = `resource-${randomUUID()}`
  if (opts.connectBookly !== false) {
    await db.query(
      `insert into chatbot_bookly_credentials (chatbot_id, base_url, resource_id, resource_label, api_key_encrypted) values ($1, 'https://bookly.example.com', $2, 'Resource', $3)`,
      [chatbotId, resourceId, encryptSecret("test-bookly-api-key")],
    )
  }
  // CS-04: existing-booking operations require an EMAIL_VERIFIED customer.
  const { rows: customerRows } = await db.query("insert into customer_identities (chatbot_id, email, verification_level) values ($1, $2, 'EMAIL_VERIFIED') returning id", [chatbotId, `c-${randomUUID()}@example.test`])
  return { chatbotId, customerId: customerRows[0].id as string, resourceId }
}

describe("Bookly authorization ordering — credentials are not authorization (Part B item 3)", () => {
  beforeEach(() => {
    vi.mocked(booklyConnector.createAppointment).mockReset()
    vi.mocked(booklyConnector.getAppointment).mockReset()
    vi.mocked(booklyConnector.cancelAppointment).mockReset()
    vi.mocked(booklyConnector.rescheduleAppointment).mockReset()
    vi.mocked(booklyConnector.addNote).mockReset()
  })

  it("commitBooking never calls Bookly when step 1 (plan entitlement) fails, even though a valid Bookly credential row exists", async () => {
    const { chatbotId, customerId } = await seedChatbot("authz-order-plan", { plan: "crawl_plus" })

    await expect(
      commitBooking({
        chatbotId,
        customerId,
        startTime: new Date().toISOString(),
        duration: 30,
        customer: { name: "Ada", email: "ada@example.com" },
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow(/Full Custom/)
    expect(booklyConnector.createAppointment).not.toHaveBeenCalled()
  })

  it("commitBooking never calls Bookly when step 1 (no Bookly connection at all) fails", async () => {
    const { chatbotId, customerId } = await seedChatbot("authz-order-noconn", { connectBookly: false })

    await expect(
      commitBooking({
        chatbotId,
        customerId,
        startTime: new Date().toISOString(),
        duration: 30,
        customer: { name: "Ada", email: "ada@example.com" },
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow(/no connected Bookly resource/)
    expect(booklyConnector.createAppointment).not.toHaveBeenCalled()
  })

  it("commitBooking never calls Bookly when step 2 (cross-tenant customer) fails, even with a fully valid Bookly connection", async () => {
    const chatbotA = await seedChatbot("authz-order-tenant-a")
    const chatbotB = await seedChatbot("authz-order-tenant-b")

    await expect(
      commitBooking({
        chatbotId: chatbotA.chatbotId,
        customerId: chatbotB.customerId, // a real customer id, just not chatbot A's
        startTime: new Date().toISOString(),
        duration: 30,
        customer: { name: "Ada", email: "ada@example.com" },
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow(/does not belong to this chatbot/)
    expect(booklyConnector.createAppointment).not.toHaveBeenCalled()
  })

  it("get/cancel/reschedule never call Bookly when step 2 (resource ownership) fails, even with a fully valid Bookly connection", async () => {
    const chatbotA = await seedChatbot("authz-order-resource-a")
    const chatbotB = await seedChatbot("authz-order-resource-b")
    const db = pool!
    const { rows: apptRows } = await db.query(
      `insert into chatbot_bookly_appointments (chatbot_id, customer_id, bookly_appointment_id, idempotency_key, bookly_resource_id, start_time, status)
       values ($1, $2, 'bookly-appt-order-b', $3, $4, now(), 'CONFIRMED') returning id`,
      [chatbotB.chatbotId, chatbotB.customerId, randomUUID(), chatbotB.resourceId],
    )
    const appointmentBId = apptRows[0].id as string

    await expect(getBookingForCustomer(chatbotA.chatbotId, chatbotA.customerId, appointmentBId)).rejects.toThrow(/not found/i)
    await expect(cancelBookingForCustomer(chatbotA.chatbotId, chatbotA.customerId, appointmentBId)).rejects.toThrow(/not found/i)
    await expect(
      rescheduleBookingForCustomer(chatbotA.chatbotId, chatbotA.customerId, appointmentBId, { startTime: new Date().toISOString(), duration: 30 }),
    ).rejects.toThrow(/not found/i)

    await expect(addNoteToBooking(chatbotA.chatbotId, chatbotA.customerId, appointmentBId, { note: "should never reach Bookly" })).rejects.toThrow(/not found/i)

    expect(booklyConnector.getAppointment).not.toHaveBeenCalled()
    expect(booklyConnector.cancelAppointment).not.toHaveBeenCalled()
    expect(booklyConnector.rescheduleAppointment).not.toHaveBeenCalled()
    expect(booklyConnector.addNote).not.toHaveBeenCalled()
  })

  it("addNoteToBooking rejects an empty call (neither note nor attachment) before authorization or Bookly are ever reached", async () => {
    const { chatbotId, customerId } = await seedChatbot("authz-order-note-empty")
    const db = pool!
    const { rows: apptRows } = await db.query(
      `insert into chatbot_bookly_appointments (chatbot_id, customer_id, bookly_appointment_id, idempotency_key, bookly_resource_id, start_time, status)
       values ($1, $2, 'bookly-appt-note-empty', $3, 'resource', now(), 'CONFIRMED') returning id`,
      [chatbotId, customerId, randomUUID()],
    )
    await expect(addNoteToBooking(chatbotId, customerId, apptRows[0].id as string, {})).rejects.toThrow(/provide a note/i)
    expect(booklyConnector.addNote).not.toHaveBeenCalled()
  })

  it("sanity check: a request that clears BOTH steps 1 and 2 does reach step 3 (the real Bookly call)", async () => {
    vi.mocked(booklyConnector.createAppointment).mockResolvedValueOnce({
      id: "bookly-appt-happy", resource_id: "r", customer_name: "Ada", customer_email: "ada@example.com", customer_phone: null,
      start_time: new Date().toISOString(), end_time: new Date().toISOString(), status: "CONFIRMED", notes: null, attachment_url: null, zoom_join_url: null, google_meet_url: null,
    })
    const { chatbotId, customerId } = await seedChatbot("authz-order-happy")

    const result = await commitBooking({
      chatbotId,
      customerId,
      startTime: new Date().toISOString(),
      duration: 30,
      customer: { name: "Ada", email: "ada@example.com" },
      idempotencyKey: randomUUID(),
    })
    expect(result.status).toBe("CONFIRMED")
    expect(booklyConnector.createAppointment).toHaveBeenCalledTimes(1)
  })

  it("sanity check: addNoteToBooking does reach Bookly once authorization and resource ownership both clear", async () => {
    vi.mocked(booklyConnector.addNote).mockResolvedValueOnce({
      id: "bookly-appt-note-happy", resource_id: "r", customer_name: "Ada", customer_email: "ada@example.com", customer_phone: null,
      start_time: new Date().toISOString(), end_time: new Date().toISOString(), status: "CONFIRMED", notes: "a real note", attachment_url: null, zoom_join_url: null, google_meet_url: null,
    })
    const { chatbotId, customerId, resourceId } = await seedChatbot("authz-order-note-happy")
    const db = pool!
    const { rows: apptRows } = await db.query(
      `insert into chatbot_bookly_appointments (chatbot_id, customer_id, bookly_appointment_id, idempotency_key, bookly_resource_id, start_time, status)
       values ($1, $2, 'bookly-appt-note-happy', $3, $4, now(), 'CONFIRMED') returning id`,
      [chatbotId, customerId, randomUUID(), resourceId],
    )

    const result = await addNoteToBooking(chatbotId, customerId, apptRows[0].id as string, { note: "a real note" })
    expect(result.notes).toBe("a real note")
    expect(booklyConnector.addNote).toHaveBeenCalledTimes(1)
  })
})
