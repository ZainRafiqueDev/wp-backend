import request from "supertest"
import { describe, expect, it } from "vitest"

import { hashPassword } from "../../src/lib/auth.js"
import { adminActivatedCustomerId } from "../../src/lib/adminMetrics.js"
import { pool } from "../../src/lib/db.js"
import { getEntitlementForUser } from "../../src/services/billing.service.js"
import { app, cookieValue, signupUser, uniqueEmail } from "../helpers.js"

async function createAdmin(label: string) {
  const email = uniqueEmail(label)
  const password = "a very strong admin password"
  const passwordHash = await hashPassword(password)
  await pool!.query(// SA-02: these tests exercise super-admin-only actions (plans, delete).
    "insert into admin_users (email, password_hash, name, role) values ($1, $2, $3, 'super_admin')", [
    email,
    passwordHash,
    "Test Admin",
  ])
  const login = await request(app).post("/admin/login").send({ email, password })
  if (login.status !== 200) throw new Error(`createAdmin helper failed: ${login.status} ${JSON.stringify(login.body)}`)
  return cookieValue(login, "chatmate360_admin_token") // CS-11: token is only in the httpOnly cookie now
}

function authed(token: string) {
  return { Authorization: `Bearer ${token}` }
}

// CS-11: admin auth is cookie-only; state-changing requests also need the
// trusted Origin (requireTrustedOrigin).
function adminAuthed(token: string) {
  return { Cookie: `chatmate360_admin_token=${token}`, Origin: "https://frontend.test" }
}

const safeActivation = {
  plan: "full_custom" as const,
  monthlyCreditUsd: 40,
  allowedModels: ["openai", "anthropic"] as const,
  cashCollectedUsd: 100,
}

