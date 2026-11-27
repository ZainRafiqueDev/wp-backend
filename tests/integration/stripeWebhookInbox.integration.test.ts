import { randomUUID } from "node:crypto"
import request from "supertest"
import { describe, expect, it } from "vitest"

import { hasStripe } from "../../src/env.js"
import { hashPassword } from "../../src/lib/auth.js"
import { app, cookieValue, createReadyChatbotWithDomain, uniqueEmail } from "../helpers.js"
import { pool } from "../../src/lib/db.js"
import { currentBillingPeriod } from "../../src/services/usage.service.js"
import {
  getStripeInboxHealth,
  listStripeInboxEvents,
  purgeExpiredStripeWebhookEvents,
  receiveVerifiedStripeEvent,
  reprocessUnprocessedStripeWebhookEvents,
} from "../../src/services/stripeWebhookInbox.service.js"

function topupEvent(chatbotId: string, sessionId: string, eventId = `evt_${randomUUID()}`) {
  return {
    id: eventId,
    type: "checkout.session.completed",
    data: {
      object: {
        id: sessionId,
        payment_status: "paid",
        amount_total: 1000,
        currency: "usd",
        metadata: {
          topupChatbotId: chatbotId,
          topupModel: "openai",
          topupBillingPeriod: currentBillingPeriod(),
        },
      },
    },
  } as unknown as import("stripe").Stripe.Event
}

async function creditCount(chatbotId: string, sessionId: string): Promise<number> {
  const { rows } = await pool!.query<{ n: string }>(
    "select count(*)::text as n from chatbot_model_credits where chatbot_id = $1 and stripe_checkout_session_id = $2",
    [chatbotId, sessionId],
  )
  return Number(rows[0]?.n ?? 0)
}

