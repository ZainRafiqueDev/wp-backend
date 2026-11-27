import { randomUUID } from "node:crypto"
import { describe, expect, it, vi, beforeEach } from "vitest"

// Reschedule/cancel via chat — previously a deliberate scope narrowing
// (booklyNodes.ts's own file header used to say so explicitly), NOT a
// backend gap: rescheduleBookingForCustomer/cancelBookingForCustomer
// already existed, fully authorized, for the admin-chat path. This adds
// the conversational (interrupt-based identify/confirm) layer the
// customer-facing graph never had, reusing extractDate/extractDraftFields/
// mergeDraftExtraction verbatim from the booking flow.
//
// While building this, found and fixed a real, pre-existing latent bug
// shared by add_note/appointment_status_lookup's own "what email did you
// book with?" step (and copied here at first): it returned immediately
// with whatever interrupt() handed back, with no loop and no re-check — a
// customer who replies with JUST their email (the normal way to answer a
// direct question) got that reply appended to the transcript and the turn
// silently ended right there, never actually resolving anything further.
// Fixed once, in a new shared collectEmail() helper, reused by all four
// email-identifying nodes.
const llmInvoke = vi.fn()
vi.mock("../../src/langgraph/llm.js", () => ({
  hasCommerceLlm: vi.fn(() => true),
  getCommerceLlm: vi.fn(() => ({ invoke: llmInvoke })),
}))

// CS-04: existing-booking actions now require proving the email with a
// one-time code. The mailer is mocked and the code read back from it.
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
  }
})

const { pool } = await import("../../src/lib/db.js")
const { encryptSecret } = await import("../../src/lib/crypto.js")
const { tryAnswerWithBooklyGraph } = await import("../../src/langgraph/booklyEntrypoint.js")
const booklyConnector = await import("../../src/lib/bookly/connector.js")
const { signupUser } = await import("../helpers.js")
const { sendEmail } = await import("../../src/lib/email.js")

// Unique per run: the OTP resend cooldown is keyed on the email address.
function runEmail(local: string): string {
  return `${local}-${randomUUID().slice(0, 8)}@example.com`
}

function codeSentTo(email: string): string {
  const calls = vi.mocked(sendEmail).mock.calls.filter(([input]) => input.to === email.toLowerCase())
  const code = calls[calls.length - 1]?.[0].text.match(/code is: (\d{6})/)?.[1]
  if (!code) throw new Error(`no verification code was sent to ${email}`)
  return code
}

async function seedChatbotWithExistingBooking(label: string, email: string) {
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
  const { rows: customerRows } = await db.query("insert into customer_identities (chatbot_id, email) values ($1, $2) returning id", [chatbotId, email])
  const customerId = customerRows[0].id as string
  const originalBooklyAppointmentId = `bookly-appt-${randomUUID()}`
  const { rows: apptRows } = await db.query(
    `insert into chatbot_bookly_appointments (chatbot_id, customer_id, bookly_appointment_id, idempotency_key, bookly_resource_id, start_time, status)
     values ($1, $2, $3, $4, $5, '2026-09-21T09:00:00.000Z', 'CONFIRMED') returning id`,
    [chatbotId, customerId, originalBooklyAppointmentId, randomUUID(), resourceId],
  )
  return { chatbotId, resourceId, customerId, appointmentId: apptRows[0].id as string, originalBooklyAppointmentId }
}

