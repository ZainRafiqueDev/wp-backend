import { randomUUID } from "node:crypto"
import { describe, expect, it, vi, beforeEach } from "vitest"

// Real bug, found by actually talking to the bot (not by a test) — two
// real, independent causes, both confirmed against the actual code/
// checkpointer state, not guessed:
//
// 1. THE ACTUAL TRIGGER (booklyEntrypoint.ts): its resume check was
//    `snapshot.next.length > 0`. Confirmed via the checkpointer's real
//    state that `next` goes back to `[]` once a node has already been
//    interrupted-and-resumed at least once within the same execution —
//    e.g. build_booking_draft's SECOND follow-up question ("which
//    time?", after the first one was already answered). `snapshot.tasks`
//    correctly still shows the pending interrupt when this happens;
//    `next` doesn't. The entrypoint treated this as "not paused" and
//    started a brand-new thread instead of resuming the real one —
//    exactly why the bug only ever showed up on the SECOND missing-field
//    question, never the first (see booklyEntrypoint.ts's own comment).
// 2. A real, independent robustness gap (booklyNodes.ts's
//    buildBookingDraftNode): its loop REASSIGNED its extraction result
//    wholesale on every pass instead of merging field-by-field with what
//    was already known. LangGraph's own documented interrupt-replay
//    semantics mean every LLM call before an unresolved interrupt() is a
//    genuine, non-cached call that re-executes on every resume — so even
//    with #1 fixed, a single incomplete/failed extraction pass later in
//    a long conversation could still silently wipe an already-collected
//    field back to null. Fixed with mergeDraftExtraction.
//
// This test proves #2 specifically (a later pass that resolves the time
// but omits already-known fields must not erase them) — #1 is what let
// this test's own multi-turn conversation resume correctly at all.
const llmInvoke = vi.fn()
vi.mock("../../src/langgraph/llm.js", () => ({
  hasCommerceLlm: vi.fn(() => true),
  getCommerceLlm: vi.fn(() => ({ invoke: llmInvoke })),
}))

// checkAvailabilityForChatbot's own authorization/resource-resolution logic
// stays real; only the actual network call to Bookly (a fake base URL
// here) is mocked - same pattern booklyMultiResource's tests use.
vi.mock("../../src/lib/bookly/connector.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/bookly/connector.js")>("../../src/lib/bookly/connector.js")
  return { ...actual, getAvailableSlots: vi.fn().mockResolvedValue(["2026-09-14T09:00:00.000Z", "2026-09-14T09:30:00.000Z", "2026-09-14T10:00:00.000Z"]) }
})

const { pool } = await import("../../src/lib/db.js")
const { encryptSecret } = await import("../../src/lib/crypto.js")
const { tryAnswerWithBooklyGraph } = await import("../../src/langgraph/booklyEntrypoint.js")
const { signupUser } = await import("../helpers.js")

function json(obj: Record<string, unknown>) {
  return { content: JSON.stringify(obj) }
}

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

describe("Bookly booking draft — additive field merge across turns (real bug, found via a live conversation)", () => {
  beforeEach(() => {
    llmInvoke.mockReset()
  })

  it("a later pass that resolves the time but omits already-known email/name must not wipe them — reaches confirmation, not a repeat of every question", async () => {
    const chatbotId = await seedFullCustomBooklyChatbot("draft-merge")
    const conversationId = randomUUID()

    // Turn 1: "book me a meeting" -> classify_intent, then check_availability's
    // own extractDate finds nothing yet -> interrupts asking for a date.
    llmInvoke.mockResolvedValueOnce({ content: "booking_intent" }) // classify_intent
    llmInvoke.mockResolvedValueOnce({ content: "null" })            // extractDate, turn 1 (no date yet)
    const t1 = await tryAnswerWithBooklyGraph(chatbotId, conversationId, "book me a meeting")
    expect(t1.handled).toBe(true)
    expect(t1.text).toMatch(/date/i)

    // Turn 2: gives the date. extractDate replays (null again on the same
    // state), then resolves with the new reply; build_booking_draft then
    // starts in the same run and asks for time+email+name together.
    llmInvoke.mockResolvedValueOnce({ content: "null" })              // extractDate replay (unchanged state)
    llmInvoke.mockResolvedValueOnce({ content: "2026-09-14" })        // extractDate resolves the date
    llmInvoke.mockResolvedValueOnce(json({ slotIndex: null, customerName: null, email: null, phone: null, notes: null, attachmentUrl: null })) // extractDraftFields, turn 2 (nothing yet)
    const t2 = await tryAnswerWithBooklyGraph(chatbotId, conversationId, "14 of september please 2026")
    expect(t2.handled).toBe(true)
    expect(t2.text).toMatch(/time/i)
    expect(t2.text).toMatch(/email/i)
    expect(t2.text).toMatch(/name/i)

    // Turn 3: gives time + email + name jumbled together, but the model's
    // pass on this fuller transcript only confidently resolves email and
    // name — matches the real reported behavior exactly ("asks again for
    // time ONLY").
    llmInvoke.mockResolvedValueOnce(json({ slotIndex: null, customerName: null, email: null, phone: null, notes: null, attachmentUrl: null })) // extractDraftFields replay (unchanged state)
    llmInvoke.mockResolvedValueOnce(
      json({ slotIndex: null, customerName: "Zain Personal", email: "zain.rafiqu.pro1@gmail.com", phone: null, notes: "thoughts sessions", attachmentUrl: null }),
    ) // extractDraftFields resolves email+name, NOT yet the time
    const t3 = await tryAnswerWithBooklyGraph(chatbotId, conversationId, "9 am zain.rafiqu.pro1@gmail.com Zain Personal thoughts sessions")
    expect(t3.handled).toBe(true)
    expect(t3.text).toMatch(/time/i)
    expect(t3.text).not.toMatch(/email/i) // only time is still missing - the real bug's absence, confirmed at this step too

    // Turn 4: "9:00 am" alone. The FINAL extraction pass for this turn
    // resolves the time correctly but - deliberately, to test the exact
    // failure mode - comes back with email/customerName null in ITS OWN
    // single-pass output (a later pass not fully re-stating what an
    // earlier pass already established, which real LLM calls do
    // sometimes). Without the merge fix, this would wipe email/name and
    // the bot would ask for everything again - the exact reported bug.
    llmInvoke.mockResolvedValueOnce(json({ slotIndex: null, customerName: null, email: null, phone: null, notes: null, attachmentUrl: null })) // extractDraftFields replay (unchanged state)
    llmInvoke.mockResolvedValueOnce(
      json({ slotIndex: null, customerName: "Zain Personal", email: "zain.rafiqu.pro1@gmail.com", phone: null, notes: "thoughts sessions", attachmentUrl: null }),
    ) // replay of turn 3's resolving pass (same cached interrupt reply, same real re-call)
    llmInvoke.mockResolvedValueOnce(json({ slotIndex: 0, customerName: null, email: null, phone: null, notes: null, attachmentUrl: null })) // turn 4's own pass: resolves time, omits email/name
    const t4 = await tryAnswerWithBooklyGraph(chatbotId, conversationId, "9:00 am")

    expect(t4.handled).toBe(true)
    // The fix in effect: reaches confirmation (asks to confirm the
    // booking), instead of re-asking for time/email/name from scratch.
    expect(t4.text).not.toMatch(/tell me.*time/i)
    expect(t4.text).not.toMatch(/email address/i)
    expect(t4.text?.toLowerCase()).toContain("zain personal") // the preserved name shows up in the confirmation summary
    expect(t4.text).toMatch(/book this|shall i|confirm/i)
  })
})