describe("WP-1.3 Stripe webhook inbox", () => {
  it("persists a verified event once and ignores a duplicate delivery after processing", async () => {
    const { chatbotId } = await createReadyChatbotWithDomain("inbox-dup", `inbox-dup-${Date.now()}.test`)
    const sessionId = `cs_${randomUUID()}`
    const event = topupEvent(chatbotId, sessionId)

    expect(await receiveVerifiedStripeEvent(event)).toBe("processed")
    expect(await receiveVerifiedStripeEvent(event)).toBe("duplicate")

    const { rows } = await pool!.query(
      "select count(*)::int as n, max(attempts) as attempts from stripe_webhook_events where stripe_event_id = $1",
      [event.id],
    )
    expect(Number(rows[0].n)).toBe(1)
    expect(Number(rows[0].attempts)).toBeGreaterThanOrEqual(1)
    expect(await creditCount(chatbotId, sessionId)).toBe(1)

    const attempted = await pool!.query<{ last_attempt_at: Date | null }>(
      "select last_attempt_at from stripe_webhook_events where stripe_event_id = $1",
      [event.id],
    )
    expect(attempted.rows[0].last_attempt_at).not.toBeNull()
  })

  it("replays an unprocessed inbox row after a crash and still grants once", async () => {
    const { chatbotId } = await createReadyChatbotWithDomain("inbox-replay", `inbox-replay-${Date.now()}.test`)
    const sessionId = `cs_${randomUUID()}`
    const event = topupEvent(chatbotId, sessionId, `evt_replay_${randomUUID()}`)

    await pool!.query(
      `insert into stripe_webhook_events (stripe_event_id, type, payload, received_at, attempts)
       values ($1, $2, $3::jsonb, now() - interval '2 minutes', 1)`,
      [event.id, event.type, JSON.stringify(event)],
    )
    expect(await creditCount(chatbotId, sessionId)).toBe(0)

    const recovered = await reprocessUnprocessedStripeWebhookEvents(200)
    expect(recovered).toBeGreaterThanOrEqual(1)
    expect(await creditCount(chatbotId, sessionId)).toBe(1)

    const { rows } = await pool!.query<{ processed_at: Date | null }>(
      "select processed_at from stripe_webhook_events where stripe_event_id = $1",
      [event.id],
    )
    expect(rows[0].processed_at).not.toBeNull()

    expect(await receiveVerifiedStripeEvent(event)).toBe("duplicate")
    expect(await creditCount(chatbotId, sessionId)).toBe(1)
  })

  it("does not replay an unprocessed row until the configured replay delay has elapsed", async () => {
    const event = topupEvent("unused", `cs_${randomUUID()}`, `evt_fresh_${randomUUID()}`)
    await pool!.query(
      `insert into stripe_webhook_events (stripe_event_id, type, payload, received_at, last_attempt_at, attempts)
       values ($1, $2, $3::jsonb, now(), now(), 1)`,
      [event.id, event.type, JSON.stringify(event)],
    )

    const recovered = await reprocessUnprocessedStripeWebhookEvents(50)
    const { rows } = await pool!.query<{ processed_at: Date | null }>(
      "select processed_at from stripe_webhook_events where stripe_event_id = $1",
      [event.id],
    )
    expect(rows[0].processed_at).toBeNull()
    expect(recovered).toBeGreaterThanOrEqual(0)
  })

  it("does not insert a row when the Stripe signature is invalid", async () => {
    const before = await pool!.query<{ n: string }>("select count(*)::text as n from stripe_webhook_events")
    const res = await request(app)
      .post("/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("stripe-signature", "t=1,v1=not-a-real-signature")
      .send(JSON.stringify({ id: `evt_bad_${randomUUID()}`, type: "checkout.session.completed" }))

    if (hasStripe) {
      expect(res.status).toBe(400)
    } else {
      expect(res.status).toBe(503)
    }

    const after = await pool!.query<{ n: string }>("select count(*)::text as n from stripe_webhook_events")
    expect(Number(after.rows[0].n)).toBe(Number(before.rows[0].n))
  })

  it("exposes unprocessed inbox health on /health", async () => {
    const health = await getStripeInboxHealth()
    expect(health).toMatchObject({ available: true })
    expect(typeof health.unprocessed).toBe("number")

    const res = await request(app).get("/health")
    expect(res.status).toBe(200)
    expect(res.body.billing.stripeInbox).toMatchObject({
      available: expect.any(Boolean),
      unprocessed: expect.any(Number),
      failed: expect.any(Number),
      processing: expect.any(Number),
      duplicates: expect.any(Number),
      replayCount: expect.any(Number),
    })
    expect(health.failed).toEqual(expect.any(Number))
    expect(health.processing).toEqual(expect.any(Number))
    expect(health.duplicates).toEqual(expect.any(Number))
    expect(health.replayCount).toEqual(expect.any(Number))
  })

  it("lists inbox rows for an admin without exposing the payload", async () => {
    const email = uniqueEmail("inbox-admin")
    const password = "a very strong admin password"
    await pool!.query("insert into admin_users (email, password_hash, name) values ($1, $2, $3)", [
      email,
      await hashPassword(password),
      "Inbox Admin",
    ])
    const login = await request(app).post("/admin/login").send({ email, password })
    expect(login.status).toBe(200)

    const { chatbotId } = await createReadyChatbotWithDomain("inbox-admin", `inbox-admin-${Date.now()}.test`)
    const sessionId = `cs_${randomUUID()}`
    const customer = `cus_${randomUUID()}`
    const event = topupEvent(chatbotId, sessionId)
    ;(event.data.object as { customer?: string }).customer = customer
    await receiveVerifiedStripeEvent(event)

    const res = await request(app)
      .get("/admin/stripe-inbox")
      .set({ Cookie: `chatmate360_admin_token=${cookieValue(login, "chatmate360_admin_token")}` })
    expect(res.status).toBe(200)
    expect(res.body.health).toMatchObject({ available: true })
    expect(Array.isArray(res.body.events)).toBe(true)
    expect(typeof res.body.total).toBe("number")
    expect(typeof res.body.limit).toBe("number")
    expect(typeof res.body.offset).toBe("number")
    for (const listed of res.body.events) {
      expect(listed.payload).toBeUndefined()
      expect(listed.stripeEventId).toEqual(expect.any(String))
    }

    const filtered = await request(app)
      .get("/admin/stripe-inbox")
      .query({
        status: "processed",
        type: "checkout.session.completed",
        customer,
        limit: 10,
        offset: 0,
      })
      .set({ Cookie: `chatmate360_admin_token=${cookieValue(login, "chatmate360_admin_token")}` })
    expect(filtered.status).toBe(200)
    expect(filtered.body.events.some((row: { stripeEventId: string }) => row.stripeEventId === event.id)).toBe(true)
    expect(filtered.body.events.every((row: { type: string }) => row.type === "checkout.session.completed")).toBe(true)

    const listed = await listStripeInboxEvents({ status: "processed", type: "checkout.session.completed", customer, limit: 10, offset: 0 })
    expect(listed.events.some((row) => row.stripeEventId === event.id)).toBe(true)
  })

  it("purges processed inbox rows older than the retention window", async () => {
    const eventId = `evt_purge_${randomUUID()}`
    await pool!.query(
      `insert into stripe_webhook_events (stripe_event_id, type, payload, received_at, processed_at, attempts)
       values ($1, 'checkout.session.completed', '{}'::jsonb, now() - interval '200 days', now() - interval '200 days', 1)`,
      [eventId],
    )
    const deleted = await purgeExpiredStripeWebhookEvents()
    expect(deleted).toBeGreaterThanOrEqual(1)
    const { rows } = await pool!.query("select 1 from stripe_webhook_events where stripe_event_id = $1", [eventId])
    expect(rows).toHaveLength(0)
  })
})
