
import { interrupt, type LangGraphRunnableConfig } from "@langchain/langgraph"
import { HumanMessage } from "@langchain/core/messages"

import { log } from "../lib/logger.js"
import { outboundFetch } from "../lib/outboundFetch.js"
import { AppError } from "../lib/errors.js"
import { hasCommerceLlm } from "./llm.js"
import { invokeBilledCommerceLlm, LLM_BUDGET_DENIED_TEXT, withLlmBudget } from "./billedLlm.js"
import {
  createResourceAsAdmin,
  setAvailabilityRuleAsAdmin,
  addExceptionAsAdmin,
  reassignAppointmentAsAdmin,
  type AdminToolContext,
} from "../services/booklyAdmin.service.js"
import { getBooklyBaseUrl } from "../services/booklyCredentials.service.js"
import type { AdminAction, AdminActionDraft, BooklyAdminStateType } from "./booklyAdminState.js"

function ctx(state: BooklyAdminStateType) {
  return { requestId: state.requestId, graphRunId: state.graphRunId, chatbotId: state.chatbotId, adminId: state.adminId }
}

const ADMIN_INTENTS = ["create_resource", "set_availability_rule", "add_exception", "reassign_appointment", "other"] as const

async function classifyAdminIntentNodeImpl(state: BooklyAdminStateType): Promise<Partial<BooklyAdminStateType>> {
  const latest = state.messages[state.messages.length - 1]?.content ?? ""
  const transcript = state.messages.slice(-6).map((m) => `${m.role}: ${m.content}`).join("\n")

  if (!hasCommerceLlm()) {
    return { intent: "other", responseText: "Sorry, the admin assistant isn't fully configured right now." }
  }

  const result = await invokeBilledCommerceLlm(state.chatbotId, [
    new HumanMessage(
      `You are an internal admin assistant for a scheduling business. Classify the admin's LATEST message into exactly one category: create_resource, set_availability_rule, add_exception, reassign_appointment, or other.\n\n` +
        `- create_resource: wants to create a new bookable resource (a room, a person, a service)\n` +
        `- set_availability_rule: wants to set/change weekly working hours for an existing resource\n` +
        `- add_exception: wants to close a resource (or mark it open) on a specific date\n` +
        `- reassign_appointment: wants to move/reassign an existing customer's booking to a different resource/staff member, or override who it's assigned to\n` +
        `- other: anything else (greetings, questions, a reply that's part of an in-progress request like "yes" or a resource name)\n\n` +
        `Conversation so far:\n${transcript}\n\nLatest message: "${latest}"\n\nRespond with ONLY the single category word.`,
    ),
  ])
  const raw = String(result.content).trim().toLowerCase()
  const intent = (ADMIN_INTENTS as readonly string[]).includes(raw) ? (raw as (typeof ADMIN_INTENTS)[number]) : "other"
  log().info({ ...ctx(state), intent }, "bookly admin classify_intent")
  return { intent }
}
// NEW-01: a denied usage reservation ends the turn politely (see billedLlm.ts).
export const classifyAdminIntentNode = withLlmBudget(classifyAdminIntentNodeImpl, (): Partial<BooklyAdminStateType> => ({ intent: "other", responseText: LLM_BUDGET_DENIED_TEXT }))

interface ResourceDraftExtraction {
  name: string | null
  timezone: string | null
  slotDurationMinutes: number | null
}

async function extractResourceDraft(state: BooklyAdminStateType): Promise<ResourceDraftExtraction> {
  const transcript = state.messages.map((m) => `${m.role}: ${m.content}`).join("\n")
  const result = await invokeBilledCommerceLlm(state.chatbotId, [
    new HumanMessage(
      `From this conversation, extract what's known about a new resource to create.\n\nConversation:\n${transcript}\n\n` +
        `Respond with ONLY JSON: {"name": <string or null>, "timezone": <IANA timezone string or null>, "slotDurationMinutes": <number or null>}`,
    ),
  ])
  try {
    const parsed = JSON.parse(String(result.content).trim().replace(/^```json\s*|```$/g, ""))
    return {
      name: typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : null,
      timezone: typeof parsed.timezone === "string" ? parsed.timezone : null,
      slotDurationMinutes: typeof parsed.slotDurationMinutes === "number" ? parsed.slotDurationMinutes : null,
    }
  } catch {
    return { name: null, timezone: null, slotDurationMinutes: null }
  }
}

interface AvailabilityDraftExtraction {
  resourceName: string | null
  dayOfWeek: number | null
  startTime: string | null
  endTime: string | null
}

