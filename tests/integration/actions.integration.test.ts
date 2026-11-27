import request from "supertest"
import { describe, expect, it } from "vitest"

import { pool } from "../../src/lib/db.js"
import { currentBillingPeriod } from "../../src/services/usage.service.js"
import { app, signupUser } from "../helpers.js"

function authed(token: string) {
  return { Authorization: `Bearer ${token}` }
}

async function createChatbot(label: string) {
  const { session, user } = await signupUser(label)
  const created = await request(app)
    .post("/chatbots")
    .set(authed(session.access_token))
    .send({ name: `${label} bot`, sources: [{ type: "pdf", label: "a.pdf", characters: 5, content: "x" }] })
  return { session, userId: user.id, chatbotId: created.body.chatbot.id as string }
}

// Custom Actions require an active Crawl Plus subscription plus a current
// model top-up. Tests grant both directly instead of opening Stripe Checkout.
async function createCrawlPlusActionChatbot(label: string) {
  const bot = await createChatbot(label)
  await pool!.query(
    `insert into subscriptions (user_id, stripe_customer_id, plan, status) values ($1, $2, 'crawl_plus', 'active')`,
    [bot.userId, `cus_test_${label}_${Date.now()}`],
  )
  await pool!.query(
    `insert into chatbot_model_credits
       (chatbot_id, billing_period, model, credited_usd, stripe_checkout_session_id)
     values ($1, $2, 'openai', 5, $3)`,
    [bot.chatbotId, currentBillingPeriod(), `cs_test_${label}_${Date.now()}`],
  )
  return bot
}

function validAction(overrides: Record<string, unknown> = {}) {
  return {
    name: "check_order_status",
    description: "Use this when the user asks about an order's status.",
    httpMethod: "GET",
    urlTemplate: "https://api.example.com/orders/{{order_id}}",
    headersTemplate: {},
    bodyTemplate: null,
    parameters: [{ name: "order_id", type: "string", description: "The order id", required: true }],
    ...overrides,
  }
}

