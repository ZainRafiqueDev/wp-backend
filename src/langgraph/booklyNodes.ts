
import { interrupt } from "@langchain/langgraph"
import { HumanMessage } from "@langchain/core/messages"

import { log } from "../lib/logger.js"
import { AppError } from "../lib/errors.js"
import { resolveCustomerIdentity } from "../services/customerIdentity.service.js"
import {
  addNoteToBooking,
  cancelBookingForCustomer,
  checkAvailabilityForChatbot,
  commitBooking,
  getServiceInfoForChatbot,
  joinWaitlistForChatbot,
  listBookingsForCustomer,
  rescheduleBookingForCustomer,
} from "../services/booklyBooking.service.js"
import { listBooklyResourceOptions } from "../services/booklyCredentials.service.js"
import { hasCommerceLlm } from "./llm.js"
import { invokeBilledCommerceLlm, LLM_BUDGET_DENIED_TEXT, withLlmBudget } from "./billedLlm.js"
import { CODE_FAILED_TEXT, verifiedCustomerIdFor } from "./customerVerificationNodes.js"
import type { BooklyDraft, BooklyStateType } from "./booklyState.js"

const DEFAULT_DURATION_MINUTES = 30


// CS-04 (VER-02): existing-booking operations never take a customer from a
// typed email. The graph routes them through identify_customer/verify_code
// (customerVerificationNodes.ts) first; these nodes read the customer only
// from the OTP-verified (or signed-token) identity in state.
function requireVerifiedCustomer(state: BooklyStateType): string | null {
  return verifiedCustomerIdFor(state)
}

const NOT_VERIFIED_TEXT = CODE_FAILED_TEXT


function ctx(state: BooklyStateType) {
  return { requestId: state.requestId, graphRunId: state.graphRunId, chatbotId: state.chatbotId, customerId: state.customerId }
}

const INTENTS = [
  "availability_question",
  "booking_intent",
  "appointment_status",
  "add_note",
  "reschedule_appointment",
  "cancel_appointment",
  "pricing_question",
  "other",
] as const
type Intent = (typeof INTENTS)[number]


async function classifyIntentNodeImpl(state: BooklyStateType): Promise<Partial<BooklyStateType>> {
  const latest = state.messages[state.messages.length - 1]?.content ?? ""
  const transcript = state.messages.slice(-6).map((m) => `${m.role}: ${m.content}`).join("\n")

  if (!hasCommerceLlm()) {
    log().error(ctx(state), "bookly classify_intent: no LLM configured")
    return { intent: "other", responseText: "Sorry, booking isn't available right now — this assistant isn't fully configured. Please contact us directly." }
  }

  const result = await invokeBilledCommerceLlm(state.chatbotId, [
    new HumanMessage(
      `Classify the customer's LATEST message into exactly one category: availability_question, booking_intent, appointment_status, add_note, reschedule_appointment, cancel_appointment, pricing_question, or other. Use the conversation so far only to resolve context a bare message like "yes" or "10am" can't be classified from on its own.\n\n` +
        `- availability_question: asking what times/dates are open, not committing to book yet\n` +
        `- booking_intent: wants to book/schedule a NEW appointment (including a short continuation like "yes" or a time that's clearly agreeing to book something already being discussed)\n` +
        `- appointment_status: asking about an existing booking they already have\n` +
        `- add_note: wants to attach a note, comment, or a file/document link to an existing booking (e.g. "add a note to my appointment: bring the signed contract", "can you attach this link to my meeting")\n` +
        `- reschedule_appointment: wants to move an EXISTING appointment to a different date/time (e.g. "can I move my appointment to Thursday", "reschedule my booking")\n` +
        `- cancel_appointment: wants to cancel an EXISTING appointment (e.g. "cancel my appointment", "I can't make it anymore")\n` +
        `- pricing_question: asking how much this costs, or what's included, NOT yet asking to book (e.g. "how much is a consultation", "what does this include")\n` +
        `- other: anything else (greetings, unrelated chit-chat)\n\n` +
        `Conversation so far:\n${transcript}\n\n` +
        `Latest message: "${latest}"\n\nRespond with ONLY the single category word, nothing else.`,
    ),
  ])
  const raw = String(result.content).trim().toLowerCase()
  const intent: Intent = (INTENTS as readonly string[]).includes(raw) ? (raw as Intent) : "other"

  log().info({ ...ctx(state), intent }, "bookly classify_intent")
 
  return { intent, responseText: null }
}
// NEW-01: a denied usage reservation ends the turn politely (see billedLlm.ts).
export const classifyIntentNode = withLlmBudget(classifyIntentNodeImpl, (): Partial<BooklyStateType> => ({ intent: null, responseText: LLM_BUDGET_DENIED_TEXT }))