async function extractAvailabilityDraft(state: BooklyAdminStateType): Promise<AvailabilityDraftExtraction> {
  const transcript = state.messages.map((m) => `${m.role}: ${m.content}`).join("\n")
  const result = await invokeBilledCommerceLlm(state.chatbotId, [
    new HumanMessage(
      `From this conversation, extract a weekly availability rule to set.\n\nConversation:\n${transcript}\n\n` +
        `Respond with ONLY JSON: {"resourceName": <string or null>, "dayOfWeek": <0-6, 0=Sunday, or null>, "startTime": <"HH:MM" or null>, "endTime": <"HH:MM" or null>}`,
    ),
  ])
  try {
    const parsed = JSON.parse(String(result.content).trim().replace(/^```json\s*|```$/g, ""))
    return {
      resourceName: typeof parsed.resourceName === "string" && parsed.resourceName.trim() ? parsed.resourceName.trim() : null,
      dayOfWeek: typeof parsed.dayOfWeek === "number" ? parsed.dayOfWeek : null,
      startTime: typeof parsed.startTime === "string" ? parsed.startTime : null,
      endTime: typeof parsed.endTime === "string" ? parsed.endTime : null,
    }
  } catch {
    return { resourceName: null, dayOfWeek: null, startTime: null, endTime: null }
  }
}

interface ExceptionDraftExtraction {
  resourceName: string | null
  date: string | null
  isClosed: boolean | null
  reason: string | null
}

async function extractExceptionDraft(state: BooklyAdminStateType): Promise<ExceptionDraftExtraction> {
  const transcript = state.messages.map((m) => `${m.role}: ${m.content}`).join("\n")
  const result = await invokeBilledCommerceLlm(state.chatbotId, [
    new HumanMessage(
      `From this conversation, extract a one-off schedule exception (closing or opening a resource on a specific date).\n\nConversation:\n${transcript}\n\n` +
        `Respond with ONLY JSON: {"resourceName": <string or null>, "date": <"YYYY-MM-DD" or null>, "isClosed": <true, false, or null>, "reason": <string or null>}`,
    ),
  ])
  try {
    const parsed = JSON.parse(String(result.content).trim().replace(/^```json\s*|```$/g, ""))
    return {
      resourceName: typeof parsed.resourceName === "string" && parsed.resourceName.trim() ? parsed.resourceName.trim() : null,
      date: typeof parsed.date === "string" ? parsed.date : null,
      isClosed: typeof parsed.isClosed === "boolean" ? parsed.isClosed : null,
      reason: typeof parsed.reason === "string" ? parsed.reason : null,
    }
  } catch {
    return { resourceName: null, date: null, isClosed: null, reason: null }
  }
}

interface ReassignmentDraftExtraction {
  customerEmail: string | null
  targetResourceName: string | null
}

async function extractReassignmentDraft(state: BooklyAdminStateType): Promise<ReassignmentDraftExtraction> {
  const transcript = state.messages.map((m) => `${m.role}: ${m.content}`).join("\n")
  const result = await invokeBilledCommerceLlm(state.chatbotId, [
    new HumanMessage(
      `From this conversation, extract which customer's booking should be reassigned and to which resource/staff member.\n\nConversation:\n${transcript}\n\n` +
        `Respond with ONLY JSON: {"customerEmail": <string or null>, "targetResourceName": <string or null>}`,
    ),
  ])
  try {
    const parsed = JSON.parse(String(result.content).trim().replace(/^```json\s*|```$/g, ""))
    return {
      customerEmail: typeof parsed.customerEmail === "string" && parsed.customerEmail.trim() ? parsed.customerEmail.trim() : null,
      targetResourceName: typeof parsed.targetResourceName === "string" && parsed.targetResourceName.trim() ? parsed.targetResourceName.trim() : null,
    }
  } catch {
    return { customerEmail: null, targetResourceName: null }
  }
}


