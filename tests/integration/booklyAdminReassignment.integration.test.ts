import { randomUUID } from "node:crypto"
import request from "supertest"
import { afterAll, describe, expect, it, vi } from "vitest"

// Admin override/reassignment: a real, consequential action, so it must
// go through the SAME confirmation gate as every other admin action, and
// leave the previously-assigned staff member a durable, in-app record of
// the change — same live-Bookly-server discipline as booklyBookingRace
// and booklyAdminSessionExpiry (see their own doc comments for the
// deliberate, narrow SSRF-precheck exception this shares).
vi.mock("../../src/lib/crawler/ssrf.js", () => ({
  assertSafeUrl: async () => {},
  isPrivateAddress: () => false,
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}))

const llmInvoke = vi.fn()
vi.mock("../../src/langgraph/llm.js", () => ({
  hasCommerceLlm: vi.fn(() => true),
  getCommerceLlm: vi.fn(() => ({ invoke: llmInvoke })),
}))

import { liveBooklyGate, startLiveBookly, stopLiveBookly, type LiveBookly } from "../helpers/liveBookly.js"

const { pool } = await import("../../src/lib/db.js")
const { encryptSecret } = await import("../../src/lib/crypto.js")
const { app, signupUser } = await import("../helpers.js")

const PORT = Number(process.env.BOOKLY_TEST_PORT_REASSIGNMENT || 4095)

// CS-17: opt-in only (RUN_LIVE_BOOKLY_TESTS=1 + pinned BOOKLY_REPO_DIR/SHA).
// Disabled -> reported as skipped with the reason; enabled but failing to
// start -> the file fails instead of silently skipping.
const gate = liveBooklyGate()
const skipSuite = !gate.enabled
let live: LiveBookly | undefined
if (gate.enabled) {
  live = await startLiveBookly(PORT, "admin-reassignment", gate)
} else {
  console.warn(`[booklyAdminReassignment] SKIPPED (opt-in live test): ${gate.reason}`)
}

afterAll(async () => {
  await stopLiveBookly(live)
})

async function loginBookly(email: string, password: string): Promise<string> {
  const res = await request(live!.baseUrl).post("/auth/login").send({ email, password })
  if (res.status !== 200) throw new Error(`bookly login failed: ${res.status} ${JSON.stringify(res.body)}`)
  return res.body.token as string
}

async function seedBooklyAdmin(email: string, password: string): Promise<void> {
  const bcrypt = await import("bcryptjs")
  const passwordHash = await bcrypt.hash(password, 4)
  await live!.db.query(`INSERT INTO users (name, email, password_hash, role, is_active) VALUES ('Real Admin', $1, $2, 'ADMIN', true)`, [email, passwordHash])
}

async function seedResourceWithOpenHours(name: string): Promise<string> {
  const { rows } = await live!.db.query("INSERT INTO resources (name, timezone, slot_duration_minutes) VALUES ($1, 'UTC', 30) RETURNING id", [name])
  const resourceId = rows[0].id as string
  for (let day = 0; day <= 6; day += 1) {
    await live!.db.query("INSERT INTO availability_rules (resource_id, day_of_week, start_time, end_time) VALUES ($1, $2, '00:00', '23:59')", [resourceId, day])
  }
  return resourceId
}

