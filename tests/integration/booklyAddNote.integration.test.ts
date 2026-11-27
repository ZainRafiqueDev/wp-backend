import { randomUUID } from "node:crypto"
import { describe, expect, it, vi, beforeEach } from "vitest"

// The "add a note to this meeting" mid-conversation action (Part 6):
// resolution correctness (which booking gets the note - by explicit id, or
// by "my most recent appointment" when none is named) is graph/service
// logic, independent of whether Bookly itself actually persists the note -
// that persistence guarantee is proven separately, by Bookly's own
// appointmentNotes.test.js (real Postgres) and by a live manual
// curl-generated PDF confirmed to contain a real added note (see
// IMPLEMENTATION_STATUS.md). Mocking the connector here, same as
// booklyAuthorizationOrdering's own tests, isolates exactly the thing this
// file exists to prove: which appointment id the graph picks.
const llmInvoke = vi.fn()
vi.mock("../../src/langgraph/llm.js", () => ({
  hasCommerceLlm: vi.fn(() => true),
  getCommerceLlm: vi.fn(() => ({ invoke: llmInvoke })),
}))

vi.mock("../../src/lib/bookly/connector.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/bookly/connector.js")>("../../src/lib/bookly/connector.js")
  return { ...actual, addNote: vi.fn() }
})

const { pool } = await import("../../src/lib/db.js")
const { encryptSecret } = await import("../../src/lib/crypto.js")
const { tryAnswerWithBooklyGraph } = await import("../../src/langgraph/booklyEntrypoint.js")
const booklyConnector = await import("../../src/lib/bookly/connector.js")
const { promoteVerificationLevel, resolveCustomerIdentity } = await import("../../src/services/customerIdentity.service.js")
const { signupUser } = await import("../helpers.js")
const { signCustomerSessionToken } = await import("../../src/lib/auth.js")

// CS-04: add_note now needs a verified customer (OTP or the signed customer
// session token). This file is about WHICH appointment gets the note, so it
// presents the token; the OTP path and the unverified negative cases live in
// customerIdentityVerification.integration.test.ts.
async function customerTokenFor(chatbotId: string, email: string): Promise<string> {
  const customer = await resolveCustomerIdentity(chatbotId, email)
  // A real token is only issued after an OTP, which promotes the level.
  await promoteVerificationLevel(customer.id, "EMAIL_VERIFIED")
  return signCustomerSessionToken({ customerId: customer.id, chatbotId })
}

function llmContent(text: string) {
  return { content: text }
}

async function seedFullCustomBooklyChatbot(label: string) {
  const db = pool!
  const { user } = await signupUser(label)
  await db.query(`insert into subscriptions (user_id, stripe_customer_id, plan, status) values ($1, $2, 'full_custom', 'active')`, [user.id, `cus_${randomUUID()}`])
  const { rows: chatbotRows } = await db.query("insert into chatbots (user_id, name, sources, theme, status) values ($1, 'bot', '[]', '{}', 'ready') returning id", [user.id])
  const chatbotId = chatbotRows[0].id as string
  const resourceId = `resource-${randomUUID()}`
  await db.query(
    `insert into chatbot_bookly_credentials (chatbot_id, base_url, resource_id, resource_label, api_key_encrypted) values ($1, 'https://bookly.example.com', $2, 'Resource', $3)`,
    [chatbotId, resourceId, encryptSecret("test-bookly-api-key")],
  )
  return { chatbotId, resourceId }
}

async function seedUpcomingAppointment(chatbotId: string, resourceId: string, email: string, startTime: string, booklyAppointmentId: string) {
  const db = pool!
  const customer = await resolveCustomerIdentity(chatbotId, email)
  const customerId = customer.id
  const { rows: apptRows } = await db.query(
    `insert into chatbot_bookly_appointments (chatbot_id, customer_id, bookly_appointment_id, idempotency_key, bookly_resource_id, start_time, status)
     values ($1, $2, $3, $4, $5, $6, 'CONFIRMED') returning id`,
    [chatbotId, customerId, booklyAppointmentId, randomUUID(), resourceId, startTime],
  )
  return { customerId, localAppointmentId: apptRows[0].id as string }
}

function fakeBooklyAppointment(overrides: Partial<import("../../src/lib/bookly/types.js").BooklyAppointment> = {}): import("../../src/lib/bookly/types.js").BooklyAppointment {
  return {
    id: "bookly-appt-x", resource_id: "r", customer_name: "Ada", customer_email: "ada@example.com", customer_phone: null,
    start_time: new Date().toISOString(), end_time: new Date().toISOString(), status: "CONFIRMED", notes: null, attachment_url: null,
    zoom_join_url: null, google_meet_url: null, ...overrides,
  }
}

