import { randomUUID } from "node:crypto"
import { describe, expect, it, vi, beforeEach } from "vitest"

// Real gap found live, not by a test: a customer asking for a time
// outside business hours (e.g. 8am when the resource's earliest real slot
// is 9am) got the exact same vague "Could you tell me which time?"
// forever, with no indication their request was never bookable at all.
// Fixed in buildBookingDraftNode: the very first ask already lists the
// real available times and invites the customer to pick one or type
// their own; a second, still-unresolved attempt gets an apologetic
// "that time isn't available" framing around the same real list.
const llmInvoke = vi.fn()
vi.mock("../../src/langgraph/llm.js", () => ({
  hasCommerceLlm: vi.fn(() => true),
  getCommerceLlm: vi.fn(() => ({ invoke: llmInvoke })),
}))

vi.mock("../../src/lib/bookly/connector.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/bookly/connector.js")>("../../src/lib/bookly/connector.js")
  return { ...actual, getAvailableSlots: vi.fn() }
})

function json(obj: Record<string, unknown>) {
  return { content: JSON.stringify(obj) }
}

const { pool } = await import("../../src/lib/db.js")
const { encryptSecret } = await import("../../src/lib/crypto.js")
const { tryAnswerWithBooklyGraph } = await import("../../src/langgraph/booklyEntrypoint.js")
const booklyConnector = await import("../../src/lib/bookly/connector.js")
const { signupUser } = await import("../helpers.js")

async function seedFullCustomBooklyChatbot(label: string) {
  const db = pool!
  const { user } = await signupUser(label)
  await db.query(`insert into subscriptions (user_id, stripe_customer_id, plan, status) values ($1, $2, 'full_custom', 'active')`, [user.id, `cus_${randomUUID()}`])
  const { rows: chatbotRows } = await db.query("insert into chatbots (user_id, name, sources, theme, status) values ($1, 'bot', '[]', '{}', 'ready') returning id", [user.id])
  const chatbotId = chatbotRows[0].id as string
  await db.query(
    `insert into chatbot_bookly_credentials (chatbot_id, base_url, resource_id, resource_label, api_key_encrypted) values ($1, 'https://bookly.example.com', $2, 'Resource', $3)`,
    [chatbotId, `resource-${randomUUID()}`, encryptSecret("test-bookly-api-key")],
  )
  return chatbotId
}

describe("A time outside business hours gets a helpful answer, not an infinite vague loop", () => {
  beforeEach(() => {
    llmInvoke.mockReset()
    vi.mocked(booklyConnector.getAvailableSlots).mockReset()
  })

  it("asking for 8am when the earliest real slot is 9am lists the real available times instead of repeating the same question", async () => {
    const chatbotId = await seedFullCustomBooklyChatbot("time-clarify")
    const conversationId = randomUUID()

    llmInvoke.mockResolvedValueOnce({ content: "booking_intent" }) // classify_intent
    llmInvoke.mockResolvedValueOnce({ content: "2026-09-15" }) // extractDate resolves immediately
    vi.mocked(booklyConnector.getAvailableSlots).mockResolvedValueOnce([
      "2026-09-15T09:00:00.000Z",
      "2026-09-15T09:30:00.000Z",
      "2026-09-15T10:00:00.000Z",
    ])
    llmInvoke.mockResolvedValueOnce(json({ slotIndex: null, customerName: null, email: null, phone: null, notes: null, attachmentUrl: null })) // extractDraftFields, nothing yet
    const t1 = await tryAnswerWithBooklyGraph(chatbotId, conversationId, "book me a meeting on September 15 2026")
    expect(t1.text).toMatch(/09:00 AM|9:00 AM/i) // real times are listed on the very first ask
    expect(t1.text).toMatch(/pick one|tell me another time/i) // and the customer is invited to pick one or write their own

    // Customer insists on 8am — genuinely not a real slot, no match.
    llmInvoke.mockResolvedValueOnce(json({ slotIndex: null, customerName: null, email: null, phone: null, notes: null, attachmentUrl: null })) // replay, still nothing
    llmInvoke.mockResolvedValueOnce(json({ slotIndex: null, customerName: "Zain", email: "zain@example.com", phone: null, notes: null, attachmentUrl: null })) // 8am still doesn't match any slot
    const t2 = await tryAnswerWithBooklyGraph(chatbotId, conversationId, "8am, zain@example.com, Zain")
    expect(t2.text).toMatch(/that time isn't available/i)
    expect(t2.text).toMatch(/09:00 AM|9:00 AM/i) // the real earliest slot is surfaced again
  })
})