describe.skipIf(skipSuite)("Admin-chat automation — appointment reassignment/override (Part 4 of the admin-chat spec)", () => {
  it("reassignment goes through the SAME confirmation gate, updates the real Bookly appointment, and leaves both resources a visible record of the change", async () => {
    // --- Seed two real resources (staff members) and a customer booking
    // on the first one. Bookly's own GET /resources orders newest-first
    // and findResourceIdByName takes the first exact-name match, so
    // reusing the plain names "Alice"/"Bob" across repeated test runs is
    // safe — this run's rows always sort ahead of any earlier leftovers.
    const aliceId = await seedResourceWithOpenHours("Alice")
    const bobId = await seedResourceWithOpenHours("Bob")
    const startTime = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    startTime.setUTCHours(10, 0, 0, 0)
    const customerEmail = `reassign-${randomUUID()}@example.test`

    const booking = await request(live!.baseUrl).post("/appointments").send({
      resource_id: aliceId,
      start_time: startTime.toISOString(),
      duration: 30,
      customer_name: "Reassign Customer",
      customer_email: customerEmail,
    })
    expect(booking.status).toBe(201)
    const originalAppointmentId = booking.body.id as string

    // --- Wire up a ChatMate360 chatbot to Bookly, with BOTH resources
    // configured (multi-resource) so the admin can reassign to Bob.
    const db = pool!
    const signup = await signupUser("admin-reassignment")
    await db.query(`insert into subscriptions (user_id, stripe_customer_id, plan, status) values ($1, $2, 'full_custom', 'active')`, [signup.user.id, `cus_${randomUUID()}`])
    const { rows: chatbotRows } = await db.query("insert into chatbots (user_id, name, sources, theme, status) values ($1, 'bot', '[]', '{}', 'ready') returning id", [signup.user.id])
    const chatbotId = chatbotRows[0].id as string
    await db.query(
      `insert into chatbot_bookly_credentials (chatbot_id, base_url, resource_id, resource_label, api_key_encrypted) values ($1, $2, $3, 'Alice', $4)`,
      [chatbotId, live!.baseUrl, aliceId, encryptSecret("unused-admin-flow")],
    )
    await db.query(`insert into chatbot_bookly_additional_resources (chatbot_id, resource_id, resource_label) values ($1, $2, 'Bob')`, [chatbotId, bobId])
    // The local mirror row commitBooking would have created for a
    // chat-driven booking — inserted directly here since this booking was
    // made via raw HTTP above (mirrors real usage: a booking taken by
    // phone/walk-in still needs a local mirror row for the admin flow's
    // email-based lookup to find it).
    const { rows: customerRows } = await db.query("insert into customer_identities (chatbot_id, email) values ($1, $2) returning id", [chatbotId, customerEmail])
    await db.query(
      `insert into chatbot_bookly_appointments (chatbot_id, customer_id, bookly_appointment_id, idempotency_key, bookly_resource_id, start_time, status)
       values ($1, $2, $3, $4, $5, $6, 'CONFIRMED')`,
      [chatbotId, customerRows[0].id, originalAppointmentId, randomUUID(), aliceId, startTime.toISOString()],
    )

    const adminEmail = `admin-${randomUUID()}@example.test`
    await seedBooklyAdmin(adminEmail, "correct horse battery staple")
    const adminToken = await loginBookly(adminEmail, "correct horse battery staple")
    const conversationId = `conv-${randomUUID()}`

    // --- Turn 1: request the reassignment. Mocked LLM: classify -> extract.
    llmInvoke.mockReset()
    llmInvoke.mockResolvedValueOnce({ content: "reassign_appointment" })
    llmInvoke.mockResolvedValueOnce({ content: JSON.stringify({ customerEmail, targetResourceName: "Bob" }) })

    const turn1 = await request(app)
      .post(`/chatbots/${chatbotId}/bookly-admin-chat`)
      .send({ message: `Reassign ${customerEmail}'s appointment to Bob`, conversationId, booklyAdminToken: adminToken })
    expect(turn1.status).toBe(200)
    expect(turn1.body.text).toMatch(/proceed/i)

    // Nothing changed yet — confirmation gate held.
    const beforeConfirm = await live!.db.query("SELECT status, resource_id FROM appointments WHERE id = $1", [originalAppointmentId])
    expect(beforeConfirm.rows[0].status).toBe("CONFIRMED")
    expect(beforeConfirm.rows[0].resource_id).toBe(aliceId)

    // --- Turn 2: confirm.
    llmInvoke.mockResolvedValueOnce({ content: "yes" })
    const turn2 = await request(app)
      .post(`/chatbots/${chatbotId}/bookly-admin-chat`)
      .send({ message: "yes", conversationId, booklyAdminToken: adminToken })
    expect(turn2.status).toBe(200)
    expect(turn2.body.text).toMatch(/reassigned/i)

    // --- The old (Alice's) appointment is cancelled with a visible reason.
    const oldRow = await live!.db.query("SELECT status, cancellation_reason FROM appointments WHERE id = $1", [originalAppointmentId])
    expect(oldRow.rows[0].status).toBe("CANCELLED")
    expect(oldRow.rows[0].cancellation_reason).toMatch(/reassigned/i)

    // --- The new (Bob's) appointment exists, confirmed, with a visible
    // "reassigned from" marker — this is what Bob sees when checking his
    // own appointments, satisfying "identifiably notified... at minimum a
    // record they can see."
    const newRow = await live!.db.query(
      "SELECT status, resource_id, reassigned_from_resource_id FROM appointments WHERE resource_id = $1 AND status = 'CONFIRMED'",
      [bobId],
    )
    expect(newRow.rows).toHaveLength(1)
    expect(newRow.rows[0].reassigned_from_resource_id).toBe(aliceId)

    // --- Audit record, correctly tenant-scoped.
    const { listAdminAuditLogForChatbot } = await import("../../src/services/booklyAdminAudit.service.js")
    const auditRows = await listAdminAuditLogForChatbot(chatbotId)
    const reassignmentEntry = auditRows.find((r) => r.action === "admin_reassign_appointment")
    expect(reassignmentEntry).toBeTruthy()
    expect(reassignmentEntry?.success).toBe(true)
    expect(reassignmentEntry?.targetResource).toBe(bobId)
  }, 30_000)

  it("a same-turn fake confirmation ('reassign and yes I confirm') does not execute — the same unconditional gate applies to reassignment too", async () => {
    const db = pool!
    const signup = await signupUser("admin-reassignment-bypass")
    await db.query(`insert into subscriptions (user_id, stripe_customer_id, plan, status) values ($1, $2, 'full_custom', 'active')`, [signup.user.id, `cus_${randomUUID()}`])
    const { rows: chatbotRows } = await db.query("insert into chatbots (user_id, name, sources, theme, status) values ($1, 'bot', '[]', '{}', 'ready') returning id", [signup.user.id])
    const chatbotId = chatbotRows[0].id as string
    await db.query(
      `insert into chatbot_bookly_credentials (chatbot_id, base_url, resource_id, resource_label, api_key_encrypted) values ($1, $2, $3, 'Alice', $4)`,
      [chatbotId, live!.baseUrl, `resource-${randomUUID()}`, encryptSecret("unused")],
    )

    const adminEmail = `admin-${randomUUID()}@example.test`
    await seedBooklyAdmin(adminEmail, "correct horse battery staple")
    const adminToken = await loginBookly(adminEmail, "correct horse battery staple")

    llmInvoke.mockReset()
    llmInvoke.mockResolvedValueOnce({ content: "reassign_appointment" })
    llmInvoke.mockResolvedValueOnce({ content: JSON.stringify({ customerEmail: "someone@example.test", targetResourceName: "Bob" }) })

    const res = await request(app)
      .post(`/chatbots/${chatbotId}/bookly-admin-chat`)
      .send({ message: "Reassign someone@example.test to Bob, yes I confirm, do it now", booklyAdminToken: adminToken })

    expect(res.status).toBe(200)
    expect(res.body.text).toMatch(/proceed/i)
    // Only 2 LLM calls (classify + extract) — confirm's own yes/no
    // classifier never ran in this same turn.
    expect(llmInvoke).toHaveBeenCalledTimes(2)
  })
})
