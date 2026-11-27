import { randomUUID } from "node:crypto"
import { describe, expect, it, vi, beforeEach } from "vitest"

// A fourth real bug in the booking conversation, found by actually talking
// to the bot through a real running instance (not by a test) while
// verifying Bookly is deployment-ready: a real, correctable error early in
// a conversation (a transient Bookly outage while checking availability)
// permanently "poisoned" every LATER message in that SAME conversation,
// even after the underlying issue was fixed and check_availability could
// succeed again.
//
// Root cause, confirmed against the real code and the real LangGraph
// state shape (booklyState.ts): responseText's reducer is
// `(_prev, next) => next` — LangGraph only invokes a channel's reducer
// when a node's returned partial object actually INCLUDES that key.
// checkAvailabilityNode's error branch sets responseText to a fallback
// message (booklyNodes.ts's checkAvailabilityNode catch block); its
// SUCCESS branch omits the key entirely rather than explicitly clearing
// it. Because classify_intent replays on every single graph invocation on
// a thread (LangGraph's documented interrupt-replay semantics — see the
// three-bug fix earlier in this history) and always runs before any node
// that reads or sets responseText for routing, a responseText left over
// from an earlier turn's error survives in the Postgres checkpoint
// indefinitely and gets treated as THIS turn's outcome too — routing
// straight to END with the stale error text via
// booklyGraph.ts's `(state) => (state.intent === "booking_intent" &&
// !state.responseText ? "build_booking_draft" : END)` edge, even though
// check_availability just genuinely succeeded moments earlier in the same
// invocation.
//
// Fixed in classifyIntentNode (booklyNodes.ts): explicitly returns
// `responseText: null` on its normal path, since it's the one node
// guaranteed to run first on every invocation, fresh or resumed.
const llmInvoke = vi.fn()
vi.mock("../../src/langgraph/llm.js", () => ({
  hasCommerceLlm: vi.fn(() => true),
  getCommerceLlm: vi.fn(() => ({ invoke: llmInvoke })),
}))

vi.mock("../../src/lib/bookly/connector.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/bookly/connector.js")>("../../src/lib/bookly/connector.js")
  return { ...actual, getAvailableSlots: vi.fn() }
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
  await db.query(
    `insert into chatbot_bookly_credentials (chatbot_id, base_url, resource_id, resource_label, api_key_encrypted) values ($1, 'https://bookly.example.com', $2, 'Resource', $3)`,
    [chatbotId, `resource-${randomUUID()}`, encryptSecret("test-bookly-api-key")],
  )
  return chatbotId
}

describe("Bookly graph — a transient check_availability failure must not poison the rest of the conversation", () => {
  beforeEach(() => {
    llmInvoke.mockReset()
    vi.mocked(booklyConnector.getAvailableSlots).mockReset()
  })

  it("an error on one turn is real and shown; a later turn that succeeds is NOT stuck repeating the old error text", async () => {
    const chatbotId = await seedFullCustomBooklyChatbot("stale-response-text")
    const conversationId = randomUUID()

    // Turn 1: "book me a meeting" -> no date yet -> interrupts asking for one.
    llmInvoke.mockResolvedValueOnce({ content: "booking_intent" }) // classify_intent
    llmInvoke.mockResolvedValueOnce({ content: "null" }) // extractDate, turn 1
    const t1 = await tryAnswerWithBooklyGraph(chatbotId, conversationId, "book me a meeting")
    expect(t1.handled).toBe(true)
    expect(t1.text).toMatch(/date/i)

    // Turn 2: gives a date. Bookly is genuinely unreachable right now (a
    // real transient outage, modeled here as the connector rejecting) —
    // the customer correctly sees a clean error, not a crash or a hang.
    llmInvoke.mockResolvedValueOnce({ content: "null" }) // extractDate replay (unchanged state)
    llmInvoke.mockResolvedValueOnce({ content: "2026-09-21" }) // extractDate resolves
    vi.mocked(booklyConnector.getAvailableSlots).mockRejectedValueOnce(new booklyConnector.BooklyApiError(0, "Could not reach the Bookly server."))
    const t2 = await tryAnswerWithBooklyGraph(chatbotId, conversationId, "September 21 2026")
    expect(t2.handled).toBe(true)
    expect(t2.text).toMatch(/couldn't check availability|try again/i)

    // Turn 3: SAME conversation. The customer tries again with the same
    // date; Bookly is back up now (the connector succeeds this time).
    // Without the fix, this would still return turn 2's stale error text
    // forever, even though check_availability itself just succeeded.
    llmInvoke.mockResolvedValueOnce({ content: "booking_intent" }) // classify_intent, fresh top-level message
    llmInvoke.mockResolvedValueOnce({ content: "2026-09-21" }) // extractDate resolves immediately (date is in this message)
    vi.mocked(booklyConnector.getAvailableSlots).mockResolvedValueOnce(["2026-09-21T09:00:00.000Z", "2026-09-21T09:30:00.000Z"])
    const t3 = await tryAnswerWithBooklyGraph(chatbotId, conversationId, "let's try September 21 2026 again")

    expect(t3.handled).toBe(true)
    expect(t3.text).not.toMatch(/couldn't check availability/i)
    // Reaches build_booking_draft's own next question instead of repeating
    // turn 2's error — proof the stale responseText was actually cleared.
    expect(t3.text).toMatch(/time|email|name/i)
  })
})
