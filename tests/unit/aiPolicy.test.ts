import { describe, expect, it } from "vitest"

import { env } from "../../src/env.js"
import { buildRetrievalQuery, estimateAnswerInputTokens } from "../../src/lib/answerChatbotQuestion.js"
import { estimateReservationUsd } from "../../src/lib/aiPricing.js"

describe("AI usage and retrieval policy", () => {
  it("uses recent user context for an ambiguous follow-up", () => {
    const query = buildRetrievalQuery("How much is it?", [
      { role: "user", content: "Tell me about the Crawl Plus plan." },
      { role: "assistant", content: "It supports crawling and documents." },
    ])

    expect(query).toContain("Crawl Plus")
    expect(query).toContain("assistant: It supports crawling and documents.")
    expect(query).toContain("Follow-up: How much is it?")
  })

  it("keeps a short but self-contained question independent", () => {
    const question = "What are your hours?"
    expect(buildRetrievalQuery(question, [
      { role: "user", content: "Tell me about document uploads." },
      { role: "assistant", content: "Up to 25 documents." },
    ])).toBe(question)
  })

  it("does not contaminate a self-contained question with old topics", () => {
    const question = "Which payment methods are accepted for annual subscriptions?"
    expect(buildRetrievalQuery(question, [
      { role: "user", content: "Tell me about document uploads." },
    ])).toBe(question)
  })

  it("estimates larger prompts as more expensive while respecting reservation bounds", () => {
    const small = estimateReservationUsd("openai", 500)
    const large = estimateReservationUsd("openai", 50_000)

    expect(small).toBeGreaterThanOrEqual(env.minPerCallCostReservationUsd)
    expect(large).toBeGreaterThan(small)
    expect(large).toBeLessThanOrEqual(env.perCallCostReservationUsd)
  })

  it("fails reservation estimates closed for unknown-priced models", () => {
    const previous = env.openaiModel
    env.openaiModel = "unpriced-future-model"
    try {
      expect(estimateReservationUsd("openai", 1_000)).toBe(Number.POSITIVE_INFINITY)
    } finally {
      env.openaiModel = previous
    }
  })

  it("includes page, history, question, tool, and prompt overhead in token estimates", () => {
    const estimate = estimateAnswerInputTokens(
      [{ path: "/", title: "Home", text: "x".repeat(5_000), kind: "crawled" }],
      [{ role: "user", content: "Earlier question" }],
      "Current question",
      [{ name: "lookup", description: "Look up an order", parameters: [] }],
    )

    expect(estimate).toBeGreaterThan(3_000)
  })
})
