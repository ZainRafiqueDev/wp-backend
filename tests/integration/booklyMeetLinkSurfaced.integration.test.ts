import { randomUUID } from "node:crypto"
import { describe, expect, it, vi } from "vitest"

// A real gap found while manually testing Google Calendar sync end to
// end: Bookly's own createAppointment response already carries
// google_meet_url/zoom_join_url when the resource has a video provider
// configured, but ChatMate360's local mirror table
// (chatbot_bookly_appointments) never stored them and commitBookingNode's
// confirmation text never surfaced them — a customer booking through the
// chatbot got "You're booked!" with no way to actually join the meeting,
// even though Bookly generated a real link for that exact appointment.
//
// Fixed: db/schema.sql adds google_meet_url/zoom_join_url to
// chatbot_bookly_appointments; booklyBooking.service.ts's commitBooking
// persists them from Bookly's real response and LocalBooklyAppointment/
// mapRow expose them; booklyNodes.ts's commitBookingNode appends whichever
// one is set to the customer-facing confirmation text.
vi.mock("../../src/lib/bookly/connector.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/bookly/connector.js")>("../../src/lib/bookly/connector.js")
  return {
    ...actual,
    createAppointment: vi.fn(),
  }
})

vi.mock("../../src/langgraph/llm.js", () => ({
  hasCommerceLlm: vi.fn(() => true),
  getCommerceLlm: vi.fn(() => ({ invoke: vi.fn() })),
}))

const { pool } = await import("../../src/lib/db.js")
const { encryptSecret } = await import("../../src/lib/crypto.js")
const { commitBooking } = await import("../../src/services/booklyBooking.service.js")
const { commitBookingNode } = await import("../../src/langgraph/booklyNodes.js")
const booklyConnector = await import("../../src/lib/bookly/connector.js")
const { signupUser } = await import("../helpers.js")

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
  const { rows: customerRows } = await db.query("insert into customer_identities (chatbot_id, email) values ($1, $2) returning id", [chatbotId, `customer-${randomUUID()}@example.test`])
  return { chatbotId, customerId: customerRows[0].id as string }
}

function fakeBooklyAppointment(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: `bookly-appt-${randomUUID()}`,
    resource_id: "resource-1",
    customer_name: "Test Customer",
    customer_email: "customer@example.com",
    customer_phone: null,
    start_time: "2026-09-21T09:00:00.000Z",
    end_time: "2026-09-21T09:30:00.000Z",
    status: "CONFIRMED",
    notes: null,
    attachment_url: null,
    zoom_join_url: null,
    google_meet_url: null,
    ...overrides,
  }
}

describe("A real Google Meet / Zoom link from Bookly is persisted and surfaced to the chatbot customer", () => {
  it("commitBooking persists the real google_meet_url onto ChatMate360's own mirror row, not just Bookly's own database", async () => {
    const { chatbotId, customerId } = await seedFullCustomBooklyChatbot("meet-link-persist")
    vi.mocked(booklyConnector.createAppointment).mockResolvedValueOnce(
      fakeBooklyAppointment({ google_meet_url: "https://meet.google.com/abc-defg-hij" }) as never,
    )

    const result = await commitBooking({
      chatbotId,
      customerId,
      startTime: "2026-09-21T09:00:00.000Z",
      duration: 30,
      customer: { name: "Test Customer", email: "customer@example.com" },
      idempotencyKey: randomUUID(),
    })

    expect(result.googleMeetUrl).toBe("https://meet.google.com/abc-defg-hij")
    expect(result.zoomJoinUrl).toBeNull()

    // Genuinely persisted, not just returned in-memory — a later read of
    // the same row (e.g. an idempotent replay) sees it too.
    const { rows } = await pool!.query("select google_meet_url from chatbot_bookly_appointments where id = $1", [result.id])
    expect(rows[0].google_meet_url).toBe("https://meet.google.com/abc-defg-hij")
  })

  it("a Zoom join link is persisted the same way when that's what Bookly returns instead", async () => {
    const { chatbotId, customerId } = await seedFullCustomBooklyChatbot("zoom-link-persist")
    vi.mocked(booklyConnector.createAppointment).mockResolvedValueOnce(
      fakeBooklyAppointment({ zoom_join_url: "https://zoom.us/j/123456789" }) as never,
    )

    const result = await commitBooking({
      chatbotId,
      customerId,
      startTime: "2026-09-21T09:00:00.000Z",
      duration: 30,
      customer: { name: "Test Customer", email: "customer@example.com" },
      idempotencyKey: randomUUID(),
    })

    expect(result.zoomJoinUrl).toBe("https://zoom.us/j/123456789")
    expect(result.googleMeetUrl).toBeNull()
  })

  it("a resource with no video provider configured leaves both link fields null, not an error", async () => {
    const { chatbotId, customerId } = await seedFullCustomBooklyChatbot("no-link")
    vi.mocked(booklyConnector.createAppointment).mockResolvedValueOnce(fakeBooklyAppointment() as never)

    const result = await commitBooking({
      chatbotId,
      customerId,
      startTime: "2026-09-21T09:00:00.000Z",
      duration: 30,
      customer: { name: "Test Customer", email: "customer@example.com" },
      idempotencyKey: randomUUID(),
    })

    expect(result.googleMeetUrl).toBeNull()
    expect(result.zoomJoinUrl).toBeNull()
  })
})

describe("commitBookingNode — the chatbot's own confirmation text includes the real join link", () => {
  it("includes a real Google Meet link in the customer-facing confirmation when one was generated", async () => {
    vi.mocked(booklyConnector.createAppointment).mockResolvedValueOnce(
      fakeBooklyAppointment({ google_meet_url: "https://meet.google.com/xyz-uvwx-rst" }) as never,
    )
    const { chatbotId } = await seedFullCustomBooklyChatbot("meet-link-in-text")

    const state = {
      chatbotId,
      customerId: null,
      graphRunId: randomUUID(),
      requestId: undefined,
      messages: [],
      bookingDraft: {
        startTime: "2026-09-21T09:00:00.000Z",
        duration: 30,
        customerName: "Zain",
        customerEmail: "zain@example.com",
        customerPhone: null,
        notes: null,
        attachmentUrl: null,
      },
    } as never

    const result = await commitBookingNode(state)
    expect(result.responseText).toContain("https://meet.google.com/xyz-uvwx-rst")
    expect(result.responseText).toMatch(/join the meeting/i)
  })
})
