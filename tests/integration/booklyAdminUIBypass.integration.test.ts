import { randomUUID } from "node:crypto"
import request from "supertest"
import { afterAll, describe, expect, it, vi } from "vitest"

// This test's real point is exercising a live Bookly login/JWT, so
// nothing about the actual authorization path is mocked — the same
// deliberate, narrow SSRF-precheck exception booklyBookingRace uses (see
// its own doc comment) for the same reason: a same-machine test server is
// always a loopback/RFC1918 address, which that shared check correctly
// and permanently blocks in production.
vi.mock("../../src/lib/crawler/ssrf.js", () => ({
  assertSafeUrl: async () => {},
  isPrivateAddress: () => false,
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}))

import { liveBooklyGate, startLiveBookly, stopLiveBookly, type LiveBookly } from "../helpers/liveBookly.js"

const { pool } = await import("../../src/lib/db.js")
const { encryptSecret } = await import("../../src/lib/crypto.js")
const { app, signupUser } = await import("../helpers.js")

const PORT = Number(process.env.BOOKLY_TEST_PORT_UI_BYPASS || 4093)

// CS-17: opt-in only (RUN_LIVE_BOOKLY_TESTS=1 + pinned BOOKLY_REPO_DIR/SHA).
// Disabled -> reported as skipped with the reason; enabled but failing to
// start -> the file fails instead of silently skipping.
const gate = liveBooklyGate()
const skipSuite = !gate.enabled
let live: LiveBookly | undefined
if (gate.enabled) {
  live = await startLiveBookly(PORT, "admin-ui-bypass", gate)
} else {
  console.warn(`[booklyAdminUIBypass] SKIPPED (opt-in live test): ${gate.reason}`)
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

async function loginBookly(email: string, password: string): Promise<string> {
  const res = await request(live!.baseUrl).post("/auth/login").send({ email, password })
  if (res.status !== 200) throw new Error(`bookly login failed: ${res.status} ${JSON.stringify(res.body)}`)
  return res.body.token as string
}

async function seedBooklyUser(email: string, password: string, role: "ADMIN" | "STAFF"): Promise<void> {
  // Real bcrypt hash of `password`, generated once and reused — matches
  // Bookly's own tests/helpers.js discipline of exercising the real auth
  // path rather than forging a token by hand.
  const bcrypt = await import("bcryptjs")
  const passwordHash = await bcrypt.hash(password, 4)
  await live!.db.query(`INSERT INTO users (name, email, password_hash, role, is_active) VALUES ($1, $2, $3, $4, true)`, ["Test User", email, passwordHash, role])
}

describe.skipIf(skipSuite)("Admin-chat automation — UI visibility is never authorization (Part B item 1) + unauthenticated/STAFF rejection", () => {
  it("a direct HTTP request to the admin-chat route with NO token is rejected, identically to how it would be with an invalid one", async () => {
    const chatbotId = await seedBooklyConnectedChatbot("ui-bypass-none")

    const res = await request(app)
      .post(`/chatbots/${chatbotId}/bookly-admin-chat`)
      .send({ message: "create a resource called Hacked Room", booklyAdminToken: "" })

    expect(res.status).toBe(400) // validator rejects empty token before it even reaches the service
  })

  it("a direct HTTP request with a garbage token is rejected with 401 — the same route real admins use, not a separate weaker path", async () => {
    const chatbotId = await seedBooklyConnectedChatbot("ui-bypass-garbage")

    const res = await request(app)
      .post(`/chatbots/${chatbotId}/bookly-admin-chat`)
      .send({ message: "create a resource called Hacked Room", booklyAdminToken: "not-a-real-jwt" })

    expect(res.status).toBe(401)
  })

  it("a STAFF Bookly account's real, valid JWT is rejected from the admin-chat route with 403", async () => {
    const chatbotId = await seedBooklyConnectedChatbot("ui-bypass-staff")
    const email = `staff-${randomUUID()}@example.test`
    await seedBooklyUser(email, "correct horse battery staple", "STAFF")
    const token = await loginBookly(email, "correct horse battery staple")

    const res = await request(app)
      .post(`/chatbots/${chatbotId}/bookly-admin-chat`)
      .send({ message: "create a resource called Should Not Exist", booklyAdminToken: token })

    expect(res.status).toBe(403)

    const { rows } = await live!.db.query("SELECT id FROM resources WHERE name = $1", ["Should Not Exist"])
    expect(rows).toHaveLength(0)
  })

  it("a real, valid Bookly ADMIN JWT is accepted by the SAME route — proving the rejections above are real authorization, not the endpoint simply being broken", async () => {
    const chatbotId = await seedBooklyConnectedChatbot("ui-bypass-admin-ok")
    const email = `admin-${randomUUID()}@example.test`
    await seedBooklyUser(email, "correct horse battery staple", "ADMIN")
    const token = await loginBookly(email, "correct horse battery staple")

    const res = await request(app)
      .post(`/chatbots/${chatbotId}/bookly-admin-chat`)
      .send({ message: "hello", booklyAdminToken: token })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })
})