describe("Custom Actions CRUD", () => {
  it("requires authentication", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000"
    expect((await request(app).get(`/chatbots/${fakeId}/actions`)).status).toBe(401)
    expect((await request(app).post(`/chatbots/${fakeId}/actions`).send(validAction())).status).toBe(401)
  })

  it("creates, lists, updates, and deletes an action for the caller's own chatbot", async () => {
    const { session, chatbotId } = await createCrawlPlusActionChatbot("actions-crud")

    const created = await request(app).post(`/chatbots/${chatbotId}/actions`).set(authed(session.access_token)).send(validAction())
    expect(created.status).toBe(201)
    expect(created.body.action).toMatchObject({ name: "check_order_status", httpMethod: "GET" })
    const id = created.body.action.id

    const listed = await request(app).get(`/chatbots/${chatbotId}/actions`).set(authed(session.access_token))
    expect(listed.status).toBe(200)
    expect(listed.body.actions).toHaveLength(1)

    const updated = await request(app)
      .put(`/chatbots/${chatbotId}/actions/${id}`)
      .set(authed(session.access_token))
      .send(validAction({ description: "Updated description." }))
    expect(updated.status).toBe(200)
    expect(updated.body.action.description).toBe("Updated description.")

    const removed = await request(app).delete(`/chatbots/${chatbotId}/actions/${id}`).set(authed(session.access_token))
    expect(removed.status).toBe(204)

    const afterDelete = await request(app).get(`/chatbots/${chatbotId}/actions`).set(authed(session.access_token))
    expect(afterDelete.body.actions).toHaveLength(0)
  })

  it("rejects a name that isn't a safe lowercase/underscore tool identifier", async () => {
    const { session, chatbotId } = await createCrawlPlusActionChatbot("actions-badname")
    const res = await request(app)
      .post(`/chatbots/${chatbotId}/actions`)
      .set(authed(session.access_token))
      .send(validAction({ name: "Check Order Status!" }))
    expect(res.status).toBe(400)
  })

  it("rejects a duplicate action name for the same chatbot with 409", async () => {
    const { session, chatbotId } = await createCrawlPlusActionChatbot("actions-dup")
    await request(app).post(`/chatbots/${chatbotId}/actions`).set(authed(session.access_token)).send(validAction())
    const dup = await request(app).post(`/chatbots/${chatbotId}/actions`).set(authed(session.access_token)).send(validAction())
    expect(dup.status).toBe(409)
  })

  it("never lets one user read, update, or delete another user's chatbot or action", async () => {
    const owner = await createCrawlPlusActionChatbot("actions-owner")
    const attacker = await createCrawlPlusActionChatbot("actions-attacker")

    const created = await request(app).post(`/chatbots/${owner.chatbotId}/actions`).set(authed(owner.session.access_token)).send(validAction())
    const victimActionId = created.body.action.id

    const readAttempt = await request(app).get(`/chatbots/${owner.chatbotId}/actions`).set(authed(attacker.session.access_token))
    expect(readAttempt.status).toBe(404) // the chatbotId itself isn't the attacker's

    const updateAttempt = await request(app)
      .put(`/chatbots/${attacker.chatbotId}/actions/${victimActionId}`)
      .set(authed(attacker.session.access_token))
      .send(validAction({ description: "Hijacked." }))
    expect(updateAttempt.status).toBe(404) // right chatbot (theirs), wrong action id

    const deleteAttempt = await request(app)
      .delete(`/chatbots/${attacker.chatbotId}/actions/${victimActionId}`)
      .set(authed(attacker.session.access_token))
    expect(deleteAttempt.status).toBe(404)

    const ownerListing = await request(app).get(`/chatbots/${owner.chatbotId}/actions`).set(authed(owner.session.access_token))
    expect(ownerListing.body.actions).toHaveLength(1)
  })

  it("blocks creating/editing an action without Crawl Plus", async () => {
    const { session, chatbotId } = await createChatbot("actions-not-gated") // free plan, no upgrade
    const res = await request(app).post(`/chatbots/${chatbotId}/actions`).set(authed(session.access_token)).send(validAction())
    expect(res.status).toBe(402)
  })

  it("requires a current model top-up even for an active Crawl Plus account", async () => {
    const bot = await createChatbot("actions-no-topup")
    await pool!.query(
      `insert into subscriptions (user_id, stripe_customer_id, plan, status) values ($1, $2, 'crawl_plus', 'active')`,
      [bot.userId, `cus_test_no_topup_${Date.now()}`],
    )

    const res = await request(app)
      .post(`/chatbots/${bot.chatbotId}/actions`)
      .set(authed(bot.session.access_token))
      .send(validAction())

    expect(res.status).toBe(402)
    expect(res.body.error).toMatch(/top-up/i)
  })

  it("does not grant Custom Actions to Full Custom accounts", async () => {
    const bot = await createChatbot("actions-full-custom")
    await pool!.query(
      `insert into subscriptions (user_id, stripe_customer_id, plan, status) values ($1, $2, 'full_custom', 'active')`,
      [bot.userId, `cus_test_full_custom_${Date.now()}`],
    )

    const res = await request(app)
      .post(`/chatbots/${bot.chatbotId}/actions`)
      .set(authed(bot.session.access_token))
      .send(validAction())

    expect(res.status).toBe(402)
    expect(res.body.error).toMatch(/Crawl Plus/i)
  })

  it("rejects API credentials in action headers", async () => {
    const { session, chatbotId } = await createCrawlPlusActionChatbot("actions-secret-header")
    const res = await request(app)
      .post(`/chatbots/${chatbotId}/actions`)
      .set(authed(session.access_token))
      .send(validAction({ headersTemplate: { Authorization: "Bearer secret" } }))

    expect(res.status).toBe(400)
  })
})