describe("Bookly add_note — resolution correctness (Part 6)", () => {
  beforeEach(() => {
    llmInvoke.mockReset()
    vi.mocked(booklyConnector.addNote).mockReset()
  })

  it("with exactly one upcoming appointment and no id named, the note lands on that one ('my most recent appointment' resolution)", async () => {
    const { chatbotId, resourceId } = await seedFullCustomBooklyChatbot("add-note-single")
    const { localAppointmentId } = await seedUpcomingAppointment(chatbotId, resourceId, "priya@example.com", new Date(Date.now() + 86_400_000).toISOString(), "bookly-appt-priya")

    llmInvoke.mockResolvedValueOnce(llmContent("add_note")) // classify_intent
    llmInvoke.mockResolvedValueOnce(
      llmContent(JSON.stringify({ note: "Bring the signed contract", attachmentUrl: null, appointmentIdHint: null })),
    ) // extractNoteFields
    vi.mocked(booklyConnector.addNote).mockResolvedValueOnce(fakeBooklyAppointment({ notes: "Bring the signed contract" }))

    const result = await tryAnswerWithBooklyGraph(
      chatbotId,
      null,
      "My email is priya@example.com. Please add a note to my appointment: bring the signed contract",
      undefined,
      await customerTokenFor(chatbotId, "priya@example.com"),
    )

    expect(result.handled).toBe(true)
    expect(result.text).toMatch(/added that to your appointment/i)
    expect(booklyConnector.addNote).toHaveBeenCalledTimes(1)
    // The SECOND argument to connector.addNote is Bookly's own appointment
    // id, not ChatMate360's local row id - confirm resolution reached the
    // right LOCAL row by checking the DB directly instead.
    const { rows } = await pool!.query("select bookly_appointment_id from chatbot_bookly_appointments where id = $1", [localAppointmentId])
    expect(vi.mocked(booklyConnector.addNote).mock.calls[0][1]).toBe(rows[0].bookly_appointment_id)
  })

  it("with two upcoming appointments and an explicit booking id named, the note lands on THAT one, not the soonest", async () => {
    const { chatbotId, resourceId } = await seedFullCustomBooklyChatbot("add-note-explicit-id")
    const email = "sam@example.com"
    const first = await seedUpcomingAppointment(chatbotId, resourceId, email, new Date(Date.now() + 86_400_000).toISOString(), "bookly-appt-first")
    const second = await seedUpcomingAppointment(chatbotId, resourceId, email, new Date(Date.now() + 2 * 86_400_000).toISOString(), "bookly-appt-second")

    llmInvoke.mockResolvedValueOnce(llmContent("add_note")) // classify_intent
    llmInvoke.mockResolvedValueOnce(
      llmContent(JSON.stringify({ note: "Parking validated at front desk", attachmentUrl: null, appointmentIdHint: second.localAppointmentId })),
    ) // extractNoteFields - explicitly names the SECOND (later) appointment
    vi.mocked(booklyConnector.addNote).mockResolvedValueOnce(fakeBooklyAppointment({ notes: "Parking validated at front desk" }))

    const result = await tryAnswerWithBooklyGraph(
      chatbotId,
      null,
      `My email is ${email}. Add a note to appointment ${second.localAppointmentId}: parking validated at front desk`,
      undefined,
      await customerTokenFor(chatbotId, email),
    )

    expect(result.handled).toBe(true)
    const { rows: secondRow } = await pool!.query("select bookly_appointment_id from chatbot_bookly_appointments where id = $1", [second.localAppointmentId])
    expect(vi.mocked(booklyConnector.addNote).mock.calls[0][1]).toBe(secondRow[0].bookly_appointment_id)
    // Confirm it did NOT default to the soonest (first) appointment instead.
    const { rows: firstRow } = await pool!.query("select bookly_appointment_id from chatbot_bookly_appointments where id = $1", [first.localAppointmentId])
    expect(vi.mocked(booklyConnector.addNote).mock.calls[0][1]).not.toBe(firstRow[0].bookly_appointment_id)
  })

  it("with no upcoming appointments under that email, responds clearly and never calls Bookly", async () => {
    const { chatbotId } = await seedFullCustomBooklyChatbot("add-note-none")

    llmInvoke.mockResolvedValueOnce(llmContent("add_note")) // classify_intent
    llmInvoke.mockResolvedValueOnce(llmContent(JSON.stringify({ note: "hello", attachmentUrl: null, appointmentIdHint: null }))) // extractNoteFields

    const result = await tryAnswerWithBooklyGraph(
      chatbotId,
      null,
      "My email is nobody@example.com. Add a note: hello",
      undefined,
      await customerTokenFor(chatbotId, "nobody@example.com"),
    )

    expect(result.handled).toBe(true)
    expect(result.text).toMatch(/don't see any upcoming appointments/i)
    expect(booklyConnector.addNote).not.toHaveBeenCalled()
  })

  it("a note attempt for another chatbot's appointment id is rejected (cross-tenant isolation), never reaching Bookly", async () => {
    const chatbotA = await seedFullCustomBooklyChatbot("add-note-tenant-a")
    const chatbotB = await seedFullCustomBooklyChatbot("add-note-tenant-b")
    const email = "cross@example.com"
    await seedUpcomingAppointment(chatbotA.chatbotId, chatbotA.resourceId, email, new Date(Date.now() + 86_400_000).toISOString(), "bookly-appt-a")
    const foreign = await seedUpcomingAppointment(chatbotB.chatbotId, chatbotB.resourceId, email, new Date(Date.now() + 86_400_000).toISOString(), "bookly-appt-b")

    llmInvoke.mockResolvedValueOnce(llmContent("add_note")) // classify_intent
    llmInvoke.mockResolvedValueOnce(
      llmContent(JSON.stringify({ note: "sneaky", attachmentUrl: null, appointmentIdHint: foreign.localAppointmentId })),
    ) // names chatbot B's real appointment id while talking to chatbot A

    const result = await tryAnswerWithBooklyGraph(
      chatbotA.chatbotId,
      null,
      `My email is ${email}. Add a note to ${foreign.localAppointmentId}: sneaky`,
      undefined,
      await customerTokenFor(chatbotA.chatbotId, email),
    )

    expect(result.handled).toBe(true)
    // authorizeToolCall's bookly_appointment ownership check throws
    // AppError(404) - addNoteNode catches it and surfaces a clean message,
    // never an unhandled exception.
    expect(result.text).not.toMatch(/added that to your appointment/i)
    expect(booklyConnector.addNote).not.toHaveBeenCalled()
  })
})