async function selectResourceNodeImpl(state: BooklyStateType): Promise<Partial<BooklyStateType>> {
  const options = await listBooklyResourceOptions(state.chatbotId)
 
  if (options.length === 0) {
    return {} // selectedResourceId stays null; check_availability's own error handling covers this
  }
  if (options.length === 1) {
    return { selectedResourceId: options[0].resourceId, selectedResourceLabel: options[0].resourceLabel }
  }

  const localMessages: BooklyStateType["messages"] = []
  const optionList = options.map((o) => o.resourceLabel).join(", ")
  let chosen: (typeof options)[number] | undefined

  while (!chosen) {
    const transcript = [...state.messages, ...localMessages].map((m) => `${m.role}: ${m.content}`).join("\n")
    const result = await invokeBilledCommerceLlm(state.chatbotId, [
      new HumanMessage(
        `Available staff/resources: ${optionList}.\n\nFrom this conversation, which one does the customer want? Respond with ONLY the exact matching name from the list above, or "unclear".\n\nConversation:\n${transcript}`,
      ),
    ])
    const raw = String(result.content).trim()
    chosen = options.find((o) => o.resourceLabel.toLowerCase() === raw.toLowerCase())
    if (!chosen) {
      const question = `Who would you like to book with — ${optionList}?`
      const reply = interrupt<string, string>(question)
      localMessages.push({ role: "assistant", content: question }, { role: "user", content: reply })
    }
  }

  log().info({ ...ctx(state), resourceId: chosen.resourceId }, "bookly select_resource complete")
  return { selectedResourceId: chosen.resourceId, selectedResourceLabel: chosen.resourceLabel, messages: localMessages }
}
// NEW-01: a denied usage reservation ends the turn politely (see billedLlm.ts).
export const selectResourceNode = withLlmBudget(selectResourceNodeImpl, (): Partial<BooklyStateType> => ({ responseText: LLM_BUDGET_DENIED_TEXT }))

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

async function extractDate(state: BooklyStateType): Promise<string | null> {
  const transcript = state.messages.map((m) => `${m.role}: ${m.content}`).join("\n")
  const result = await invokeBilledCommerceLlm(state.chatbotId, [
    new HumanMessage(
      `Today's date is ${todayIso()}. From this conversation, extract the SINGLE date (YYYY-MM-DD) the customer wants to check/book availability for. If no date has been mentioned yet, respond with exactly "null".\n\n` +
        `Conversation:\n${transcript}\n\nRespond with ONLY the date in YYYY-MM-DD format, or "null".`,
    ),
  ])
  const raw = String(result.content).trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null
}


async function checkAvailabilityNodeImpl(state: BooklyStateType): Promise<Partial<BooklyStateType>> {
  // NEW-01: select_resource already hit a denied usage reservation this turn
  // (classify_intent resets responseText each run); keep its reply and stop.
  if (state.responseText === LLM_BUDGET_DENIED_TEXT) return {}
  const localMessages: BooklyStateType["messages"] = []
  let date = await extractDate(state)

  while (!date) {
    const question = "What date would you like to check?"
    const reply = interrupt<string, string>(question)
    localMessages.push({ role: "assistant", content: question }, { role: "user", content: reply })
    date = await extractDate({ ...state, messages: [...state.messages, ...localMessages] })
  }

  let slots: string[]
  try {
    slots = await checkAvailabilityForChatbot(state.chatbotId, state.customerId, date, DEFAULT_DURATION_MINUTES, state.selectedResourceId ?? undefined)
  } catch (err) {
    log().error({ ...ctx(state), err: err instanceof Error ? err.message : String(err) }, "bookly check_availability failed")
    const message = err instanceof AppError ? err.message : "Sorry, I couldn't check availability right now. Please try again in a moment."
    return { messages: localMessages, responseText: message }
  }

  if (state.intent === "availability_question") {
    const text =
      slots.length === 0
        ? `Sorry, there's nothing open on ${date}.`
        : `Here's what's open on ${date}: ${slots.map((s) => new Date(s).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })).join(", ")} (UTC).`
    return { messages: localMessages, checkedDate: date, availableSlots: slots, responseText: text }
  }

  return { messages: localMessages, checkedDate: date, availableSlots: slots }
}
// NEW-01: a denied usage reservation ends the turn politely (see billedLlm.ts).
export const checkAvailabilityNode = withLlmBudget(checkAvailabilityNodeImpl, (): Partial<BooklyStateType> => ({ responseText: LLM_BUDGET_DENIED_TEXT }))

