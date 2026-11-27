import { randomUUID } from "node:crypto"

import jwt from "jsonwebtoken"
import request from "supertest"

import { app } from "../src/app.js"
import { pool } from "../src/lib/db.js"

// Every integration test creates its own uniquely-suffixed user/chatbot
// rather than relying on truncation between tests — safe under vitest's
// per-file parallelism and leaves no shared state to accidentally leak
// between test files.
export function uniqueEmail(label: string): string {
  return `${label}-${randomUUID()}@example.test`
}

// Auth now issues tokens as httpOnly cookies (see src/lib/authCookies.ts),
// not in the JSON response body — a real browser never needs to read them,
// so nothing else should be able to either. Tests still need the raw token
// to build Authorization: Bearer headers for supertest requests (supertest
// doesn't carry cookies between separate `request(app)` calls the way a
// browser would), so this reads it straight out of the response's own
// Set-Cookie header instead of the (now-absent) body field.
export function cookieValue(res: request.Response, name: string): string {
  const raw = res.headers["set-cookie"]
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : []
  for (const cookie of cookies) {
    const match = cookie.match(new RegExp(`^${name}=([^;]+)`))
    if (match) return decodeURIComponent(match[1])
  }
  throw new Error(`cookieValue: no Set-Cookie found for "${name}"`)
}

export async function signupUser(label: string, password = "correct horse battery staple") {
  const email = uniqueEmail(label)
  const res = await request(app).post("/auth/signup").send({ name: "Test User", email, password })
  if (res.status !== 201) {
    throw new Error(`signupUser helper failed: ${res.status} ${JSON.stringify(res.body)}`)
  }

  // Signup leaves email_verified=false; chatbot create (and most flows) require
  // a verified address. Mark verified here so helpers match a post-verify user.
  const userId = res.body.user.id as string
  if (!pool) throw new Error("signupUser requires a database pool")
  await pool.query("update users set email_verified = true where id = $1", [userId])

  const accessToken = cookieValue(res, "chatmate360_access_token")
  const refreshToken = cookieValue(res, "chatmate360_refresh_token")
  const decoded = jwt.decode(accessToken) as { exp?: number } | null

  return {
    email,
    password,
    ...res.body,
    user: { ...res.body.user, emailVerified: true },
    // Reconstructed from the Set-Cookie header, not the response body (see
    // cookieValue above) — same shape as before so every other test file
    // reading signup.session.access_token needed no changes.
    session: {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: decoded?.exp ?? Math.floor(Date.now() / 1000) + 3600,
    },
  } as {
    email: string
    password: string
    ok: true
    user: { id: string; email: string; name: string; emailVerified: boolean }
    session: { access_token: string; refresh_token: string; expires_at: number }
  }
}

// A ready-to-chat, publicly-embeddable chatbot: file-only (no crawl needed,
// so no crawler mocking required by callers of this helper) with its
// allowed_domain already set.
export async function createReadyChatbotWithDomain(label: string, domain: string) {
  const signup = await signupUser(label)
  const token = signup.session.access_token

  const created = await request(app)
    .post("/chatbots")
    .set("Authorization", `Bearer ${token}`)
    .send({
      name: `${label} bot`,
      sources: [{ type: "pdf", label: "handbook.pdf", characters: 50, content: "Our support email is help@example.com." }],
    })
  if (created.status !== 201) {
    throw new Error(`createReadyChatbotWithDomain: create failed: ${created.status} ${JSON.stringify(created.body)}`)
  }

  const chatbotId = created.body.chatbot.id as string

  const domained = await request(app)
    .patch(`/chatbots/${chatbotId}/domain`)
    .set("Authorization", `Bearer ${token}`)
    .send({ domain })
  if (domained.status !== 200) {
    throw new Error(`createReadyChatbotWithDomain: domain set failed: ${domained.status} ${JSON.stringify(domained.body)}`)
  }

  return { ...signup, token, userId: signup.user.id, chatbotId, domain }
}

export { app }