async function buildActionDraftNodeImpl(state: BooklyAdminStateType): Promise<Partial<BooklyAdminStateType>> {
  const action = state.intent as AdminAction
  const localMessages: BooklyAdminStateType["messages"] = []

  if (action === "create_resource") {
    let extraction = await extractResourceDraft(state)
    while (!extraction.name) {
      const question = "What should the new resource be called?"
      const reply = interrupt<string, string>(question)
      localMessages.push({ role: "assistant", content: question }, { role: "user", content: reply })
      extraction = await extractResourceDraft({ ...state, messages: [...state.messages, ...localMessages] })
    }
    const draft: AdminActionDraft = {
      action,
      params: { name: extraction.name, timezone: extraction.timezone ?? "UTC", slot_duration_minutes: extraction.slotDurationMinutes ?? 30 },
    }
    return { draft, messages: localMessages }
  }

  if (action === "set_availability_rule") {
    let extraction = await extractAvailabilityDraft(state)
    while (true) {
      const missing: string[] = []
      if (!extraction.resourceName) missing.push("which resource")
      if (extraction.dayOfWeek === null) missing.push("which day of the week")
      if (!extraction.startTime) missing.push("the start time")
      if (!extraction.endTime) missing.push("the end time")
      if (missing.length === 0) break
      const question = `Could you tell me ${missing.join(" and ")}?`
      const reply = interrupt<string, string>(question)
      localMessages.push({ role: "assistant", content: question }, { role: "user", content: reply })
      extraction = await extractAvailabilityDraft({ ...state, messages: [...state.messages, ...localMessages] })
    }
    const draft: AdminActionDraft = {
      action,
      params: { resourceName: extraction.resourceName, day_of_week: extraction.dayOfWeek, start_time: extraction.startTime, end_time: extraction.endTime },
    }
    return { draft, messages: localMessages }
  }

  if (action === "add_exception") {
    let extraction = await extractExceptionDraft(state)
    while (true) {
      const missing: string[] = []
      if (!extraction.resourceName) missing.push("which resource")
      if (!extraction.date) missing.push("which date")
      if (missing.length === 0) break
      const question = `Could you tell me ${missing.join(" and ")}?`
      const reply = interrupt<string, string>(question)
      localMessages.push({ role: "assistant", content: question }, { role: "user", content: reply })
      extraction = await extractExceptionDraft({ ...state, messages: [...state.messages, ...localMessages] })
    }
    const draft: AdminActionDraft = {
      action: "add_exception",
      params: { resourceName: extraction.resourceName, date: extraction.date, is_closed: extraction.isClosed ?? true, reason: extraction.reason },
    }
    return { draft, messages: localMessages }
  }

  // reassign_appointment
  let extraction = await extractReassignmentDraft(state)
  while (true) {
    const missing: string[] = []
    if (!extraction.customerEmail) missing.push("the customer's email")
    if (!extraction.targetResourceName) missing.push("which resource/staff member to move it to")
    if (missing.length === 0) break
    const question = `Could you tell me ${missing.join(" and ")}?`
    const reply = interrupt<string, string>(question)
    localMessages.push({ role: "assistant", content: question }, { role: "user", content: reply })
    extraction = await extractReassignmentDraft({ ...state, messages: [...state.messages, ...localMessages] })
  }
  const draft: AdminActionDraft = {
    action: "reassign_appointment",
    params: { customerEmail: extraction.customerEmail, targetResourceName: extraction.targetResourceName },
  }
  return { draft, messages: localMessages }
}
// NEW-01: a denied usage reservation ends the turn politely (see billedLlm.ts).
export const buildActionDraftNode = withLlmBudget(buildActionDraftNodeImpl, (): Partial<BooklyAdminStateType> => ({ draft: null, responseText: LLM_BUDGET_DENIED_TEXT }))

function describeAction(draft: AdminActionDraft): string {
  switch (draft.action) {
    case "create_resource":
      return `create a new bookable resource named "${draft.params.name}" (timezone ${draft.params.timezone}, ${draft.params.slot_duration_minutes}-minute slots) — visible to customers immediately`
    case "set_availability_rule":
      return `set "${draft.params.resourceName}"'s hours on day ${draft.params.day_of_week} to ${draft.params.start_time}–${draft.params.end_time}`
    case "add_exception":
      return `mark "${draft.params.resourceName}" as ${draft.params.is_closed === false ? "OPEN" : "CLOSED"} on ${draft.params.date}${draft.params.reason ? ` (${draft.params.reason})` : ""}`
    case "reassign_appointment":
      return `reassign ${draft.params.customerEmail}'s appointment to "${draft.params.targetResourceName}" — the previously-assigned staff member's calendar will change`
  }
}

// The unconditional confirmation gate — see this file's header comment.
async function confirmAdminActionNodeImpl(state: BooklyAdminStateType): Promise<Partial<BooklyAdminStateType>> {
  // NEW-01: build_action_draft stopped on a denied usage reservation (it clears
  // the draft and sets the reply); end the turn with that reply.
  if (!state.draft) return {}
  const draft = state.draft as AdminActionDraft
  const localMessages: BooklyAdminStateType["messages"] = []
  let prompt = `This will ${describeAction(draft)}. Shall I proceed? (yes/no)`

  while (true) {
    const reply = interrupt<string, string>(prompt)
    localMessages.push({ role: "assistant", content: prompt }, { role: "user", content: reply })

    const result = await invokeBilledCommerceLlm(state.chatbotId, [new HumanMessage(`Does this reply confirm proceeding? Reply with ONLY one word: yes, no, or unclear.\n\nReply: "${reply}"`)])
    const verdict = String(result.content).trim().toLowerCase()

    if (verdict === "yes") {
      log().info(ctx(state), "bookly admin confirm: confirmed")
      return { messages: localMessages, responseText: "confirmed" }
    }
    if (verdict === "no") {
      log().info(ctx(state), "bookly admin confirm: declined")
      return { messages: localMessages, responseText: "No problem — nothing was changed." }
    }
    prompt = "Sorry, I didn't quite catch that — should I go ahead? Please reply yes or no."
  }
}
// NEW-01: a denied usage reservation ends the turn politely (see billedLlm.ts).
export const confirmAdminActionNode = withLlmBudget(confirmAdminActionNodeImpl, (): Partial<BooklyAdminStateType> => ({ responseText: LLM_BUDGET_DENIED_TEXT }))