interface DraftExtraction {
  slotIndex: number | null
  customerName: string | null
  email: string | null
  phone: string | null
  notes: string | null
  attachmentUrl: string | null
}

async function extractDraftFields(state: BooklyStateType): Promise<DraftExtraction> {
  const slotList = state.availableSlots.map((s, i) => `${i}: ${s}`).join("\n")
  const transcript = state.messages.map((m) => `${m.role}: ${m.content}`).join("\n")

  const result = await invokeBilledCommerceLlm(state.chatbotId, [
    new HumanMessage(
      `From this conversation, extract what's known so far about an appointment the customer wants to book.\n\n` +
        `Available slots on ${state.checkedDate} (index: ISO time):\n${slotList || "(none)"}\n\n` +
        `Conversation:\n${transcript}\n\n` +
        `Respond with ONLY a JSON object, no other text, with these exact keys:\n` +
        `{"slotIndex": <number matching the list above, or null>, "customerName": <string or null>, "email": <string or null>, "phone": <string or null>, "notes": <any free-text note the customer volunteered, or null>, "attachmentUrl": <a URL the customer pasted/shared, or null>}`,
    ),
  ])

  try {
    const parsed = JSON.parse(String(result.content).trim().replace(/^```json\s*|```$/g, ""))
    return {
      slotIndex: typeof parsed.slotIndex === "number" ? parsed.slotIndex : null,
      customerName: typeof parsed.customerName === "string" ? parsed.customerName : null,
      email: typeof parsed.email === "string" ? parsed.email : null,
      phone: typeof parsed.phone === "string" ? parsed.phone : null,
      notes: typeof parsed.notes === "string" ? parsed.notes : null,
      attachmentUrl: typeof parsed.attachmentUrl === "string" ? parsed.attachmentUrl : null,
    }
  } catch {
    return { slotIndex: null, customerName: null, email: null, phone: null, notes: null, attachmentUrl: null }
  }
}


function mergeDraftExtraction(known: DraftExtraction, fresh: DraftExtraction, availableSlots: string[]): DraftExtraction {
  return {
    slotIndex: fresh.slotIndex !== null && availableSlots[fresh.slotIndex] ? fresh.slotIndex : known.slotIndex,
    customerName: fresh.customerName ?? known.customerName,
    email: fresh.email ?? known.email,
    phone: fresh.phone ?? known.phone,
    notes: fresh.notes ?? known.notes,
    attachmentUrl: fresh.attachmentUrl ?? known.attachmentUrl,
  }
}