describe("Cancel an existing appointment via chat", () => {
  beforeEach(() => {
    llmInvoke.mockReset()
    vi.mocked(booklyConnector.cancelAppointment).mockReset()
  })

  it("identifies the booking by email, confirms, and cancels the real Bookly appointment", async () => {
    const email = runEmail("cancel-me")
    const { chatbotId, appointmentId, originalBooklyAppointmentId } = await seedChatbotWithExistingBooking("cancel-chat", email)
    const conversationId = randomUUID()

    llmInvoke.mockResolvedValueOnce({ content: "cancel_appointment" }) // classify_intent
    const t1 = await tryAnswerWithBooklyGraph(chatbotId, conversationId, "I need to cancel my appointment")
    expect(t1.handled).toBe(true)
    expect(t1.text).toMatch(/what email/i)

    llmInvoke.mockResolvedValueOnce({ content: "yes" }) // confirmYesNo
    const t2 = await tryAnswerWithBooklyGraph(chatbotId, conversationId, email)
    expect(t2.handled).toBe(true)
    expect(t2.text).toMatch(/verification code/i)

    const t2b = await tryAnswerWithBooklyGraph(chatbotId, conversationId, codeSentTo(email))
    expect(t2b.text).toMatch(/is that right/i)

    vi.mocked(booklyConnector.cancelAppointment).mockResolvedValueOnce({
      id: originalBooklyAppointmentId,
      resource_id: "r",
      customer_name: "Test",
      customer_email: email,
      customer_phone: null,
      start_time: "2026-09-21T09:00:00.000Z",
      end_time: "2026-09-21T09:30:00.000Z",
      status: "CANCELLED",
      notes: null,
      attachment_url: null,
      zoom_join_url: null,
      google_meet_url: null,
    })
    const t3 = await tryAnswerWithBooklyGraph(chatbotId, conversationId, "yes")
    expect(t3.handled).toBe(true)
    expect(t3.text).toMatch(/cancelled/i)
    expect(booklyConnector.cancelAppointment).toHaveBeenCalledWith(expect.anything(), originalBooklyAppointmentId)

    const { rows } = await pool!.query("select status from chatbot_bookly_appointments where id = $1", [appointmentId])
    expect(rows[0].status).toBe("CANCELLED")
  })

  it("declining the confirmation leaves the appointment untouched", async () => {
    const email = runEmail("keep-it")
    const { chatbotId, appointmentId } = await seedChatbotWithExistingBooking("cancel-chat-decline", email)
    const conversationId = randomUUID()

    llmInvoke.mockResolvedValueOnce({ content: "cancel_appointment" })
    await tryAnswerWithBooklyGraph(chatbotId, conversationId, "cancel my appointment")
    llmInvoke.mockResolvedValueOnce({ content: "no" })
    await tryAnswerWithBooklyGraph(chatbotId, conversationId, email)
    const t2 = await tryAnswerWithBooklyGraph(chatbotId, conversationId, codeSentTo(email))
    expect(t2.text).toMatch(/is that right/i)

    const t3 = await tryAnswerWithBooklyGraph(chatbotId, conversationId, "actually no, keep it")
    expect(t3.text).toMatch(/still booked/i)
    expect(booklyConnector.cancelAppointment).not.toHaveBeenCalled()

    const { rows } = await pool!.query("select status from chatbot_bookly_appointments where id = $1", [appointmentId])
    expect(rows[0].status).toBe("CONFIRMED")
  })

  it("a customer with no upcoming appointment gets a clean message, never a crash", async () => {
    const { chatbotId } = await seedChatbotWithExistingBooking("cancel-chat-none", runEmail("has-a-booking"))
    const otherEmail = runEmail("nobody-has-booked")
    const conversationId = randomUUID()

    llmInvoke.mockResolvedValueOnce({ content: "cancel_appointment" })
    await tryAnswerWithBooklyGraph(chatbotId, conversationId, "cancel my appointment")
    await tryAnswerWithBooklyGraph(chatbotId, conversationId, otherEmail)
    const t2 = await tryAnswerWithBooklyGraph(chatbotId, conversationId, codeSentTo(otherEmail))
    expect(t2.text).toMatch(/don't see any upcoming appointments/i)
  })
})

// LangGraph replays every regular call (LLM calls included, per its own
// documented interrupt-replay semantics — see the three-bug fix earlier in
// this history) on EVERY resume of a still-open node execution, not just
// once per customer-visible "turn." A rigid, hand-counted
// mockResolvedValueOnce queue is exactly the kind of thing that made bug
// #2 (booklyNodes.ts's old wholesale-reassignment extraction merge) hard
// to reason about in the first place. A content-aware mock is robust to
// exactly how many times LangGraph internally replays a given extraction
// call, which is what this reschedule flow's multi-step interrupt chain
// (email -> date -> time -> confirm) genuinely exercises.
function smartLlmMock(getIntent: () => string) {
  return async (messages: { content: string }[]) => {
    const prompt = String(messages[0]?.content ?? "")
    if (prompt.includes("Classify the customer's LATEST message")) {
      return { content: getIntent() }
    }
    if (prompt.includes("extract the SINGLE date")) {
      // The prompt always embeds "Today's date is <iso>" first — an
      // already-ISO customer-mentioned date (if any) is a LATER match.
      const isoMatches = prompt.match(/\d{4}-\d{2}-\d{2}/g)
      const isoInTranscript = isoMatches && isoMatches.length > 1 ? isoMatches[isoMatches.length - 1] : null
      if (isoInTranscript) return { content: isoInTranscript }
      // Otherwise parse a plain-language date like "September 28 2026" out
      // of the embedded transcript — real customers don't type ISO dates.
      const monthMatch = prompt.match(/user: .*?(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})[a-z]*,?\s+(\d{4})/i)
      if (monthMatch) {
        const parsed = new Date(`${monthMatch[1]} ${monthMatch[2]}, ${monthMatch[3]} UTC`)
        if (!Number.isNaN(parsed.getTime())) return { content: parsed.toISOString().slice(0, 10) }
      }
      return { content: "null" }
    }
    if (prompt.includes("extract what's known so far about an appointment")) {
      const slotLines = [...prompt.matchAll(/^(\d+): (\S+)$/gm)]
      const timeMatch = prompt.match(/user: .*?(\d{1,2})\s*am/i)
      let slotIndex: number | null = null
      if (timeMatch) {
        const wantedHour = parseInt(timeMatch[1], 10) % 12
        for (const [, idx, iso] of slotLines) {
          if (new Date(iso).getUTCHours() === wantedHour) {
            slotIndex = Number(idx)
            break
          }
        }
      }
      return { content: JSON.stringify({ slotIndex, customerName: null, email: null, phone: null, notes: null, attachmentUrl: null }) }
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

describe("Reschedule an existing appointment via chat", () => {
  beforeEach(() => {
    llmInvoke.mockReset()
    vi.mocked(booklyConnector.getAvailableSlots).mockReset()
    vi.mocked(booklyConnector.rescheduleAppointment).mockReset()
  })

  it("identifies the booking, collects a new date + time, confirms, reschedules, and updates the LOCAL mirror's bookly_appointment_id to the NEW real id (the bug fixed alongside this feature)", async () => {
    const email = runEmail("move-me")
    const { chatbotId, appointmentId, originalBooklyAppointmentId } = await seedChatbotWithExistingBooking("reschedule-chat", email)
    const conversationId = randomUUID()
    const newBooklyAppointmentId = `bookly-appt-${randomUUID()}` // genuinely different id — Bookly's real reschedule behavior

    llmInvoke.mockImplementation(smartLlmMock(() => "reschedule_appointment"))
    vi.mocked(booklyConnector.getAvailableSlots).mockResolvedValue(["2026-09-28T09:00:00.000Z", "2026-09-28T09:30:00.000Z"])

    const t1 = await tryAnswerWithBooklyGraph(chatbotId, conversationId, "can I move my appointment?")
    expect(t1.text).toMatch(/what email/i)

    const t2a = await tryAnswerWithBooklyGraph(chatbotId, conversationId, email)
    expect(t2a.text).toMatch(/verification code/i)
    const t2 = await tryAnswerWithBooklyGraph(chatbotId, conversationId, codeSentTo(email))
    expect(t2.text).toMatch(/what date/i)

    const t3 = await tryAnswerWithBooklyGraph(chatbotId, conversationId, "September 28 2026")
    expect(t3.text).toMatch(/09:00 AM|9:00 AM/i) // real available times listed up front, not a vague "what time"

    const t4 = await tryAnswerWithBooklyGraph(chatbotId, conversationId, "9am")
    expect(t4.text).toMatch(/shall i go ahead/i)

    vi.mocked(booklyConnector.rescheduleAppointment).mockResolvedValue({
      id: newBooklyAppointmentId,
      resource_id: "r",
      customer_name: "Test",
      customer_email: email,
      customer_phone: null,
      start_time: "2026-09-28T09:00:00.000Z",
      end_time: "2026-09-28T09:30:00.000Z",
      status: "CONFIRMED",
      notes: null,
      attachment_url: null,
      zoom_join_url: null,
      google_meet_url: null,
    })
    const t5 = await tryAnswerWithBooklyGraph(chatbotId, conversationId, "yes")
    expect(t5.text).toMatch(/your appointment is now/i)
    expect(booklyConnector.rescheduleAppointment).toHaveBeenCalledWith(
      expect.anything(),
      originalBooklyAppointmentId,
      expect.objectContaining({ startTime: "2026-09-28T09:00:00.000Z" }),
    )

    // The bug fix: the local mirror now points at the NEW real Bookly
    // appointment id, not the old (now-cancelled, per Bookly's own
    // reschedule semantics) one.
    const { rows } = await pool!.query("select bookly_appointment_id, start_time from chatbot_bookly_appointments where id = $1", [appointmentId])
    expect(rows[0].bookly_appointment_id).toBe(newBooklyAppointmentId)
    expect(new Date(rows[0].start_time).toISOString()).toBe("2026-09-28T09:00:00.000Z")
  })
})