async function findResourceIdByName(baseUrl: string, name: string): Promise<string | null> {
  // baseUrl is tenant-configured, so this goes through the same SSRF guard as
  // every other Bookly call (it previously used a bare fetch with no check).
  let listRes: Response
  try {
    listRes = await outboundFetch(new URL(`${baseUrl}/resources`), { signal: AbortSignal.timeout(10_000) })
  } catch (err) {
    log().warn({ err: err instanceof Error ? err.message : String(err) }, "bookly resource lookup failed or was blocked")
    return null
  }
  if (!listRes.ok) return null
  const resources = (await listRes.json()) as { id: string; name: string }[]
  const match = resources.find((r) => r.name.trim().toLowerCase() === name.trim().toLowerCase())
  return match?.id ?? null
}


export async function executeAdminActionNode(state: BooklyAdminStateType, config: LangGraphRunnableConfig): Promise<Partial<BooklyAdminStateType>> {
  if (state.responseText !== "confirmed") return {}

  const token = config.configurable?.booklyAdminToken as string | undefined
  if (!token) {
    log().error(ctx(state), "bookly admin execute: no token on config — this should never happen, refusing to proceed")
    return { responseText: "Sorry, your session could not be verified. Please try again." }
  }

  const draft = state.draft as AdminActionDraft
  const toolCtx: AdminToolContext = {
    chatbotId: state.chatbotId,
    admin: { id: state.adminId, email: state.adminEmail, name: state.adminEmail },
    token,
    conversationId: config.configurable?.thread_id as string,
    requestId: state.requestId,
  }

  try {
    if (draft.action === "create_resource") {
      const resource = await createResourceAsAdmin(toolCtx, {
        name: draft.params.name as string,
        timezone: draft.params.timezone as string,
        slot_duration_minutes: draft.params.slot_duration_minutes as number,
      })
      return { executedTargetId: resource.id, responseText: `Done — "${resource.name}" has been created and is bookable now.` }
    }

    if (draft.action === "reassign_appointment") {
      const baseUrl = (await getBooklyBaseUrl(state.chatbotId)) as string
      const targetResourceId = await findResourceIdByName(baseUrl, draft.params.targetResourceName as string)
      if (!targetResourceId) {
        return { responseText: `I couldn't find a resource named "${draft.params.targetResourceName}". Nothing was changed.` }
      }
      await reassignAppointmentAsAdmin(toolCtx, draft.params.customerEmail as string, targetResourceId)
      return { executedTargetId: targetResourceId, responseText: `Done — that appointment has been reassigned to "${draft.params.targetResourceName}".` }
    }

    const baseUrl = (await getBooklyBaseUrl(state.chatbotId)) as string
    const resourceId = await findResourceIdByName(baseUrl, draft.params.resourceName as string)
    if (!resourceId) {
      return { responseText: `I couldn't find a resource named "${draft.params.resourceName}". Nothing was changed.` }
    }

    if (draft.action === "set_availability_rule") {
      await setAvailabilityRuleAsAdmin(toolCtx, resourceId, {
        day_of_week: draft.params.day_of_week as number,
        start_time: draft.params.start_time as string,
        end_time: draft.params.end_time as string,
      })
      return { executedTargetId: resourceId, responseText: "Done — those hours are set." }
    }

    await addExceptionAsAdmin(toolCtx, resourceId, {
      date: draft.params.date as string,
      is_closed: draft.params.is_closed as boolean,
      reason: (draft.params.reason as string | null) ?? null,
    })
    return { executedTargetId: resourceId, responseText: "Done — that date has been updated." }
  } catch (err) {
    log().error({ ...ctx(state), err: err instanceof Error ? err.message : String(err) }, "bookly admin execute failed")
    const message = err instanceof AppError ? err.message : "Sorry, something went wrong making that change. Please try again."
    return { responseText: message }
  }
}