async function buildBookingDraftNodeImpl(state: BooklyStateType): Promise<Partial<BooklyStateType>> {
  let known: DraftExtraction = await extractDraftFields(state)
  const localMessages: BooklyStateType["messages"] = []
  
  let timeAskedOnce = false

  while (true) {
    const missing: string[] = []
    const timeStillMissing = known.slotIndex === null || !state.availableSlots[known.slotIndex]
    if (timeStillMissing) missing.push("which time")
    if (!known.email) missing.push("an email address to send the confirmation to")
    if (!known.customerName) missing.push("a name for the booking")

    if (missing.length === 0) break

    let question: string
    if (timeStillMissing) {
      const times = formatSlotTimes(state.availableSlots)
      const otherMissing = missing.filter((m) => m !== "which time")
      const intro = timeAskedOnce ? "Sorry, that time isn't available — here's what's actually open:" : "Here's what's open that day:"
      question =
        `${intro} ${times} (UTC). Pick one of those, or tell me another time and I'll check it.` +
        (otherMissing.length > 0 ? ` Could you also tell me ${otherMissing.join(" and ")}?` : "")
    } else {
      question = `Could you tell me ${missing.join(" and ")}?`
    }
    if (timeStillMissing) timeAskedOnce = true

    const reply = interrupt<string, string>(question)
    localMessages.push({ role: "assistant", content: question }, { role: "user", content: reply })
    const extraction = await extractDraftFields({ ...state, messages: [...state.messages, ...localMessages] })
    known = mergeDraftExtraction(known, extraction, state.availableSlots)
  }

  const draft: BooklyDraft = {
    startTime: state.availableSlots[known.slotIndex as number],
    duration: DEFAULT_DURATION_MINUTES,
    customerName: known.customerName,
    customerEmail: known.email,
    customerPhone: known.phone,
    notes: known.notes,
    attachmentUrl: known.attachmentUrl,
  }

  log().info({ ...ctx(state), startTime: draft.startTime }, "bookly build_booking_draft complete")
  return { bookingDraft: draft, messages: localMessages }
}
// NEW-01: a denied usage reservation ends the turn politely (see billedLlm.ts).
export const buildBookingDraftNode = withLlmBudget(buildBookingDraftNodeImpl, (): Partial<BooklyStateType> => ({ bookingDraft: null, responseText: LLM_BUDGET_DENIED_TEXT }))

function formatDraftSummary(draft: BooklyDraft): string {
  const when = new Date(draft.startTime as string).toLocaleString([], { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })
  return `Here's your appointment: ${when} UTC, ${draft.duration} minutes, under the name ${draft.customerName}.\n\nShall I go ahead and book this? (yes/no)`
}

// Identical shape to commerce's confirmWithCustomerNode.
async function confirmWithCustomerNodeImpl(state: BooklyStateType): Promise<Partial<BooklyStateType>> {
  // NEW-01: build_booking_draft stopped on a denied usage reservation (it
  // clears the draft and sets the reply); end the turn with that reply.
  if (!state.bookingDraft) return {}
  const draft = state.bookingDraft as BooklyDraft
  const localMessages: BooklyStateType["messages"] = []
  let prompt = state.validationIssue ? `${state.validationIssue}\n\n${formatDraftSummary(draft)}` : formatDraftSummary(draft)

  while (true) {
    const reply = interrupt<string, string>(prompt)
    localMessages.push({ role: "assistant", content: prompt }, { role: "user", content: reply })

    const result = await invokeBilledCommerceLlm(state.chatbotId, [
      new HumanMessage(`Does this reply confirm booking the appointment? Reply with ONLY one word: yes, no, or unclear.\n\nReply: "${reply}"`),
    ])
    const verdict = String(result.content).trim().toLowerCase()

    if (verdict === "yes") {
      log().info(ctx(state), "bookly confirm_with_customer: confirmed")
      return { messages: localMessages, validationIssue: null, responseText: "confirmed" }
    }
    if (verdict === "no") {
      log().info(ctx(state), "bookly confirm_with_customer: declined")
      return { messages: localMessages, responseText: "No problem — let me know if you'd like to pick a different time." }
    }
    prompt = "Sorry, I didn't quite catch that — should I go ahead and book it? Please reply yes or no."
  }
}
// NEW-01: a denied usage reservation ends the turn politely (see billedLlm.ts).
export const confirmWithCustomerNode = withLlmBudget(confirmWithCustomerNodeImpl, (): Partial<BooklyStateType> => ({ responseText: LLM_BUDGET_DENIED_TEXT }))


