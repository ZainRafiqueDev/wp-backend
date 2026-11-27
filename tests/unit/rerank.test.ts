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
vi.mock("../../src/env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/env.js")>()
  return { env: { ...actual.env, retrievalRerankEnabled: true } }
})

const { completeCheaply } = await import("../../src/lib/ai.js")
const { recordUsage } = await import("../../src/services/usage.service.js")
const { env } = await import("../../src/env.js")
const { rerankChunks } = await import("../../src/lib/rerank.js")

function chunk(id: string, fileName = "doc.txt") {
  return { id, content: `content for ${id}`, fileName, score: 0, lexicalRank: null, vectorRank: null }
}

describe("WP-3.2 rerank", () => {
  beforeEach(() => {
    vi.mocked(completeCheaply).mockReset()
    vi.mocked(recordUsage).mockClear()
    env.retrievalRerankEnabled = true
  })

  it("skips the LLM call with 0 or 1 candidates — nothing to reorder", async () => {
    expect(await rerankChunks("chatbot-1", "q", [], 5)).toEqual([])
    const single = [chunk("a")]
    expect(await rerankChunks("chatbot-1", "q", single, 5)).toEqual(single)
    expect(completeCheaply).not.toHaveBeenCalled()
  })

  it("reorders candidates according to the model's ranked list", async () => {
    vi.mocked(completeCheaply).mockResolvedValue("3,1,2")
    const candidates = [chunk("a"), chunk("b"), chunk("c")]
    const result = await rerankChunks("chatbot-1", "q", candidates, 3)
    expect(result.map((c) => c.id)).toEqual(["c", "a", "b"])
  })

  it("truncates to topN after reordering", async () => {
    vi.mocked(completeCheaply).mockResolvedValue("3,1,2")
    const candidates = [chunk("a"), chunk("b"), chunk("c")]
    const result = await rerankChunks("chatbot-1", "q", candidates, 2)
    expect(result.map((c) => c.id)).toEqual(["c", "a"])
  })

  it("appends any candidate number missing from a malformed response, never dropping one", async () => {
    vi.mocked(completeCheaply).mockResolvedValue("2")
    const candidates = [chunk("a"), chunk("b"), chunk("c")]
    const result = await rerankChunks("chatbot-1", "q", candidates, 3)
    expect(result.map((c) => c.id)).toEqual(["b", "a", "c"])
  })

  it("ignores out-of-range and duplicate numbers in the response", async () => {
    vi.mocked(completeCheaply).mockResolvedValue("2, 2, 99, 1")
    const candidates = [chunk("a"), chunk("b")]
    const result = await rerankChunks("chatbot-1", "q", candidates, 2)
    expect(result.map((c) => c.id)).toEqual(["b", "a"])
  })

  it("falls back to the original fused order when the model returns nothing", async () => {
    vi.mocked(completeCheaply).mockResolvedValue(null)
    const candidates = [chunk("a"), chunk("b")]
    const result = await rerankChunks("chatbot-1", "q", candidates, 2)
    expect(result.map((c) => c.id)).toEqual(["a", "b"])
  })

  it("falls back to the original fused order on a thrown error — never propagates", async () => {
    vi.mocked(completeCheaply).mockRejectedValue(new Error("provider timeout"))
    const candidates = [chunk("a"), chunk("b")]
    const result = await rerankChunks("chatbot-1", "q", candidates, 2)
    expect(result.map((c) => c.id)).toEqual(["a", "b"])
  })

  it("skips the LLM call entirely when disabled via config", async () => {
    env.retrievalRerankEnabled = false
    const candidates = [chunk("a"), chunk("b")]
    const result = await rerankChunks("chatbot-1", "q", candidates, 2)
    expect(result.map((c) => c.id)).toEqual(["a", "b"])
    expect(completeCheaply).not.toHaveBeenCalled()
  })

  it("charges the rerank cost to the tenant when the model reports usage", async () => {
    vi.mocked(completeCheaply).mockImplementation(async (_system, _prompt, usageSink) => {
      usageSink?.push({ provider: "gemini", model: "gemini-flash-latest", inputTokens: 80, outputTokens: 5 })
      return "1,2"
    })
    const candidates = [chunk("a"), chunk("b")]
    await rerankChunks("chatbot-1", "q", candidates, 2)
    expect(recordUsage).toHaveBeenCalledWith(
      "chatbot-1",
      expect.arrayContaining([expect.objectContaining({ provider: "gemini" })]),
    )
  })
})
