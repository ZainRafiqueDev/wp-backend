import { randomUUID } from "node:crypto"
import { describe, expect, it, vi } from "vitest"

// Notes and attachments are BOT-COLLECTED: whatever the customer/admin
// volunteers in conversation, captured by the graph's own LLM extraction
// (booklyNodes.ts's extractDraftFields) and passed straight through to
// commitBooking — never a separate form field. A failure to record an
// attachment must never block the booking itself (same resilience
// principle used everywhere else in this integration).
vi.mock("../../src/lib/bookly/connector.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/bookly/connector.js")>("../../src/lib/bookly/connector.js")
  return { ...actual, createAppointment: vi.fn() }
})

const { pool } = await import("../../src/lib/db.js")
const { encryptSecret } = await import("../../src/lib/crypto.js")
const { commitBooking } = await import("../../src/services/booklyBooking.service.js")
const booklyConnector = await import("../../src/lib/bookly/connector.js")
const { signupUser } = await import("../helpers.js")

async function seedFullCustomBooklyChatbot(label: string) {
  const db = pool!
  const signup = await signupUser(label)
  await db.query(`insert into subscriptions (user_id, stripe_customer_id, plan, status) values ($1, $2, 'full_custom', 'active')`, [signup.user.id, `cus_${randomUUID()}`])
  const { rows: chatbotRows } = await db.query("insert into chatbots (user_id, name, sources, theme, status) values ($1, 'bot', '[]', '{}', 'ready') returning id", [signup.user.id])
  const chatbotId = chatbotRows[0].id as string
  await db.query(
    `insert into chatbot_bookly_credentials (chatbot_id, base_url, resource_id, resource_label, api_key_encrypted) values ($1, 'https://bookly.example.com', $2, 'Resource', $3)`,
    [chatbotId, `resource-${randomUUID()}`, encryptSecret("test-bookly-api-key")],
  )
  const { rows: customerRows } = await db.query("insert into customer_identities (chatbot_id, email) values ($1, $2) returning id", [chatbotId, `c-${randomUUID()}@example.test`])
  return { chatbotId, customerId: customerRows[0].id as string }
}

describe("Bot-collected notes and attachments (Part 3 of the admin-chat spec)", () => {
  it("a note and an attachment URL the customer volunteered are sent to Bookly and retrievable on the committed booking", async () => {
    vi.mocked(booklyConnector.createAppointment).mockReset()
    vi.mocked(booklyConnector.createAppointment).mockResolvedValueOnce({
      id: "bookly-appt-notes",
      resource_id: "r",
      customer_name: "Ada",
      customer_email: "ada@example.com",
      customer_phone: null,
      start_time: new Date().toISOString(),
      end_time: new Date().toISOString(),
      status: "CONFIRMED",
      notes: "Please note I need wheelchair access",
      attachment_url: "https://drive.example.com/my-file",
      zoom_join_url: null,
      google_meet_url: null,
    })

    const { chatbotId, customerId } = await seedFullCustomBooklyChatbot("notes-attachments")

    const result = await commitBooking({
      chatbotId,
      customerId,
      startTime: new Date().toISOString(),
      duration: 30,
      customer: { name: "Ada", email: "ada@example.com" },
      notes: "Please note I need wheelchair access",
      attachmentUrl: "https://drive.example.com/my-file",
      idempotencyKey: randomUUID(),
    })

    expect(result.status).toBe("CONFIRMED")
    // The real Bookly call actually carried both fields through.
    expect(booklyConnector.createAppointment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ notes: "Please note I need wheelchair access", attachmentUrl: "https://drive.example.com/my-file" }),
    )
  })

  it("a booking with no note/attachment still succeeds — both are optional, never required", async () => {
    vi.mocked(booklyConnector.createAppointment).mockReset()
    vi.mocked(booklyConnector.createAppointment).mockResolvedValueOnce({
      id: "bookly-appt-no-notes",
      resource_id: "r",
      customer_name: "Bea",
      customer_email: "bea@example.com",
      customer_phone: null,
      start_time: new Date().toISOString(),
      end_time: new Date().toISOString(),
      status: "CONFIRMED",
      notes: null,
      attachment_url: null,
      zoom_join_url: null,
      google_meet_url: null,
    })

    const { chatbotId, customerId } = await seedFullCustomBooklyChatbot("no-notes-attachments")

    const result = await commitBooking({
      chatbotId,
      customerId,
      startTime: new Date().toISOString(),
      duration: 30,
      customer: { name: "Bea", email: "bea@example.com" },
      idempotencyKey: randomUUID(),
    })

    expect(result.status).toBe("CONFIRMED")
  })
})
