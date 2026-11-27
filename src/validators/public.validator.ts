import { z } from "zod"

const chatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(4000),
})

export const publicChatSchema = z.object({
  message: z.string().trim().min(1).max(2000),
  history: z.array(chatMessageSchema).max(20).default([]),

  // Legacy: a client-chosen id. Accepted so older widgets don't 400, but it
  // is never used as a session key — it only asks the server to start a
  // session (CS-04). The response's sessionToken is what continues it.
  sessionId: z.string().trim().min(1).max(200).optional(),
  // CS-04: server-issued, chatbot-bound session token from a previous chat
  // response. Invalid/foreign/expired tokens start a new session.
  sessionToken: z.string().min(1).max(4096).optional(),
  // The customerToken returned by POST /auth/otp/verify once a visitor has
  // proved control of their email. It enables cross-session memory
  // (session_summaries). A bare customerId is not accepted for this: anyone
  // who saw the id could otherwise read that customer's memory through the bot.
  // Anonymous visitors send nothing and get no cross-visit memory.
  customerToken: z.string().min(1).max(4096).optional(),
})

export type PublicChatInput = z.infer<typeof publicChatSchema>

// WP-3.4 privacy controls. Export and erasure need a fresh OTP proofToken
// (POST /auth/otp/verify, purpose ORDER_ACCESS or SENSITIVE_ACTION) issued for
// this chatbot. The customer is taken from the token, never from the body, so
// a visitor can only reach their own memory, and only after re-proving
// control of the email it is keyed on.
export const customerMemoryRequestSchema = z.object({
  proofToken: z.string().min(1).max(4096),
})

export type CustomerMemoryRequestInput = z.infer<typeof customerMemoryRequestSchema>