describe("WP-2.6 Full Custom activation API", () => {
  it("rejects unauthenticated and customer tokens", async () => {
    const { user, session } = await signupUser("activate-plan-anon")
    expect((await request(app).post(`/admin/users/${user.id}/activate-plan`).send(safeActivation)).status).toBe(401)
    expect(
      (await request(app).post(`/admin/users/${user.id}/activate-plan`).set(authed(session.access_token)).send(safeActivation))
        .status,
    ).toBe(401)
  })

  it("activates free → full_custom with the same entitlement shape as paid Crawl Plus", async () => {
    const adminToken = await createAdmin("activate-plan-free")
    const { user } = await signupUser("activate-plan-target")

    const before = await getEntitlementForUser(user.id)
    expect(before.plan).toBe("free")
    expect(before.active).toBe(false)

    const res = await request(app)
      .post(`/admin/users/${user.id}/activate-plan`)
      .set(adminAuthed(adminToken))
      .send(safeActivation)

    expect(res.status).toBe(200)
    expect(res.body.activation.plan).toBe("full_custom")
    expect(res.body.activation.status).toBe("active")
    expect(res.body.activation.monthlyCreditUsd).toBe(40)
    expect(res.body.activation.grantCustomActions).toBe(false)
    expect(res.body.activation.exceededSafeCredits).toBe(false)

    const entitlement = await getEntitlementForUser(user.id)
    expect(entitlement.active).toBe(true)
    expect(entitlement.plan).toBe("full_custom")
    expect(entitlement.perModelCapUsd).toBe(40)
    expect(entitlement.allowedModels).toEqual(["openai", "anthropic"])

    const { rows } = await pool!.query<{
      plan: string
      status: string
      stripe_customer_id: string
      stripe_subscription_id: string | null
      activated_by: string | null
      activated_at: Date | null
    }>("select plan, status, stripe_customer_id, stripe_subscription_id, activated_by, activated_at from subscriptions where user_id = $1", [
      user.id,
    ])
    expect(rows[0]?.plan).toBe("full_custom")
    expect(rows[0]?.status).toBe("active")
    expect(rows[0]?.stripe_customer_id).toBe(adminActivatedCustomerId(user.id))
    expect(rows[0]?.stripe_subscription_id).toBeNull()
    expect(rows[0]?.activated_by).toBeTruthy()
    expect(rows[0]?.activated_at).toBeTruthy()

    const audit = await pool!.query<{ action: string; detail: Record<string, unknown> }>(
      "select action, detail from admin_audit_log where target_user_id = $1 and action = 'activate_plan'",
      [user.id],
    )
    expect(audit.rows).toHaveLength(1)
    expect(audit.rows[0]?.detail.grantCustomActions).toBe(false)
    expect(audit.rows[0]?.detail.granted_usd).toBe(40)
    expect(audit.rows[0]?.detail.amount_total).toBe(100)
  })

  it("cannot exceed computed safe credits without an override reason", async () => {
    const adminToken = await createAdmin("activate-plan-unsafe")
    const { user } = await signupUser("activate-plan-unsafe-target")

    const denied = await request(app)
      .post(`/admin/users/${user.id}/activate-plan`)
      .set(adminAuthed(adminToken))
      .send({
        plan: "full_custom",
        monthlyCreditUsd: 50,
        allowedModels: ["openai"],
        cashCollectedUsd: 100,
      })
    expect(denied.status).toBe(400)
    expect(denied.body.error).toMatch(/safe credits/i)

    const stillFree = await getEntitlementForUser(user.id)
    expect(stillFree.plan).toBe("free")

    const allowed = await request(app)
      .post(`/admin/users/${user.id}/activate-plan`)
      .set(adminAuthed(adminToken))
      .send({
        plan: "full_custom",
        monthlyCreditUsd: 50,
        allowedModels: ["openai"],
        cashCollectedUsd: 100,
        overrideReason: "Signed 60% AI budget after finance review",
      })
    expect(allowed.status).toBe(200)
    expect(allowed.body.activation.exceededSafeCredits).toBe(true)
    expect((await getEntitlementForUser(user.id)).perModelCapUsd).toBe(50)
  })

  it("never grants credits equal to attested cash, even with an override reason", async () => {
    const adminToken = await createAdmin("activate-plan-grant-eq")
    const { user } = await signupUser("activate-plan-grant-eq-target")

    const res = await request(app)
      .post(`/admin/users/${user.id}/activate-plan`)
      .set(adminAuthed(adminToken))
      .send({
        plan: "full_custom",
        monthlyCreditUsd: 100,
        allowedModels: ["openai"],
        cashCollectedUsd: 100,
        overrideReason: "Trying to grant the entire invoice as AI credit",
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/not less than cash/i)
  })

  it("does not silently grant Custom Actions and keeps tenant B unchanged", async () => {
    const adminToken = await createAdmin("activate-plan-actions")
    const a = await signupUser("activate-plan-a")
    const b = await signupUser("activate-plan-b")

    const created = await request(app)
      .post("/chatbots")
      .set(authed(a.session.access_token))
      .send({
        name: "activate-plan bot",
        sources: [{ type: "pdf", label: "handbook.pdf", characters: 50, content: "Help is help@example.com." }],
      })
    expect(created.status).toBe(201)
    const chatbotId = created.body.chatbot.id as string

    const activated = await request(app)
      .post(`/admin/users/${a.user.id}/activate-plan`)
      .set(adminAuthed(adminToken))
      .send(safeActivation)
    expect(activated.status).toBe(200)
    expect(activated.body.activation.grantCustomActions).toBe(false)

    const actions = await request(app)
      .post(`/chatbots/${chatbotId}/actions`)
      .set(authed(a.session.access_token))
      .send({
        name: "check_order_status",
        description: "Use this when the user asks about an order's status.",
        httpMethod: "GET",
        urlTemplate: "https://api.example.com/orders/{{order_id}}",
        headersTemplate: {},
        bodyTemplate: null,
        parameters: [{ name: "order_id", type: "string", description: "The order id", required: true }],
      })
    expect(actions.status).toBe(402)
    expect(actions.body.error).toMatch(/Crawl Plus/i)

    expect((await getEntitlementForUser(b.user.id)).plan).toBe("free")
    expect((await getEntitlementForUser(b.user.id)).active).toBe(false)
  })

  // CS-13 (B06-006): the real Stripe customer id is now KEPT (so later
  // events and refunds for that customer still find the row). That a later
  // webhook for the old subscription cannot clobber Full Custom is proven
  // through the real webhook handler in cs13StripePayments.integration.test.ts
  // ("a late deleted/payment_failed for the replaced subscription ...").
  it("keeps the prior Stripe customer id, detaches the subscription id, and grants Full Custom", async () => {
    const adminToken = await createAdmin("activate-plan-detach")
    const { user } = await signupUser("activate-plan-detach-target")
    const oldCustomerId = `cus_prior_${user.id}`
    await pool!.query(
      `insert into subscriptions (user_id, stripe_customer_id, stripe_subscription_id, plan, status)
       values ($1, $2, $3, 'crawl_plus', 'active')`,
      [user.id, oldCustomerId, `sub_prior_${user.id}`],
    )

    const res = await request(app)
      .post(`/admin/users/${user.id}/activate-plan`)
      .set(adminAuthed(adminToken))
      .send(safeActivation)
    expect(res.status).toBe(200)

    const { rows } = await pool!.query<{ stripe_customer_id: string; stripe_subscription_id: string | null }>(
      "select stripe_customer_id, stripe_subscription_id from subscriptions where user_id = $1",
      [user.id],
    )
    expect(rows[0]?.stripe_customer_id).toBe(oldCustomerId)
    expect(rows[0]?.stripe_subscription_id).toBeNull()
    expect((await getEntitlementForUser(user.id)).plan).toBe("full_custom")
    expect((await getEntitlementForUser(user.id)).active).toBe(true)
  })

  it("rolls back through the existing admin cancel path", async () => {
    const adminToken = await createAdmin("activate-plan-cancel")
    const { user } = await signupUser("activate-plan-cancel-target")

    const activated = await request(app)
      .post(`/admin/users/${user.id}/activate-plan`)
      .set(adminAuthed(adminToken))
      .send(safeActivation)
    expect(activated.status).toBe(200)

    const canceled = await request(app)
      .post(`/admin/users/${user.id}/cancel-subscription`)
      .set(adminAuthed(adminToken))
    expect(canceled.status).toBe(200)

    const entitlement = await getEntitlementForUser(user.id)
    expect(entitlement.active).toBe(false)
    expect(entitlement.plan).toBe("free")
  })

  it("refuses Crawl Plus on this endpoint so Custom Actions cannot be granted here", async () => {
    const adminToken = await createAdmin("activate-plan-crawl")
    const { user } = await signupUser("activate-plan-crawl-target")

    const res = await request(app)
      .post(`/admin/users/${user.id}/activate-plan`)
      .set(adminAuthed(adminToken))
      .send({
        plan: "crawl_plus",
        monthlyCreditUsd: 8,
        allowedModels: ["openai"],
        cashCollectedUsd: 20,
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Full Custom/i)
    expect((await getEntitlementForUser(user.id)).plan).toBe("free")
  })
})
