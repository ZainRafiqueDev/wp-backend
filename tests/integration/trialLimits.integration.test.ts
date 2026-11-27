import request from "supertest"
import { describe, expect, it } from "vitest"

import { pool } from "../../src/lib/db.js"
import { checkAnsweringGate } from "../../src/services/accessGate.service.js"
import { app, signupUser } from "../helpers.js"

function authed(token: string) {
  return { Authorization: `Bearer ${token}` }
}

describe("Free trial — 1 chatbot limit (Section 2)", () => {
  it("rejects a second chatbot creation attempt with an upgrade-oriented message, not a generic 403", async () => {
    const { session } = await signupUser("trial-limit")

    const first = await request(app)
      .post("/chatbots")
      .set(authed(session.access_token))
      .send({ name: "First bot", sources: [{ type: "pdf", label: "a.pdf", characters: 5, content: "x" }] })
    expect(first.status).toBe(201)

    const second = await request(app)
      .post("/chatbots")
      .set(authed(session.access_token))
      .send({ name: "Second bot", sources: [{ type: "pdf", label: "b.pdf", characters: 5, content: "y" }] })

    expect(second.status).toBe(409)
    expect(second.body.error).toMatch(/upgrade/i)
    expect(second.body.error).not.toBe("Forbidden")
  })
})

describe("Free trial — 30-day expiry gate (Section 2/3, shares the answering gate with the cost cap)", () => {
  it("is not blocked for a freshly-signed-up account", async () => {
    const { session } = await signupUser("trial-fresh")
    const created = await request(app)
      .post("/chatbots")
      .set(authed(session.access_token))
      .send({ name: "Fresh bot", sources: [{ type: "pdf", label: "a.pdf", characters: 5, content: "x" }] })
    const chatbotId = created.body.chatbot.id as string

    const gate = await checkAnsweringGate(chatbotId)
    expect(gate).toEqual({ blocked: false })
  })

  it("blocks with gateReason 'trial_expired' once trial_started_at is more than TRIAL_LENGTH_DAYS ago, for a non-paying account", async () => {
    const { session, user } = await signupUser("trial-expired")
    const created = await request(app)
      .post("/chatbots")
      .set(authed(session.access_token))
      .send({ name: "Old bot", sources: [{ type: "pdf", label: "a.pdf", characters: 5, content: "x" }] })
    const chatbotId = created.body.chatbot.id as string

    // Simulate a signup from 31 days ago — same effect as time actually
    // passing, without a real 31-day wait.
    await pool!.query("update users set trial_started_at = now() - interval '31 days' where id = $1", [user.id])

    const gate = await checkAnsweringGate(chatbotId)
    expect(gate).toEqual({ blocked: true, reason: "trial_expired" })

    // The account-status endpoint the dashboard's embed panel reads should
    // agree with the gate.
    const statusAfter = await request(app).get(`/chatbots/${chatbotId}`).set(authed(session.access_token))
    expect(statusAfter.body.account.isTrialExpired).toBe(true)
  })

  it("an active paid subscription is never subject to the trial clock, however old the account is", async () => {
    const { session, user } = await signupUser("trial-paid")
    const created = await request(app)
      .post("/chatbots")
      .set(authed(session.access_token))
      .send({ name: "Paid bot", sources: [{ type: "pdf", label: "a.pdf", characters: 5, content: "x" }] })
    const chatbotId = created.body.chatbot.id as string

    await pool!.query("update users set trial_started_at = now() - interval '400 days' where id = $1", [user.id])
    await pool!.query(
      `insert into subscriptions (user_id, stripe_customer_id, plan, status) values ($1, $2, 'crawl_plus', 'active')`,
      [user.id, `cus_trial_paid_${Date.now()}`],
    )

    const gate = await checkAnsweringGate(chatbotId)
    expect(gate).toEqual({ blocked: false })
  })
})
