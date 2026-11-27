import request from "supertest"
import { describe, expect, it } from "vitest"

import { hasStripe } from "../../src/env.js"
import { app, signupUser } from "../helpers.js"

// Exercises the real route wiring (app.ts raw-body mount, the controller's
// hasStripe gate). Behaviour depends on whether this environment has Stripe
// keys — CI/.env.example do not; a local machine with test keys does.
describe("POST /webhooks/stripe (route wiring)", () => {
  it("does not treat an unsigned payload as a successful event", async () => {
    const res = await request(app)
      .post("/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("stripe-signature", "t=1,v1=not-a-real-signature")
      .send(JSON.stringify({ type: "checkout.session.completed" }))

    if (hasStripe) {
      expect(res.status).toBe(400)
    } else {
      expect(res.status).toBe(503)
    }
  })
})

describe("POST /billing/checkout-session", () => {
  it("requires authentication", async () => {
    const res = await request(app).post("/billing/checkout-session").send({ plan: "crawl_plus" })
    expect(res.status).toBe(401)
  })

  it("rejects a plan value outside the configured tiers", async () => {
    const { session } = await signupUser("billing-invalid-plan")
    const res = await request(app)
      .post("/billing/checkout-session")
      .set("Authorization", `Bearer ${session.access_token}`)
      .send({ plan: "not-a-real-plan" })
    expect(res.status).toBe(400)
  })

  it("does not 500 when Stripe is missing or when checkout is attempted", async () => {
    const { session } = await signupUser("billing-unconfigured")
    const res = await request(app)
      .post("/billing/checkout-session")
      .set("Authorization", `Bearer ${session.access_token}`)
      .send({ plan: "crawl_plus" })
    if (hasStripe) {
      expect(res.status).not.toBe(500)
      expect([200, 502, 503]).toContain(res.status)
    } else {
      expect(res.status).toBe(503)
    }
  })
})
