import { randomUUID } from "node:crypto"
import request from "supertest"
import { afterAll, describe, expect, it, vi } from "vitest"

// Same narrow, deliberate SSRF-precheck exception as booklyBookingRace and
// booklyAdminUIBypass — see their own doc comments for why.
vi.mock("../../src/lib/crawler/ssrf.js", () => ({
  assertSafeUrl: async () => {},
  isPrivateAddress: () => false,
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}))

// Scripted LLM, same discipline as commerceGraphFullRun.integration.test.ts
// — deterministic, no real OpenAI call, and its call COUNT is itself part
// of the proof below (a third call would mean the graph advanced past the
// confirmation pause, which must never happen once the session is
// invalidated).
const llmInvoke = vi.fn()
vi.mock("../../src/langgraph/llm.js", () => ({
  hasCommerceLlm: vi.fn(() => true),
  getCommerceLlm: vi.fn(() => ({ invoke: llmInvoke })),
}))

import { liveBooklyGate, startLiveBookly, stopLiveBookly, type LiveBookly } from "../helpers/liveBookly.js"

const { pool } = await import("../../src/lib/db.js")
const { encryptSecret } = await import("../../src/lib/crypto.js")
const { app, signupUser } = await import("../helpers.js")

const PORT = Number(process.env.BOOKLY_TEST_PORT_SESSION_EXPIRY || 4094)

// CS-17: opt-in only (RUN_LIVE_BOOKLY_TESTS=1 + pinned BOOKLY_REPO_DIR/SHA).
// Disabled -> reported as skipped with the reason; enabled but failing to
// start -> the file fails instead of silently skipping.
const gate = liveBooklyGate()
const skipSuite = !gate.enabled
let live: LiveBookly | undefined
if (gate.enabled) {
  live = await startLiveBookly(PORT, "admin-session-expiry", gate)
} else {
  console.warn(`[booklyAdminSessionExpiry] SKIPPED (opt-in live test): ${gate.reason}`)
}

afterAll(async () => {
  await stopLiveBookly(live)
})

async function seedBooklyConnectedChatbot(label: string) {
  const db = pool!
  const { user } = await signupUser(label)
  await db.query(`insert into subscriptions (user_id, stripe_customer_id, plan, status) values ($1, $2, 'full_custom', 'active')`, [user.id, `cus_${randomUUID()}`])
  const { rows: chatbotRows } = await db.query("insert into chatbots (user_id, name, sources, theme, status) values ($1, 'bot', '[]', '{}', 'ready') returning id", [user.id])
  const chatbotId = chatbotRows[0].id as string
  const resourceId = `resource-${randomUUID()}`
  await db.query(
    `insert into chatbot_bookly_credentials (chatbot_id, base_url, resource_id, resource_label, api_key_encrypted) values ($1, $2, $3, 'Resource', $4)`,
    [chatbotId, live!.baseUrl, resourceId, encryptSecret("unused-in-admin-flow")],
  )
  return chatbotId
}

async function seedBooklyAdmin(email: string, password: string): Promise<string> {
  const bcrypt = await import("bcryptjs")
  const passwordHash = await bcrypt.hash(password, 4)
  const { rows } = await live!.db.query(
    `INSERT INTO users (name, email, password_hash, role, is_active) VALUES ('Real Admin', $1, $2, 'ADMIN', true) RETURNING id`,
    [email, passwordHash],
  )
  return rows[0].id as string
}

async function loginBookly(email: string, password: string): Promise<string> {
  const res = await request(live!.baseUrl).post("/auth/login").send({ email, password })
  if (res.status !== 200) throw new Error(`bookly login failed: ${res.status} ${JSON.stringify(res.body)}`)
  return res.body.token as string
}

describe.skipIf(skipSuite)("Admin-chat automation — session re-verified on EVERY tool call, never trusted from earlier in the conversation (Part B item 2)", () => {
  it("a session invalidated mid-conversation is rejected on the very next message, and the pending action is never executed", async () => {
    llmInvoke.mockReset()
    const resourceName = `Session Expiry Test Room ${randomUUID()}`
    // Turn 1: classify -> create_resource
    llmInvoke.mockResolvedValueOnce({ content: "create_resource" })
    // Turn 1: extract full draft (name given up front, nothing missing)
    llmInvoke.mockResolvedValueOnce({ content: JSON.stringify({ name: resourceName, timezone: "UTC", slotDurationMinutes: 30 }) })

    const chatbotId = await seedBooklyConnectedChatbot("session-expiry")
    const email = `admin-${randomUUID()}@example.test`
    const adminId = await seedBooklyAdmin(email, "correct horse battery staple")
    const token = await loginBookly(email, "correct horse battery staple")
    const conversationId = `conv-${randomUUID()}`

    // Turn 1 — properly authenticated: reaches the confirmation pause.
    const turn1 = await request(app)
      .post(`/chatbots/${chatbotId}/bookly-admin-chat`)
      .send({ message: `Create a resource called ${resourceName}`, conversationId, booklyAdminToken: token })

    expect(turn1.status).toBe(200)
    expect(turn1.body.text).toMatch(/proceed/i)
    expect(llmInvoke).toHaveBeenCalledTimes(2) // classify + extract only — confirm's yes/no classifier hasn't run yet

    // Invalidate the session BEFORE the next message — real Bookly-side
    // deactivation (the same is_active flag GET /auth/me itself reads live
    // on every call), not a ChatMate360-side simulation.
    await live!.db.query("UPDATE users SET is_active = false WHERE id = $1", [adminId])

    // Turn 2 — the human's actual "yes", but with a now-invalid session.
    const turn2 = await request(app)
      .post(`/chatbots/${chatbotId}/bookly-admin-chat`)
      .send({ message: "yes", conversationId, booklyAdminToken: token })

    expect(turn2.status).toBe(403)
    // The graph must NEVER have resumed — the confirm node's own yes/no
    // classifier call would be the 3rd LLM invocation; it must not exist.
    expect(llmInvoke).toHaveBeenCalledTimes(2)

    // The resource must never have been created.
    const { rows } = await live!.db.query("SELECT id FROM resources WHERE name = $1", [resourceName])
    expect(rows).toHaveLength(0)

    // Re-activate and confirm the SAME paused conversation can still be
    // resumed once a valid session is presented again — proves turn 2's
    // rejection didn't corrupt or lose the pending action, it just
    // correctly refused to advance it under an invalid session.
    await live!.db.query("UPDATE users SET is_active = true WHERE id = $1", [adminId])
    llmInvoke.mockResolvedValueOnce({ content: "yes" }) // confirm's yes/no classifier, now finally reached
    const turn3 = await request(app)
      .post(`/chatbots/${chatbotId}/bookly-admin-chat`)
      .send({ message: "yes", conversationId, booklyAdminToken: token })

    expect(turn3.status).toBe(200)
    expect(turn3.body.text).toMatch(/created|bookable/i)
    const { rows: created } = await live!.db.query("SELECT id FROM resources WHERE name = $1", [resourceName])
    expect(created).toHaveLength(1)
  })
})
