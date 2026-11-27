import { Annotation, interrupt, type LangGraphRunnableConfig } from "@langchain/langgraph"

import { log } from "../lib/logger.js"
import {
  confirmChatEmailVerification,
  extractVerificationCode,
  normalizeEmail,
  startChatEmailVerification,
  verifiedCustomerFromSessionToken,
  type ConfirmOutcome,
} from "../services/customerVerification.service.js"

/**
 * CS-04 (VER-02): shared "prove you own this email" step for the public
 * Bookly and commerce graphs. Any node that reads or changes an existing
 * customer's bookings/orders/notifications sits behind
 *   identify_customer -> verify_code (loops) -> <operation>
 * and the operation reads the customer id ONLY from verifiedCustomerId, which
 * nothing but a successful OTP check (or a valid signed customer session
 * token handed in by the entrypoint) ever sets — and only for the chatbot
 * recorded alongside it in verifiedChatbotId.
 *
 * The code itself never enters graph state or checkpoint writes: while the
 * graph is paused in verify_code, the entrypoint checks the visitor's reply
 * (prepareResumeValue) and resumes the graph with the OUTCOME object only.
 * A plain string resume (anything a visitor typed) is never treated as a
 * verification result.
 *
 * Replay safety: LangGraph re-runs a node from the top on every resume, so
 * the only side effect in identify_customer (sending the code) comes after
 * its last interrupt, and verify_code does one interrupt per execution.
 */

/** How long one successful verification unlocks this conversation. */
export const VERIFIED_SESSION_TTL_MS = 30 * 60 * 1000
/** Wrong or malformed code replies allowed per code before the flow stops. */
export const MAX_CODE_ATTEMPTS = 3

export const ASK_EMAIL_PROMPT = "Sure — what email address is it under?"
export const CODE_SENT_PROMPT =
  "To keep your details private, I've sent a 6-digit verification code to that email address. Please type the code here to continue."
export const CODE_COOLDOWN_PROMPT =
  "A verification code was already sent to that email address in the last minute. Please type that 6-digit code here, or wait a minute and ask me again for a new one."
export const CODE_RETRY_PROMPT = "That code didn't match. Please check the latest email from us and type the 6-digit code again."
export const CODE_FAILED_TEXT =
  "Sorry, I couldn't verify that email address. Ask me again whenever you're ready and I'll send a new code."
export const CODE_LIMITED_TEXT = "Too many verification attempts for now. Please wait a few minutes and try again."
export const CODE_SEND_FAILED_TEXT = "Sorry, I couldn't send a verification code right now. Please try again in a few minutes."

/** State channels every graph that uses this step must declare. */
export const customerVerificationChannels = {
  verifiedCustomerId: Annotation<string | null>({ reducer: (_prev, next) => next, default: () => null }),
  verifiedChatbotId: Annotation<string | null>({ reducer: (_prev, next) => next, default: () => null }),
  verifiedEmail: Annotation<string | null>({ reducer: (_prev, next) => next, default: () => null }),
  verifiedAt: Annotation<number | null>({ reducer: (_prev, next) => next, default: () => null }),
  pendingVerificationEmail: Annotation<string | null>({ reducer: (_prev, next) => next, default: () => null }),
  verificationPrompt: Annotation<string | null>({ reducer: (_prev, next) => next, default: () => null }),
  verificationAttempts: Annotation<number>({ reducer: (_prev, next) => next, default: () => 0 }),
}

type VerifiedFields = {
  chatbotId: string
  verifiedCustomerId: string | null
  verifiedChatbotId: string | null
  verifiedEmail: string | null
  verifiedAt: number | null
}

interface VerificationState extends VerifiedFields {
  requestId?: string
  graphRunId: string
  messages: { role: "user" | "assistant"; content: string }[]
  pendingVerificationEmail: string | null
  verificationPrompt: string | null
  verificationAttempts: number
}

