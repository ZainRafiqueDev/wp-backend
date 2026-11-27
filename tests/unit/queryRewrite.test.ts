import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../src/lib/ai.js", () => ({
  completeCheaply: vi.fn(),
}))
vi.mock("../../src/services/usage.service.js", () => ({
  recordUsage: vi.fn(async () => {}),
}))
// NEW-01: completeCheaply is mocked here, so the reservation authorizer it is
// handed is never used; keep its billing imports out of this unit test.
vi.mock("../../src/lib/cheapCallBilling.js", () => ({
  cheapCallAuthorizer: vi.fn(() => async () => ({ ok: false })),
}))

const { completeCheaply } = await import("../../src/lib/ai.js")
const { recordUsage } = await import("../../src/services/usage.service.js")
const { rewriteQueryForRetrieval } = await import("../../src/lib/queryRewrite.js")

describe("WP-3.1 query rewriting", () => {
  beforeEach(() => {
    vi.mocked(completeCheaply).mockReset()
    vi.mocked(recordUsage).mockClear()
  })

  it("skips the LLM entirely on the first turn — nothing to resolve against", async () => {
    const result = await rewriteQueryForRetrieval("chatbot-1", "How much is it?", [])
    expect(result).toBeNull()
    expect(completeCheaply).not.toHaveBeenCalled()
  })

  it("returns the rewritten query for a multi-turn follow-up", async () => {
    vi.mocked(completeCheaply).mockResolvedValue("Crawl Plus plan pricing")
    const result = await rewriteQueryForRetrieval("chatbot-1", "How much is it?", [
      { role: "user", content: "Tell me about the Crawl Plus plan." },
      { role: "assistant", content: "It supports crawling and documents." },
    ])
    expect(result).toBe("Crawl Plus plan pricing")
  })

  it("charges the rewrite cost to the tenant when the model reports usage", async () => {
    vi.mocked(completeCheaply).mockImplementation(async (_system, _prompt, usageSink) => {
      usageSink?.push({ provider: "gemini", model: "gemini-flash-latest", inputTokens: 50, outputTokens: 10 })
      return "web development services"
    })
    await rewriteQueryForRetrieval("chatbot-1", "web dev?", [
      { role: "user", content: "Do you offer web dev?" },
      { role: "assistant", content: "Yes, we do." },
    ])
    expect(recordUsage).toHaveBeenCalledWith("chatbot-1", expect.arrayContaining([expect.objectContaining({ provider: "gemini" })]))
  })

  it("falls back to null (caller uses the free heuristic) when the model returns nothing", async () => {
    vi.mocked(completeCheaply).mockResolvedValue(null)
    const result = await rewriteQueryForRetrieval("chatbot-1", "price?", [
      { role: "user", content: "Tell me about plans." },
      { role: "assistant", content: "We have Free, Crawl Plus, and Custom." },
    ])
    expect(result).toBeNull()
  })

  it("falls back to null on a thrown error — never propagates the failure", async () => {
    vi.mocked(completeCheaply).mockRejectedValue(new Error("provider timeout"))
    const result = await rewriteQueryForRetrieval("chatbot-1", "price?", [
      { role: "user", content: "Tell me about plans." },
      { role: "assistant", content: "We have Free, Crawl Plus, and Custom." },
    ])
    expect(result).toBeNull()
  })

  it("caps the rewritten query at 150 characters even if the model ignores the instruction", async () => {
    vi.mocked(completeCheaply).mockResolvedValue("x".repeat(300))
    const result = await rewriteQueryForRetrieval("chatbot-1", "tell me more", [
      { role: "user", content: "Tell me about plans." },
      { role: "assistant", content: "We have Free, Crawl Plus, and Custom." },
    ])
    expect(result).toHaveLength(150)
  })
})