export async function finalValidationNode(state: BooklyStateType): Promise<Partial<BooklyStateType>> {
  if (state.responseText !== "confirmed") return {}

  const draft = state.bookingDraft as BooklyDraft
  const date = (draft.startTime as string).slice(0, 10)
  let freshSlots: string[]
  try {
    freshSlots = await checkAvailabilityForChatbot(state.chatbotId, state.customerId, date, draft.duration, state.selectedResourceId ?? undefined)
  } catch {
    return { validationIssue: null } // fail open to commit_booking, which will surface a clean error if it's genuinely gone
  }

  if (!freshSlots.includes(draft.startTime as string)) {
    log().warn({ ...ctx(state), startTime: draft.startTime }, "bookly final_validation: slot no longer available")
    return { validationIssue: "That time was just taken.", availableSlots: freshSlots, bookingDraft: { ...draft, startTime: null } }
  }

  return { validationIssue: null }
}

// The ONLY node allowed to call commitBooking.
export async function commitBookingNode(state: BooklyStateType): Promise<Partial<BooklyStateType>> {
  const draft = state.bookingDraft as BooklyDraft
  const customer = await resolveCustomerIdentity(state.chatbotId, draft.customerEmail as string, draft.customerPhone)

  try {
    const result = await commitBooking({
      chatbotId: state.chatbotId,
      customerId: customer.id,
      startTime: draft.startTime as string,
      duration: draft.duration,
      customer: { name: draft.customerName || "Customer", email: draft.customerEmail as string, phone: draft.customerPhone },
      notes: draft.notes,
      attachmentUrl: draft.attachmentUrl,
      resourceId: state.selectedResourceId ?? undefined,
      idempotencyKey: state.graphRunId,
      requestId: state.requestId,
      graphRunId: state.graphRunId,
    })
    const joinUrl = result.googleMeetUrl || result.zoomJoinUrl
    const joinLine = joinUrl ? ` Join the meeting here: ${joinUrl}` : ""
    return {
      customerId: customer.id,
      committedAppointmentId: result.id,
      responseText: `You're booked! I've sent a confirmation to ${draft.customerEmail}.${joinLine}`,
    }
  } catch (err) {
    log().error({ ...ctx(state), err: err instanceof Error ? err.message : String(err) }, "bookly commit_booking failed")
    const message = err instanceof AppError ? err.message : "Sorry, something went wrong booking that. Please try again in a moment."
    return { customerId: customer.id, responseText: message }
  }
}

interface NoteExtraction {
  note: string | null
  attachmentUrl: string | null
 
  appointmentIdHint: string | null
}

async function extractNoteFields(state: BooklyStateType): Promise<NoteExtraction> {
  const transcript = state.messages.map((m) => `${m.role}: ${m.content}`).join("\n")
  const result = await invokeBilledCommerceLlm(state.chatbotId, [
    new HumanMessage(
      `From this conversation, extract what the customer wants attached to their existing appointment.\n\n` +
        `Conversation:\n${transcript}\n\n` +
        `Respond with ONLY a JSON object, no other text, with these exact keys:\n` +
        `{"note": <the free-text note/comment content, or null>, "attachmentUrl": <a URL they pasted/shared, or null>, "appointmentIdHint": <an appointment id or confirmation number they explicitly quoted, or null>}`,
    ),
  ])
  try {
    const parsed = JSON.parse(String(result.content).trim().replace(/^```json\s*|```$/g, ""))
    return {
      note: typeof parsed.note === "string" ? parsed.note : null,
      attachmentUrl: typeof parsed.attachmentUrl === "string" ? parsed.attachmentUrl : null,
      appointmentIdHint: typeof parsed.appointmentIdHint === "string" ? parsed.appointmentIdHint : null,
    }
  } catch {
    return { note: null, attachmentUrl: null, appointmentIdHint: null }
  }
}


