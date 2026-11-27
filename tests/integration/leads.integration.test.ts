import request from "supertest"
import { describe, expect, it } from "vitest"

import { app, signupUser, uniqueEmail } from "../helpers.js"
import { verifyCalendlySignature } from "../../src/lib/calendly.js"
import { createHmac } from "node:crypto"
import { env } from "../../src/env.js"
import { pool } from "../../src/lib/db.js"

const BOTS = ["Leads Agent", "Booking Agent"]

describe("Full Custom lead capture (replaces self-service checkout for that plan)", () => {
  it("an anonymous visitor can submit a lead, no account required", async () => {
    const res = await request(app)
      .post("/leads")
      .send({ name: "Anon Visitor", email: uniqueEmail("anon-lead"), phone: "+1 555 000 1111", selectedBots: BOTS })

    expect(res.status).toBe(201)
    expect(res.body.lead.userId).toBeNull()
    expect(res.body.lead.status).toBe("lead")
    expect(res.body.lead.selectedBots).toEqual(BOTS)
  })

  it("rejects a submission with no bots selected", async () => {
    const res = await request(app)
      .post("/leads")
      .send({ name: "No Bots", email: uniqueEmail("no-bots"), phone: "+1 555 000 2222", selectedBots: [] })
    expect(res.status).toBe(400)
  })

  // GHSA-mrhx-c7xc-m3w5: zod's array parsing collects one issue per failing
  // element with no cap, so an unconstrained array schema fed a huge array
  // of invalid values can force unbounded allocation before it ever
  // responds — a real DoS vector on a route an anonymous visitor can hit
  // with no rate limit of its own. selectedBots is now capped at
  // BOT_OPTIONS.length (lead.validator.ts). This proves the cap itself
  // rejects fast, not just that it eventually rejects. Sized to stay under
  // express.json's 256kb body limit (app.ts) so this exercises the zod cap
  // specifically, not body-parser's own limit (see the 413 test below for
  // that one).
  it("rejects an oversized selectedBots array fast (400), not after validating every element", async () => {
    const invalidArray = Array.from({ length: 2000 }, (_, i) => `not-a-real-bot-${i}`)
    const started = performance.now()
    const res = await request(app)
      .post("/leads")
      .send({ name: "Oversized", email: uniqueEmail("oversized-bots"), phone: "+1 555 000 9999", selectedBots: invalidArray })
    const elapsedMs = performance.now() - started

    expect(res.status).toBe(400)
    expect(elapsedMs).toBeLessThan(500)
  })

  // Found while sizing the test above: a body genuinely over express.json's
  // 256kb limit (app.ts) was falling through errorHandler.ts's generic
  // catch-all as an "unhandled error" (500, logged as a server bug) instead
  // of the clean 413 a client-caused oversized request should get — fixed
  // alongside (errorHandler.ts's new entity.too.large branch).
  it("a request body over the 256kb limit gets a clean 413, not a 500", async () => {
    const hugeInvalidArray = Array.from({ length: 50_000 }, (_, i) => `not-a-real-bot-${i}`)
    const res = await request(app)
      .post("/leads")
      .send({ name: "Way Too Big", email: uniqueEmail("too-big-body"), phone: "+1 555 000 8888", selectedBots: hugeInvalidArray })
    expect(res.status).toBe(413)
  })

  it("GET /leads/me requires authentication", async () => {
    const res = await request(app).get("/leads/me")
    expect(res.status).toBe(401)
  })

  it("a logged-in user's second submission updates the same row instead of creating a duplicate", async () => {
    const { session } = await signupUser("lead-idempotent")
    const token = session.access_token

    const first = await request(app)
      .post("/leads")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "First Name", email: uniqueEmail("lead-idempotent"), phone: "+1 555 000 3333", selectedBots: ["Leads Agent"] })
    expect(first.status).toBe(201)

    const second = await request(app)
      .post("/leads")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Updated Name", email: uniqueEmail("lead-idempotent-2"), phone: "+1 555 000 4444", selectedBots: ["Booking Agent", "Leads Agent"] })
    expect(second.status).toBe(201)
    expect(second.body.lead.id).toBe(first.body.lead.id)
    expect(second.body.lead.name).toBe("Updated Name")

    const count = await pool!.query("select count(*) as c from leads where user_id = $1", [first.body.lead.userId])
    expect(Number(count.rows[0].c)).toBe(1)
  })

  it("a returning logged-in user with an active lead sees it via GET /leads/me, and can edit it via PATCH", async () => {
    const { session } = await signupUser("lead-returning")
    const token = session.access_token

    const created = await request(app)
      .post("/leads")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Returning User", email: uniqueEmail("lead-returning"), phone: "+1 555 000 5555", selectedBots: ["Leads Agent"] })
    expect(created.status).toBe(201)

    const fetched = await request(app).get("/leads/me").set("Authorization", `Bearer ${token}`)
    expect(fetched.status).toBe(200)
    expect(fetched.body.lead.id).toBe(created.body.lead.id)
    expect(fetched.body.lead.status).toBe("lead")

    const edited = await request(app)
      .patch("/leads/me")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Edited Name", email: created.body.lead.email, phone: "+1 555 000 6666", selectedBots: ["Email Automation Agent"] })
    expect(edited.status).toBe(200)
    expect(edited.body.lead.id).toBe(created.body.lead.id)
    expect(edited.body.lead.name).toBe("Edited Name")
    expect(edited.body.lead.selectedBots).toEqual(["Email Automation Agent"])
  })

  it("PATCH /leads/me 404s when the account has no active lead", async () => {
    const { session } = await signupUser("lead-no-active")
    const res = await request(app)
      .patch("/leads/me")
      .set("Authorization", `Bearer ${session.access_token}`)
      .send({ name: "X", email: uniqueEmail("x"), phone: "+1 555 000 7777", selectedBots: ["Leads Agent"] })
    expect(res.status).toBe(404)
  })
})