type VerificationUpdate = Partial<
  Pick<
    VerificationState,
    | "verifiedCustomerId"
    | "verifiedChatbotId"
    | "verifiedEmail"
    | "verifiedAt"
    | "pendingVerificationEmail"
    | "verificationPrompt"
    | "verificationAttempts"
    | "messages"
  >
> & { customerId?: string | null; responseText?: string | null }

/** The only shape verify_code accepts as a verification result. */
export interface OtpResumeValue {
  kind: "otp_result"
  outcome: ConfirmOutcome | { status: "no_code" }
}

function isOtpResumeValue(value: unknown): value is OtpResumeValue {
  return Boolean(value && typeof value === "object" && (value as { kind?: unknown }).kind === "otp_result")
}

export function extractEmail(text: string): string | null {
  return text.match(/[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}/)?.[0] ?? null
}

function logCtx(state: VerificationState) {
  return { requestId: state.requestId, graphRunId: state.graphRunId, chatbotId: state.chatbotId }
}

function threadIdOf(config: LangGraphRunnableConfig | undefined, state: VerificationState): string {
  const threadId = config?.configurable?.thread_id
  return typeof threadId === "string" && threadId ? threadId : `run:${state.graphRunId}`
}

/** True when this conversation holds a still-fresh verification for THIS chatbot (optionally for a specific email). */
export function hasFreshVerification(state: VerifiedFields, email?: string | null): boolean {
  if (!state.verifiedCustomerId || !state.verifiedEmail || !state.verifiedAt) return false
  if (!state.verifiedChatbotId || state.verifiedChatbotId !== state.chatbotId) return false
  if (Date.now() - state.verifiedAt > VERIFIED_SESSION_TTL_MS) return false
  if (email && normalizeEmail(email) !== state.verifiedEmail) return false
  return true
}

/** The verified customer id for an operation node, or null when there isn't one. */
export function verifiedCustomerIdFor(state: VerifiedFields): string | null {
  return hasFreshVerification(state) ? state.verifiedCustomerId : null
}

const CLEARED = { verifiedCustomerId: null, verifiedChatbotId: null, verifiedEmail: null, verifiedAt: null } as const

export async function identifyCustomerNode(state: VerificationState, config?: LangGraphRunnableConfig): Promise<VerificationUpdate> {
  const latest = state.messages[state.messages.length - 1]?.content ?? ""
  const localMessages: VerificationState["messages"] = []

  let email = extractEmail(latest)
  if (!email && hasFreshVerification(state)) {
    return { pendingVerificationEmail: null, verificationPrompt: null, verificationAttempts: 0, responseText: null }
  }
  while (!email) {
    const reply = interrupt<string, unknown>(ASK_EMAIL_PROMPT)
    const text = typeof reply === "string" ? reply : ""
    localMessages.push({ role: "assistant", content: ASK_EMAIL_PROMPT }, { role: "user", content: text })
    email = extractEmail(text)
  }

  if (hasFreshVerification(state, email)) {
    return { messages: localMessages, pendingVerificationEmail: null, verificationPrompt: null, verificationAttempts: 0, responseText: null }
  }

  const normalized = normalizeEmail(email)
  // Last await before returning: never re-run on a resume of this node.
  const outcome = await startChatEmailVerification(state.chatbotId, normalized, threadIdOf(config, state), logCtx(state))
  log().info({ ...logCtx(state), outcome }, "identify_customer: verification code requested")
  if (outcome === "limited" || outcome === "failed") {
    return {
      ...CLEARED,
      messages: localMessages,
      pendingVerificationEmail: null,
      verificationPrompt: null,
      verificationAttempts: 0,
      responseText: outcome === "limited" ? CODE_LIMITED_TEXT : CODE_SEND_FAILED_TEXT,
    }
  }
  return {
    ...CLEARED,
    messages: localMessages,
    pendingVerificationEmail: normalized,
    verificationPrompt: outcome === "cooldown" ? CODE_COOLDOWN_PROMPT : CODE_SENT_PROMPT,
    verificationAttempts: 0,
    responseText: null,
  }
}

