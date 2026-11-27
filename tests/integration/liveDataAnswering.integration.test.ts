import { randomUUID } from "node:crypto"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { testAccessToken } from "../helpers/testSession.js"
import { pool } from "../../src/lib/db.js"

// Same cross-module mocking approach as chatbot.integration.test.ts's crawler
// mock — mocks the module answerChatbotQuestion.ts actually imports, so the
// real merge/cache/grounding logic under test still runs end to end through
// the real HTTP routes.
const { answerQuestionMock } = vi.hoisted(() => ({ answerQuestionMock: vi.fn() }))
vi.mock("../../src/lib/ai.js", () => ({ answerQuestion: answerQuestionMock }))

const { app } = await import("../helpers.js")

function authed(token: string) {
  return { Authorization: `Bearer ${token}` }
}

async function seedChatbot(): Promise<{ token: string; chatbotId: string }> {
  const user = await pool!.query<{ id: string }>(
    `insert into users (email, password_hash, name, email_verified) values ($1, 'x', $2, true) returning id`,
    [`livedata-${randomUUID()}@example.test`, "livedata"],
  )
  const sources = [{ type: "pdf", label: "about.pdf", characters: 30, content: "Acme sells outdoor gear." }]
  const bot = await pool!.query<{ id: string }>(
    `insert into chatbots (user_id, name, sources, status) values ($1, 'Acme Store', $2::jsonb, 'ready') returning id`,
    [user.rows[0].id, JSON.stringify(sources)],
  )
  return { token: await testAccessToken(user.rows[0].id), chatbotId: bot.rows[0].id }
}

beforeEach(() => {
  answerQuestionMock.mockReset()
})

// Ask about a product before any live-data row exists (graceful fallback),
// after adding one (a live-grounded answer), and once more immediately
// after. WP-1.6 does not cache live answers, so the repeat must call the
// provider again instead of serving a stale cached stock count.
describe("chatbot preview chat — live data end to end", () => {
  it("falls back gracefully before live data exists, answers correctly once it's added, and does not cache the live answer", async () => {
    const { token, chatbotId } = await seedChatbot()
    const sessionToken = token

    // 1. Before any live-data row: nothing in crawled content or live data
    // mentions stock, so the deterministic relevance gate (lib/relevance.ts)
    // should skip the AI call entirely and return the fixed fallback.
    const before = await request(app)
      .post(`/chatbots/${chatbotId}/chat`)
      .set(authed(sessionToken))
      .send({ question: "is the tent in stock?", history: [] })
    expect(before.status).toBe(200)
    expect(before.body.aiGenerated).toBe(false)
    expect(answerQuestionMock).not.toHaveBeenCalled()

    // 2. Add a live-data row.
    const liveDataRes = await request(app)
      .post(`/chatbots/${chatbotId}/live-data`)
      .set(authed(sessionToken))
      .send({ key: "Tent stock", value: "7 in stock" })
    expect(liveDataRes.status).toBe(201)

    answerQuestionMock.mockResolvedValue("Yes, the tent is in stock — 7 available.")

    const after = await request(app)
      .post(`/chatbots/${chatbotId}/chat`)
      .set(authed(sessionToken))
      .send({ question: "is the tent in stock?", history: [] })
    expect(after.status).toBe(200)
    expect(after.body.aiGenerated).toBe(true)
    expect(after.body.text).toBe("Yes, the tent is in stock — 7 available.")
    expect(answerQuestionMock).toHaveBeenCalledTimes(1)
    // The merged pages passed to the AI provider include the live-data entry,
    // clearly tagged, ahead of the unrelated crawled "about" content.
    const pagesArg = answerQuestionMock.mock.calls[0][1]
    expect(pagesArg[0]).toMatchObject({ title: "Tent stock", text: "7 in stock", kind: "live" })

    const repeat = await request(app)
      .post(`/chatbots/${chatbotId}/chat`)
      .set(authed(sessionToken))
      .send({ question: "is the tent in stock?", history: [] })
    expect(repeat.status).toBe(200)
    expect(repeat.body.text).toBe("Yes, the tent is in stock — 7 available.")
    expect(answerQuestionMock).toHaveBeenCalledTimes(2)
  })
})
