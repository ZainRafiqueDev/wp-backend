import { randomUUID } from "node:crypto"
import { describe, expect, it, vi, beforeEach } from "vitest"

// Two standout features found competitively lacking in the market
// analysis this session's user provided: (1) a real service-catalog
// pricing answer ("how much does this cost?"), answered from Bookly's own
// price/description fields via a real-time read — not something the owner
// has to separately duplicate into crawled content for the answer to
// exist anywhere; (2) an automatic waitlist — a customer who wanted a
// fully-booked date is offered notification instead of just being told
// "nothing's open," and a real cancellation (appointmentService.js's
// notifyWaitlistForFreedSlot) automatically checks for and emails the
// first person still waiting.
const llmInvoke = vi.fn()
vi.mock("../../src/langgraph/llm.js", () => ({
  hasCommerceLlm: vi.fn(() => true),
  getCommerceLlm: vi.fn(() => ({ invoke: llmInvoke })),
}))

vi.mock("../../src/lib/bookly/connector.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/bookly/connector.js")>("../../src/lib/bookly/connector.js")
  return {
    ...actual,
    getAvailableSlots: vi.fn(),
    getServiceInfo: vi.fn(),
    joinWaitlist: vi.fn(),
  }
})

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
  const resourceId = `resource-${randomUUID()}`
  await db.query(
    `insert into chatbot_bookly_credentials (chatbot_id, base_url, resource_id, resource_label, api_key_encrypted) values ($1, 'https://bookly.example.com', $2, 'Resource', $3)`,
    [chatbotId, resourceId, encryptSecret("test-bookly-api-key")],
  )
  return { chatbotId, resourceId }
}