export async function verifyCodeNode(state: VerificationState): Promise<VerificationUpdate> {
  const email = state.pendingVerificationEmail
  if (!email) return {}

  const prompt = state.verificationAttempts === 0 ? (state.verificationPrompt ?? CODE_SENT_PROMPT) : CODE_RETRY_PROMPT
  const resumed = interrupt<string, unknown>(prompt)
  // The code itself never goes into the transcript or state.
  const messages: VerificationState["messages"] = [
    { role: "assistant", content: prompt },
    { role: "user", content: "[verification code entered]" },
  ]

  // Only the entrypoint can produce an object resume; a typed string is never a result.
  const outcome = isOtpResumeValue(resumed) ? resumed.outcome : ({ status: "no_code" } as const)

  if (outcome.status === "verified") {
    log().info({ ...logCtx(state), customerId: outcome.customerId }, "verify_code: email ownership verified")
    return {
      messages,
      verifiedCustomerId: outcome.customerId,
      verifiedChatbotId: state.chatbotId,
      verifiedEmail: email,
      verifiedAt: Date.now(),
      customerId: outcome.customerId,
      pendingVerificationEmail: null,
      verificationPrompt: null,
      verificationAttempts: 0,
    }
  }
  if (outcome.status === "limited") {
    return { messages, pendingVerificationEmail: null, verificationPrompt: null, verificationAttempts: 0, responseText: CODE_LIMITED_TEXT }
  }

  const attempts = state.verificationAttempts + 1
  if (attempts >= MAX_CODE_ATTEMPTS) {
    log().warn(logCtx(state), "verify_code: too many failed attempts, giving up")
    return { messages, pendingVerificationEmail: null, verificationPrompt: null, verificationAttempts: 0, responseText: CODE_FAILED_TEXT }
  }
  return { messages, verificationAttempts: attempts }
}

/** Router after identify_customer / verify_code. */
export function routeAfterVerification(state: VerificationState, operationNode: string, end: string): string {
  if (state.pendingVerificationEmail) return "verify_code"
  return hasFreshVerification(state) ? operationNode : end
}

/**
 * Entry-point helper: what to resume a paused graph with. When the graph is
 * waiting in verify_code, the visitor's reply is checked HERE and only the
 * outcome is handed to the graph (so the code is never checkpointed);
 * otherwise the reply is passed through unchanged.
 */
export async function prepareResumeValue(
  snapshot: { next: readonly string[]; values: Partial<VerificationState> },
  chatbotId: string,
  threadId: string,
  reply: string,
): Promise<string | OtpResumeValue> {
  if (!snapshot.next.includes("verify_code")) return reply
  const email = snapshot.values.pendingVerificationEmail
  const code = extractVerificationCode(reply)
  if (!email || !code) return { kind: "otp_result", outcome: { status: "no_code" } }
  const outcome = await confirmChatEmailVerification(chatbotId, email, code, threadId, { chatbotId, threadId })
  return { kind: "otp_result", outcome }
}

/**
 * Entry-point helper: seeds the conversation's verified identity from a valid
 * signed customer token. Nothing is seeded (so OTP is required) when the
 * token is missing, forged, expired or for another chatbot.
 */
export async function verificationFromCustomerToken(chatbotId: string, customerToken: string | undefined): Promise<Partial<VerifiedFields>> {
  const verified = await verifiedCustomerFromSessionToken(chatbotId, customerToken)
  if (!verified) return {}
  return { verifiedCustomerId: verified.customerId, verifiedChatbotId: chatbotId, verifiedEmail: verified.email, verifiedAt: Date.now() }
}

/** The verified customer of a stored thread, if any (used by the attachment upload path). */
export function verifiedCustomerFromThreadValues(values: Partial<VerifiedFields> | undefined, chatbotId: string): string | null {
  if (!values) return null
  return verifiedCustomerIdFor({
    chatbotId,
    verifiedCustomerId: values.verifiedCustomerId ?? null,
    verifiedChatbotId: values.verifiedChatbotId ?? null,
    verifiedEmail: values.verifiedEmail ?? null,
    verifiedAt: values.verifiedAt ?? null,
  })
}
