import { randomBytes } from "node:crypto"

import jwt from "jsonwebtoken"

import { env } from "../env.js"

/**
 * CS-04 (B04-002, S3-021, B06-021): server-issued chat sessions.
 *
 * The widget used to name its own session (a client-chosen string) and that
 * string was used directly as the conversation key and the LangGraph
 * thread_id — shared across chatbots and with the dashboard preview — so
 * anyone who knew or guessed it inherited the conversation, including an
 * already-verified customer identity. Now the server mints the session id
 * (128 random bits) and hands the widget a signed token binding it to one
 * chatbot. A missing, forged, expired or other-chatbot token never resumes
 * anything: the caller gets a brand-new session instead.
 */

export type ChatSurface = "widget" | "preview"

const WIDGET_SESSION_TYP = "widget_session"

function sessionTtlSeconds(): number {
  return Math.max(1, Number(env.conversationTtlDays)) * 24 * 60 * 60
}

export interface WidgetSession {
  /** Server-generated, unguessable session id. */
  sid: string
  /** Signed token the widget must send back on later turns. */
  sessionToken: string
  /** True when this request started a new session (none, or an invalid one, was presented). */
  issued: boolean
}

export function issueWidgetSession(chatbotId: string): WidgetSession {
  const sid = randomBytes(16).toString("base64url")
  const sessionToken = jwt.sign({ typ: WIDGET_SESSION_TYP, chatbotId, sid }, env.jwtSecret, { expiresIn: sessionTtlSeconds() })
  return { sid, sessionToken, issued: true }
}

/** The session id carried by a valid token for THIS chatbot, else null. */
export function verifyWidgetSessionToken(token: string | undefined | null, chatbotId: string): string | null {
  if (!token) return null
  try {
    const decoded = jwt.verify(token, env.jwtSecret, { algorithms: ["HS256"] }) as jwt.JwtPayload
    if (decoded.typ !== WIDGET_SESSION_TYP || decoded.chatbotId !== chatbotId || typeof decoded.sid !== "string" || decoded.sid.length < 16) {
      return null
    }
    return decoded.sid
  } catch {
    return null
  }
}

/** Resume the presented session if it is valid for this chatbot, otherwise start a new one. */
export function resolveWidgetSession(chatbotId: string, sessionToken: string | undefined | null): WidgetSession {
  const sid = verifyWidgetSessionToken(sessionToken, chatbotId)
  if (sid) return { sid, sessionToken: sessionToken as string, issued: false }
  return issueWidgetSession(chatbotId)
}

/**
 * The conversation/thread key for a chat surface. Widget sessions are keyed
 * by the server-issued sid; dashboard previews by the owner's user id plus
 * their own preview session string, so the two can never share a thread.
 * Graph entrypoints additionally prefix the graph name and chatbot id.
 */
export function chatSessionKey(surface: "widget", sid: string): string
export function chatSessionKey(surface: "preview", userId: string, previewSessionId: string): string
export function chatSessionKey(surface: ChatSurface, a: string, b?: string): string {
  return surface === "widget" ? `widget:${a}` : `preview:${a}:${b}`
}