async function addNoteNodeImpl(state: BooklyStateType): Promise<Partial<BooklyStateType>> {
  const customerId = requireVerifiedCustomer(state)
  if (!customerId) return { responseText: NOT_VERIFIED_TEXT }
  const customer = { id: customerId }
  const localMessages: BooklyStateType["messages"] = []

  let extraction = await extractNoteFields(state)
  while (!extraction.note && !extraction.attachmentUrl) {
    const question = "What would you like me to add to your appointment — a note, or a link to a document?"
    const reply = interrupt<string, string>(question)
    localMessages.push({ role: "assistant", content: question }, { role: "user", content: reply })
    extraction = await extractNoteFields({ ...state, messages: [...state.messages, ...localMessages] })
  }

 
  let appointmentId = extraction.appointmentIdHint
  if (!appointmentId) {
    const upcoming = await listBookingsForCustomer(state.chatbotId, customer.id)
    if (upcoming.length === 0) {
      return { customerId: customer.id, messages: localMessages, responseText: "I don't see any upcoming appointments under that email." }
    }
    appointmentId = upcoming[0].id
  }

  try {
    await addNoteToBooking(state.chatbotId, customer.id, appointmentId, { note: extraction.note, attachmentUrl: extraction.attachmentUrl })
    log().info({ ...ctx(state), appointmentId }, "bookly add_note complete")
    return { customerId: customer.id, messages: localMessages, responseText: "Got it — I've added that to your appointment." }
  } catch (err) {
    log().error({ ...ctx(state), appointmentId, err: err instanceof Error ? err.message : String(err) }, "bookly add_note failed")
    const message = err instanceof AppError ? err.message : "Sorry, I couldn't add that to your appointment right now. Please try again in a moment."
    return { customerId: customer.id, messages: localMessages, responseText: message }
  }
}
// NEW-01: a denied usage reservation ends the turn politely (see billedLlm.ts).
export const addNoteNode = withLlmBudget(addNoteNodeImpl, (): Partial<BooklyStateType> => ({ responseText: LLM_BUDGET_DENIED_TEXT }))


export async function appointmentStatusLookupNode(state: BooklyStateType): Promise<Partial<BooklyStateType>> {
  const customerId = requireVerifiedCustomer(state)
  if (!customerId) return { responseText: NOT_VERIFIED_TEXT }
  const customer = { id: customerId }
  const localMessages: BooklyStateType["messages"] = []
  const bookings = await listBookingsForCustomer(state.chatbotId, customer.id)

  if (bookings.length === 0) {
    return { customerId: customer.id, messages: localMessages, responseText: "I don't see any upcoming appointments under that email." }
  }
  const lines = bookings.map((b) => `- ${new Date(b.startTime).toLocaleString([], { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC`)
  return { customerId: customer.id, messages: localMessages, responseText: `Your upcoming appointments:\n${lines.join("\n")}` }
}

function formatWhen(startTime: string): string {
  return `${new Date(startTime).toLocaleString([], { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC`
}


function formatSlotTimes(slots: string[]): string {
  return slots.slice(0, 8).map((s) => new Date(s).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })).join(", ")
}


async function confirmYesNo(chatbotId: string, initialPrompt: string): Promise<{ messages: BooklyStateType["messages"]; confirmed: boolean }> {
  const localMessages: BooklyStateType["messages"] = []
  let prompt = initialPrompt
  while (true) {
    const reply = interrupt<string, string>(prompt)
    localMessages.push({ role: "assistant", content: prompt }, { role: "user", content: reply })
    const result = await invokeBilledCommerceLlm(chatbotId, [
      new HumanMessage(`Does this reply confirm the action? Reply with ONLY one word: yes, no, or unclear.\n\nReply: "${reply}"`),
    ])
    const verdict = String(result.content).trim().toLowerCase()
    if (verdict === "yes") return { messages: localMessages, confirmed: true }
    if (verdict === "no") return { messages: localMessages, confirmed: false }
    prompt = "Sorry, I didn't quite catch that — please reply yes or no."
  }
}