describe("Calendly webhook signature verification (lib/calendly.ts)", () => {
  it("accepts a correctly-signed payload and rejects a tampered one", () => {
    const signingKey = "test-signing-key"
    const body = Buffer.from(JSON.stringify({ event: "invitee.created", payload: { email: "a@b.com" } }))
    const t = String(Math.floor(Date.now() / 1000))
    const v1 = createHmac("sha256", signingKey).update(`${t}.${body.toString("utf8")}`).digest("hex")
    const header = `t=${t},v1=${v1}`

    expect(verifyCalendlySignature(body, header, signingKey)).toBe(true)
    expect(verifyCalendlySignature(body, header, "wrong-key")).toBe(false)
    expect(verifyCalendlySignature(body, undefined, signingKey)).toBe(false)
  })

  // Audit 2026-11-27: a correctly signed but old (replayed) webhook is refused.
  it("rejects a correctly-signed payload whose timestamp is outside the tolerance window", () => {
    const signingKey = "test-signing-key"
    const body = Buffer.from(JSON.stringify({ event: "invitee.created", payload: { email: "a@b.com" } }))
    const t = String(Math.floor(Date.now() / 1000) - 60 * 60)
    const v1 = createHmac("sha256", signingKey).update(`${t}.${body.toString("utf8")}`).digest("hex")
    expect(verifyCalendlySignature(body, `t=${t},v1=${v1}`, signingKey)).toBe(false)
    expect(verifyCalendlySignature(body, `t=${t},v1=${v1}`, signingKey, Number(t) * 1000 + 1000)).toBe(true)
  })
})

function signCalendly(body: string, signingKey: string): string {
  const t = String(Math.floor(Date.now() / 1000))
  const v1 = createHmac("sha256", signingKey).update(`${t}.${body}`).digest("hex")
  return `t=${t},v1=${v1}`
}

describe("POST /webhooks/calendly (route wiring)", () => {
  const signingKey = "test-calendly-signing-key"

  it("503s when the Calendly webhook isn't configured, rather than a misleading 400", async () => {
    env.calendlyWebhookSigningKey = ""
    const res = await request(app)
      .post("/webhooks/calendly")
      .set("Content-Type", "application/json")
      .set("calendly-webhook-signature", "t=1,v1=not-a-real-signature")
      .send(JSON.stringify({ event: "invitee.created", payload: { email: "a@b.com" } }))
    expect(res.status).toBe(503)
  })

  it("400s on an invalid signature when the key is set", async () => {
    env.calendlyWebhookSigningKey = signingKey
    const body = JSON.stringify({ event: "invitee.created", payload: { email: "a@b.com" } })
    const res = await request(app)
      .post("/webhooks/calendly")
      .set("Content-Type", "application/json")
      .set("calendly-webhook-signature", "t=1,v1=deadbeef")
      .send(body)
    env.calendlyWebhookSigningKey = ""
    expect(res.status).toBe(400)
  })

  it("400s on invalid JSON even with a valid signature", async () => {
    env.calendlyWebhookSigningKey = signingKey
    const body = "{not-json"
    const res = await request(app)
      .post("/webhooks/calendly")
      .set("Content-Type", "application/json")
      .set("calendly-webhook-signature", signCalendly(body, signingKey))
      .send(body)
    env.calendlyWebhookSigningKey = ""
    expect(res.status).toBe(400)
  })

  it("marks the matching lead booked on a signed invitee.created, and a duplicate delivery stays booked", async () => {
    env.calendlyWebhookSigningKey = signingKey
    const email = uniqueEmail("calendly-booked")
    const created = await request(app)
      .post("/leads")
      .send({ name: "Booked Lead", email, phone: "+1 555 010 0101", selectedBots: BOTS })
    expect(created.status).toBe(201)

    const payload = {
      event: "invitee.created",
      payload: {
        email,
        uri: "https://api.calendly.com/scheduled_events/invitees/test",
        scheduled_event: { name: "30 Minute Meeting", start_time: "2026-10-01T15:00:00.000000Z" },
      },
    }
    const body = JSON.stringify(payload)
    const first = await request(app)
      .post("/webhooks/calendly")
      .set("Content-Type", "application/json")
      .set("calendly-webhook-signature", signCalendly(body, signingKey))
      .send(body)
    expect(first.status).toBe(200)

    const row = await pool!.query(
      "select status, meeting_name, meeting_starts_at from leads where id = $1",
      [created.body.lead.id],
    )
    expect(row.rows[0].status).toBe("booked")
    expect(row.rows[0].meeting_name).toBe("30 Minute Meeting")

    const replay = await request(app)
      .post("/webhooks/calendly")
      .set("Content-Type", "application/json")
      .set("calendly-webhook-signature", signCalendly(body, signingKey))
      .send(body)
    env.calendlyWebhookSigningKey = ""
    expect(replay.status).toBe(200)
    const again = await pool!.query("select status from leads where id = $1", [created.body.lead.id])
    expect(again.rows[0].status).toBe("booked")
  })

  it("200s and does not throw for a signed event type we do not handle", async () => {
    env.calendlyWebhookSigningKey = signingKey
    const body = JSON.stringify({ event: "invitee.canceled", payload: { email: "nobody@example.test" } })
    const res = await request(app)
      .post("/webhooks/calendly")
      .set("Content-Type", "application/json")
      .set("calendly-webhook-signature", signCalendly(body, signingKey))
      .send(body)
    env.calendlyWebhookSigningKey = ""
    expect(res.status).toBe(200)
  })
})