describe("Pricing questions — service catalog (standout feature)", () => {
  beforeEach(() => {
    llmInvoke.mockReset()
    vi.mocked(booklyConnector.getServiceInfo).mockReset()
  })

  it("answers a real price + description from Bookly's own service-info, not a generic non-answer", async () => {
    const { chatbotId } = await seedFullCustomBooklyChatbot("pricing-question")
    llmInvoke.mockResolvedValueOnce({ content: "pricing_question" })
    vi.mocked(booklyConnector.getServiceInfo).mockResolvedValueOnce({
      name: "Dental Consultation",
      price_cents: 15000,
      price_currency: "USD",
      service_description: "A 30-minute checkup and cleaning.",
    })

    const result = await tryAnswerWithBooklyGraph(chatbotId, null, "how much does a consultation cost?")
    expect(result.handled).toBe(true)
    expect(result.text).toMatch(/150\.00 USD/)
    expect(result.text).toMatch(/30-minute checkup and cleaning/)
  })

  it("gives a clear, honest answer when no price has been set yet, rather than making one up", async () => {
    const { chatbotId } = await seedFullCustomBooklyChatbot("pricing-not-set")
    llmInvoke.mockResolvedValueOnce({ content: "pricing_question" })
    vi.mocked(booklyConnector.getServiceInfo).mockResolvedValueOnce({
      name: "Consultation",
      price_cents: null,
      price_currency: "USD",
      service_description: null,
    })

    const result = await tryAnswerWithBooklyGraph(chatbotId, null, "what's the price?")
    expect(result.text).toMatch(/don't have pricing details/i)
  })
})

describe("Automatic waitlist — offered on a fully-booked date (standout feature)", () => {
  beforeEach(() => {
    llmInvoke.mockReset()
    vi.mocked(booklyConnector.getAvailableSlots).mockReset()
    vi.mocked(booklyConnector.joinWaitlist).mockReset()
  })

  // LangGraph replays every regular call (LLM calls included, per its own
  // documented interrupt-replay semantics) on every resume of a still-open
  // execution — a content-aware mock is robust to exactly how many times
  // a given extraction call is internally replayed, unlike a rigid
  // hand-counted mockResolvedValueOnce queue (see booklyRescheduleCancel's
  // own doc comment on the same lesson).
  function waitlistSmartMock(getIntent: () => string) {
    return async (messages: { content: string }[]) => {
      const prompt = String(messages[0]?.content ?? "")
      if (prompt.includes("Classify the customer's LATEST message")) {
        return { content: getIntent() }
      }
      if (prompt.includes("extract the SINGLE date")) {
        const isoMatches = prompt.match(/\d{4}-\d{2}-\d{2}/g)
        const isoInTranscript = isoMatches && isoMatches.length > 1 ? isoMatches[isoMatches.length - 1] : null
        if (isoInTranscript) return { content: isoInTranscript }
        const monthMatch = prompt.match(/user: .*?(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})[a-z]*,?\s+(\d{4})/i)
        if (monthMatch) {
          const parsed = new Date(`${monthMatch[1]} ${monthMatch[2]}, ${monthMatch[3]} UTC`)
          if (!Number.isNaN(parsed.getTime())) return { content: parsed.toISOString().slice(0, 10) }
        }
        return { content: "null" }
      }
      if (prompt.includes("extract what's known so far about an appointment")) {
        // Only the LATEST "user: ..." line - an earlier turn like
        // "user: September 28 2026" would otherwise false-match "September"
        // as a name via a looser whole-transcript search.
        const userLines = [...prompt.matchAll(/^user: (.*)$/gm)]
        const latestUserLine = userLines.length > 0 ? userLines[userLines.length - 1][1] : ""
        const emailMatch = latestUserLine.match(/[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}/)
        const nameMatch = latestUserLine.match(/([A-Z][a-z]+)/)
        return {
          content: JSON.stringify({
            slotIndex: null,
            customerName: nameMatch ? nameMatch[1] : null,
            email: emailMatch ? emailMatch[0] : null,
            phone: null,
            notes: null,
            attachmentUrl: null,
          }),
        }
      }
      if (prompt.includes("Does this reply confirm")) {
        const replyMatch = prompt.match(/Reply: "([^"]*)"/i)
        const reply = (replyMatch?.[1] ?? "").toLowerCase()
        if (reply.includes("yes")) return { content: "yes" }
        if (reply.includes("no")) return { content: "no" }
        return { content: "unclear" }
      }
      return { content: "null" }
    }
  }

  it("offers the waitlist when a booking-intent date has ZERO real slots, and joins it on confirmation", async () => {
    const { chatbotId, resourceId } = await seedFullCustomBooklyChatbot("waitlist-offer")
    const conversationId = randomUUID()

    llmInvoke.mockImplementation(waitlistSmartMock(() => "booking_intent"))
    vi.mocked(booklyConnector.getAvailableSlots).mockResolvedValue([]) // fully booked, every check

    const t1 = await tryAnswerWithBooklyGraph(chatbotId, conversationId, "book me a meeting")
    expect(t1.text).toMatch(/what date/i)

    const t2 = await tryAnswerWithBooklyGraph(chatbotId, conversationId, "September 28 2026")
    expect(t2.text).toMatch(/nothing open on 2026-09-28/i)
    expect(t2.text).toMatch(/notify you/i)

    const t3 = await tryAnswerWithBooklyGraph(chatbotId, conversationId, "yes please")
    expect(t3.text).toMatch(/name.*email|email.*name/i)

    vi.mocked(booklyConnector.joinWaitlist).mockResolvedValue({ id: "waitlist-1" })
    const t4 = await tryAnswerWithBooklyGraph(chatbotId, conversationId, "Priya, priya@example.com")
    expect(t4.text).toMatch(/i'll let you know/i)
    expect(booklyConnector.joinWaitlist).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ resourceId, customerName: "Priya", customerEmail: "priya@example.com", requestedDate: "2026-09-28" }),
    )
  })

  it("declining the waitlist offer ends the flow cleanly, no waitlist call made", async () => {
    const { chatbotId } = await seedFullCustomBooklyChatbot("waitlist-decline")
    const conversationId = randomUUID()

    llmInvoke.mockImplementation(waitlistSmartMock(() => "booking_intent"))
    vi.mocked(booklyConnector.getAvailableSlots).mockResolvedValue([])

    const t1 = await tryAnswerWithBooklyGraph(chatbotId, conversationId, "book me for September 28 2026")
    expect(t1.text).toMatch(/notify you/i)

    const t2 = await tryAnswerWithBooklyGraph(chatbotId, conversationId, "no thanks")
    expect(t2.text).toMatch(/different date/i)
    expect(booklyConnector.joinWaitlist).not.toHaveBeenCalled()
  })
})