async function cancelAppointmentNodeImpl(state: BooklyStateType): Promise<Partial<BooklyStateType>> {
  const customerId = requireVerifiedCustomer(state)
  if (!customerId) return { responseText: NOT_VERIFIED_TEXT }
  const customer = { id: customerId }
  const localMessages: BooklyStateType["messages"] = []
  const upcoming = await listBookingsForCustomer(state.chatbotId, customer.id)
  if (upcoming.length === 0) {
    return { customerId: customer.id, messages: localMessages, responseText: "I don't see any upcoming appointments under that email." }
  }
  const target = upcoming[0]

  const { messages: confirmMessages, confirmed } = await confirmYesNo(
    state.chatbotId,
    `You'd like to cancel your appointment on ${formatWhen(target.startTime)} — is that right? (yes/no)`,
  )
  localMessages.push(...confirmMessages)

  if (!confirmed) {
    return { customerId: customer.id, messages: localMessages, responseText: "No problem — your appointment is still booked." }
  }

  try {
    await cancelBookingForCustomer(state.chatbotId, customer.id, target.id)
    log().info({ ...ctx(state), appointmentId: target.id }, "bookly cancel_appointment complete")
    return { customerId: customer.id, messages: localMessages, responseText: "Done — your appointment has been cancelled." }
  } catch (err) {
    log().error({ ...ctx(state), appointmentId: target.id, err: err instanceof Error ? err.message : String(err) }, "bookly cancel_appointment failed")
    const message = err instanceof AppError ? err.message : "Sorry, I couldn't cancel that appointment right now. Please try again in a moment."
    return { customerId: customer.id, messages: localMessages, responseText: message }
  }
}
// NEW-01: a denied usage reservation ends the turn politely (see billedLlm.ts).
export const cancelAppointmentNode = withLlmBudget(cancelAppointmentNodeImpl, (): Partial<BooklyStateType> => ({ responseText: LLM_BUDGET_DENIED_TEXT }))


async function rescheduleAppointmentNodeImpl(state: BooklyStateType): Promise<Partial<BooklyStateType>> {
  const customerId = requireVerifiedCustomer(state)
  if (!customerId) return { responseText: NOT_VERIFIED_TEXT }
  const customer = { id: customerId }
  const localMessages: BooklyStateType["messages"] = []
  const upcoming = await listBookingsForCustomer(state.chatbotId, customer.id)
  if (upcoming.length === 0) {
    return { customerId: customer.id, messages: localMessages, responseText: "I don't see any upcoming appointments under that email." }
  }
  const target = upcoming[0]

  let date = await extractDate(state)
  while (!date) {
    const question = "What date would you like to move it to?"
    const reply = interrupt<string, string>(question)
    localMessages.push({ role: "assistant", content: question }, { role: "user", content: reply })
    date = await extractDate({ ...state, messages: [...state.messages, ...localMessages] })
  }

  let slots: string[]
  try {
    slots = await checkAvailabilityForChatbot(state.chatbotId, customer.id, date, DEFAULT_DURATION_MINUTES, target.booklyResourceId)
  } catch (err) {
    log().error({ ...ctx(state), err: err instanceof Error ? err.message : String(err) }, "bookly reschedule_appointment: check_availability failed")
    const message = err instanceof AppError ? err.message : "Sorry, I couldn't check availability right now. Please try again in a moment."
    return { customerId: customer.id, messages: localMessages, responseText: message }
  }

  let known = await extractDraftFields({ ...state, checkedDate: date, availableSlots: slots, messages: [...state.messages, ...localMessages] })
  let rescheduleTimeAskedOnce = false
  while (known.slotIndex === null || !slots[known.slotIndex]) {
    const intro = rescheduleTimeAskedOnce ? "Sorry, that time isn't available — here's what's actually open:" : "Here's what's open that day:"
    const question = `${intro} ${formatSlotTimes(slots)} (UTC). Pick one of those, or tell me another time and I'll check it.`
    rescheduleTimeAskedOnce = true
    const reply = interrupt<string, string>(question)
    localMessages.push({ role: "assistant", content: question }, { role: "user", content: reply })
    const extraction = await extractDraftFields({ ...state, checkedDate: date, availableSlots: slots, messages: [...state.messages, ...localMessages] })
    known = mergeDraftExtraction(known, extraction, slots)
  }

  const newStartTime = slots[known.slotIndex as number]
  const { messages: confirmMessages, confirmed } = await confirmYesNo(state.chatbotId, `Move your appointment to ${formatWhen(newStartTime)} — shall I go ahead? (yes/no)`)
  localMessages.push(...confirmMessages)

  if (!confirmed) {
    return { customerId: customer.id, messages: localMessages, responseText: "No problem — your appointment is unchanged." }
  }

  try {
    await rescheduleBookingForCustomer(state.chatbotId, customer.id, target.id, { startTime: newStartTime, duration: DEFAULT_DURATION_MINUTES })
    log().info({ ...ctx(state), appointmentId: target.id, newStartTime }, "bookly reschedule_appointment complete")
    return { customerId: customer.id, messages: localMessages, responseText: `Done — your appointment is now ${formatWhen(newStartTime)}.` }
  } catch (err) {
    log().error({ ...ctx(state), appointmentId: target.id, err: err instanceof Error ? err.message : String(err) }, "bookly reschedule_appointment failed")
    const message = err instanceof AppError ? err.message : "Sorry, I couldn't reschedule that appointment right now. Please try again in a moment."
    return { customerId: customer.id, messages: localMessages, responseText: message }
  }
}
// NEW-01: a denied usage reservation ends the turn politely (see billedLlm.ts).
export const rescheduleAppointmentNode = withLlmBudget(rescheduleAppointmentNodeImpl, (): Partial<BooklyStateType> => ({ responseText: LLM_BUDGET_DENIED_TEXT }))