describe("Backend-link integration credential", () => {
  it("never returns the API key itself, only connection status", async () => {
    const { session, chatbotId } = await createCrawlPlusActionChatbot("integration-status")

    const before = await request(app).get(`/chatbots/${chatbotId}/integration`).set(authed(session.access_token))
    expect(before.status).toBe(200)
    expect(before.body.integration).toEqual({ connected: false, updatedAt: null, apiBaseUrl: null })

    const upserted = await request(app)
      .put(`/chatbots/${chatbotId}/integration`)
      .set(authed(session.access_token))
      .send({ apiKey: "super-secret-key", apiBaseUrl: "https://owner-backend.test/api" })

    // Without INTEGRATION_ENCRYPTION_KEY configured in the test environment,
    // this is a clear 503 (same feature-flagged shape as a missing
    // DATABASE_URL/JWT_SECRET) rather than storing the key insecurely or
    // crashing — both are acceptable outcomes for this assertion, but either
    // way the raw key must never appear in the response body.
    expect(JSON.stringify(upserted.body)).not.toContain("super-secret-key")
    if (upserted.status === 200) {
      expect(upserted.body.integration.connected).toBe(true)
      // Not a secret (unlike the key) — safe, and expected, to read back.
      expect(upserted.body.integration.apiBaseUrl).toBe("https://owner-backend.test/api")

      const after = await request(app).get(`/chatbots/${chatbotId}/integration`).set(authed(session.access_token))
      expect(after.body.integration.apiBaseUrl).toBe("https://owner-backend.test/api")

      // Saving just a new apiBaseUrl (apiKey omitted) must not clobber the
      // already-stored key — re-saving with no apiKey at all should still
      // succeed and leave `connected: true`, not fail or blank the key out.
      const urlOnlyUpdate = await request(app)
        .put(`/chatbots/${chatbotId}/integration`)
        .set(authed(session.access_token))
        .send({ apiBaseUrl: "https://owner-backend.test/v2" })
      expect(urlOnlyUpdate.status).toBe(200)
      expect(urlOnlyUpdate.body.integration.connected).toBe(true)
      expect(urlOnlyUpdate.body.integration.apiBaseUrl).toBe("https://owner-backend.test/v2")
    } else {
      expect(upserted.status).toBe(503)
    }
  })

  it("requires an apiKey the first time (no existing row to fall back to)", async () => {
    const { session, chatbotId } = await createCrawlPlusActionChatbot("integration-first-connect")

    const res = await request(app)
      .put(`/chatbots/${chatbotId}/integration`)
      .set(authed(session.access_token))
      .send({ apiBaseUrl: "https://owner-backend.test/api" })

    // Either INTEGRATION_ENCRYPTION_KEY isn't configured (503, same
    // feature-flagged shape as elsewhere) or it is and this is a real
    // validation failure (400) — both are acceptable, a silent 200 with no
    // key stored is not.
    expect([400, 503]).toContain(res.status)
  })

  it("blocks connecting a backend link without Crawl Plus", async () => {
    const { session, chatbotId } = await createChatbot("integration-not-gated") // free plan
    const res = await request(app)
      .put(`/chatbots/${chatbotId}/integration`)
      .set(authed(session.access_token))
      .send({ apiKey: "some-key" })
    // 402 (plan gate) if INTEGRATION_ENCRYPTION_KEY is configured in this
    // environment, 503 (encryption not configured, checked first) if not —
    // same defensive either-is-acceptable pattern as the test above, since
    // this suite doesn't control that env var.
    expect([402, 503]).toContain(res.status)
  })
})

// PHASE E — proves the exact Custom Action definitions shipped with the two
// demos (demos/booking-api/custom-actions.ts,
// demos/woocommerce-adapter/custom-actions.ts — see each demo's README for
// what they call and why) are accepted as-is by this real, running system,
// not just internally self-consistent within their own demo's test suite.
// Each demo's own contract test (customActionContract.test.ts in that
// package) already proves the definition's {{placeholders}} produce a
// request its own API accepts; what's missing without this test is proof
// that the *registration* step — createActionSchema validation, the
// ACTION_NAME_PATTERN check, Full Custom gating — also accepts them
// unmodified. Relative urlTemplates are made absolute here (real
// registration requires an absolute URL; see actionExecutor.ts's `new
// URL(...)` call) using each demo's own documented API_BASE_URL
// placeholder, exactly as README.md instructs an owner to do.
describe("PHASE E: the demo apps' shipped Custom Action definitions register unmodified", () => {
  it("both booking-api demo actions round-trip through POST /chatbots/:chatbotId/actions", async () => {
    const { CHECK_AVAILABILITY_ACTION, CREATE_BOOKING_ACTION, API_BASE_URL } = await import(
      "../../demos/booking-api/custom-actions.js"
    )
    const { session, chatbotId } = await createCrawlPlusActionChatbot("demo-booking-actions")

    for (const action of [CHECK_AVAILABILITY_ACTION, CREATE_BOOKING_ACTION]) {
      const res = await request(app)
        .post(`/chatbots/${chatbotId}/actions`)
        .set(authed(session.access_token))
        .send({ ...action, urlTemplate: `${API_BASE_URL}${action.urlTemplate}` })
      expect(res.status).toBe(201)
      expect(res.body.action.name).toBe(action.name)
      expect(res.body.action.parameters).toHaveLength(action.parameters.length)
    }
  })

  it("both woocommerce-adapter demo actions round-trip through POST /chatbots/:chatbotId/actions", async () => {
    const { CREATE_ORDER_ACTION, UPDATE_INVENTORY_ACTION, API_BASE_URL } = await import(
      "../../demos/woocommerce-adapter/custom-actions.js"
    )
    const { session, chatbotId } = await createCrawlPlusActionChatbot("demo-woo-actions")

    for (const action of [CREATE_ORDER_ACTION, UPDATE_INVENTORY_ACTION]) {
      const res = await request(app)
        .post(`/chatbots/${chatbotId}/actions`)
        .set(authed(session.access_token))
        .send({ ...action, urlTemplate: `${API_BASE_URL}${action.urlTemplate}` })
      expect(res.status).toBe(201)
      expect(res.body.action.name).toBe(action.name)
      expect(res.body.action.parameters).toHaveLength(action.parameters.length)
    }
  })
})
