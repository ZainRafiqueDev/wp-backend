import request from "supertest"
import { describe, expect, it } from "vitest"

import { env } from "../../src/env.js"
import { pool } from "../../src/lib/db.js"
import { app, signupUser } from "../helpers.js"

function authed(token: string) {
  return { Authorization: `Bearer ${token}` }
}

async function upgradeToCrawlPlus(userId: string): Promise<void> {
  await pool!.query(
    `insert into subscriptions (user_id, stripe_customer_id, plan, status) values ($1, $2, 'crawl_plus', 'active')`,
    [userId, `cus_test_${userId}`],
  )
}

function botPayload(name: string) {
  return { name, sources: [{ type: "pdf" as const, label: "a.pdf", characters: 5, content: "x" }] }
}

// PHASE A — the multi-chatbot mechanics itself (lifting the old unique
// constraint, enforcing the plan's real max_chatbots instead), distinct
// from tests/integration/trialLimits.integration.test.ts's free-plan-
// specific 1-chatbot coverage.
describe("Multi-chatbot support (Phase A)", () => {
  it("a Crawl Plus account can create chatbots up to its plan's limit, and the next one is rejected with an upgrade-aware message", async () => {
    const { session, user } = await signupUser("multi-crawlplus")
    await upgradeToCrawlPlus(user.id)

    const results: number[] = []
    for (let i = 0; i < env.crawlPlusPlanMaxChatbots; i++) {
      const res = await request(app).post("/chatbots").set(authed(session.access_token)).send(botPayload(`bot-${i}`))
      results.push(res.status)
    }
    expect(results.every((s) => s === 201)).toBe(true)

    const overLimit = await request(app).post("/chatbots").set(authed(session.access_token)).send(botPayload("one-too-many"))
    expect(overLimit.status).toBe(409)
    // Already on an active paid plan — the message reflects "you've hit
    // your plan's ceiling," not "upgrade your free trial" (that copy is
    // specifically for a non-entitled account, see chatbot.service.ts).
    expect(overLimit.body.error).toMatch(new RegExp(`limit of ${env.crawlPlusPlanMaxChatbots}`))

    const list = await request(app).get("/chatbots").set(authed(session.access_token))
    expect(list.status).toBe(200)
    expect(list.body.chatbots).toHaveLength(env.crawlPlusPlanMaxChatbots)
  })

  it("a second user's chatbots are never visible in another user's list view", async () => {
    const userA = await signupUser("multi-isolation-a")
    await upgradeToCrawlPlus(userA.user.id)
    await request(app).post("/chatbots").set(authed(userA.session.access_token)).send(botPayload("a-bot-1"))
    await request(app).post("/chatbots").set(authed(userA.session.access_token)).send(botPayload("a-bot-2"))

    const userB = await signupUser("multi-isolation-b")
    await request(app).post("/chatbots").set(authed(userB.session.access_token)).send(botPayload("b-bot-1"))

    const listA = await request(app).get("/chatbots").set(authed(userA.session.access_token))
    expect(listA.body.chatbots).toHaveLength(2)
    expect(listA.body.chatbots.every((entry: { chatbot: { name: string } }) => entry.chatbot.name.startsWith("a-bot"))).toBe(true)

    const listB = await request(app).get("/chatbots").set(authed(userB.session.access_token))
    expect(listB.body.chatbots).toHaveLength(1)
    expect(listB.body.chatbots[0].chatbot.name).toBe("b-bot-1")
  })

  it("each of an account's chatbots works independently and is reachable by its own id, not just the first one created", async () => {
    const { session, user } = await signupUser("multi-independent")
    await upgradeToCrawlPlus(user.id)

    const first = await request(app).post("/chatbots").set(authed(session.access_token)).send(botPayload("first-bot"))
    const second = await request(app).post("/chatbots").set(authed(session.access_token)).send(botPayload("second-bot"))
    expect(first.body.chatbot.id).not.toBe(second.body.chatbot.id)

    const getFirst = await request(app).get(`/chatbots/${first.body.chatbot.id}`).set(authed(session.access_token))
    const getSecond = await request(app).get(`/chatbots/${second.body.chatbot.id}`).set(authed(session.access_token))
    expect(getFirst.body.chatbot.name).toBe("first-bot")
    expect(getSecond.body.chatbot.name).toBe("second-bot")

    // Updating one doesn't touch the other.
    await request(app)
      .patch(`/chatbots/${first.body.chatbot.id}/fallback-message`)
      .set(authed(session.access_token))
      .send({ fallbackMessage: "Only for the first bot." })
    const secondAfter = await request(app).get(`/chatbots/${second.body.chatbot.id}`).set(authed(session.access_token))
    expect(secondAfter.body.chatbot.fallbackMessage).toBeUndefined()
  })

  it("a chatbot id that belongs to another user 404s rather than leaking any detail", async () => {
    const owner = await signupUser("multi-notfound-owner")
    const created = await request(app).post("/chatbots").set(authed(owner.session.access_token)).send(botPayload("owner-bot"))
    const chatbotId = created.body.chatbot.id as string

    const attacker = await signupUser("multi-notfound-attacker")
    const res = await request(app).get(`/chatbots/${chatbotId}`).set(authed(attacker.session.access_token))
    expect(res.status).toBe(404)
  })
})