export async function pricingQuestionNode(state: BooklyStateType): Promise<Partial<BooklyStateType>> {
  try {
    const info = await getServiceInfoForChatbot(state.chatbotId, state.selectedResourceId ?? undefined)
    if (info.price_cents == null) {
      return {
        responseText: info.service_description
          ? info.service_description
          : "I don't have pricing details set up yet — please reach out to us directly for a quote.",
      }
    }
    const amount = (info.price_cents / 100).toFixed(2)
    const priceLine = `${info.name} costs ${amount} ${info.price_currency}.`
    return { responseText: info.service_description ? `${priceLine} ${info.service_description}` : priceLine }
  } catch (err) {
    log().error({ ...ctx(state), err: err instanceof Error ? err.message : String(err) }, "bookly pricing_question failed")
    const message = err instanceof AppError ? err.message : "Sorry, I couldn't look up pricing right now. Please try again in a moment."
    return { responseText: message }
  }
}


async function offerWaitlistNodeImpl(state: BooklyStateType): Promise<Partial<BooklyStateType>> {
  const { messages: confirmMessages, confirmed } = await confirmYesNo(
    state.chatbotId,
    `Sorry, there's nothing open on ${state.checkedDate}. Would you like me to notify you if a slot opens up? (yes/no)`,
  )
  const localMessages = [...confirmMessages]

  if (!confirmed) {
    return { messages: localMessages, responseText: "No problem — let me know if you'd like to try a different date." }
  }

  let known = await extractDraftFields({ ...state, messages: [...state.messages, ...localMessages] })
  while (!known.customerName || !known.email) {
    const missing = [!known.customerName ? "a name" : null, !known.email ? "an email address" : null].filter(Boolean).join(" and ")
    const question = `Sure — could you give me ${missing} to notify you with?`
    const reply = interrupt<string, string>(question)
    localMessages.push({ role: "assistant", content: question }, { role: "user", content: reply })
    const extraction = await extractDraftFields({ ...state, messages: [...state.messages, ...localMessages] })
    known = mergeDraftExtraction(known, extraction, state.availableSlots)
  }

  try {
    const customer = await resolveCustomerIdentity(state.chatbotId, known.email)
    await joinWaitlistForChatbot(state.chatbotId, customer.id, {
      customerName: known.customerName,
      customerEmail: known.email,
      requestedDate: state.checkedDate as string,
      resourceId: state.selectedResourceId ?? undefined,
    })
    log().info({ ...ctx(state), customerId: customer.id, date: state.checkedDate }, "bookly waitlist join complete")
    return { customerId: customer.id, messages: localMessages, responseText: "Done — I'll let you know if a slot opens up on that date." }
  } catch (err) {
    log().error({ ...ctx(state), err: err instanceof Error ? err.message : String(err) }, "bookly waitlist join failed")
    const message = err instanceof AppError ? err.message : "Sorry, I couldn't add you to the waitlist right now. Please try again in a moment."
    return { messages: localMessages, responseText: message }
  }
}
// NEW-01: a denied usage reservation ends the turn politely (see billedLlm.ts).
export const offerWaitlistNode = withLlmBudget(offerWaitlistNodeImpl, (): Partial<BooklyStateType> => ({ responseText: LLM_BUDGET_DENIED_TEXT }))
