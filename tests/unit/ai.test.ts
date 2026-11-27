import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// env.ts reads its provider keys at module-evaluation time, so they have to
// be stubbed before the first import of env.js/ai.js in this file — every
// other test file in the suite deliberately runs with NO AI provider keys
// configured (see vitest.config.ts), so this is scoped to just this file via
// dynamic import rather than added to the global test env.
vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-key")
vi.stubEnv("OPENAI_API_KEY", "test-openai-key")
vi.resetModules()

const { answerQuestion } = await import("../../src/lib/ai.js")

const page = { path: "/", title: "About", text: "Some page content about the business." }

function jsonResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body, text: async () => JSON.stringify(body) } as Response
}

describe("answerQuestion provider fallback chain", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("returns the first successful provider's answer and doesn't call the next one", async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValueOnce(jsonResponse({ content: [{ type: "text", text: "Claude's answer." }] }))

    const answer = await answerQuestion("Acme", [page], "What is this about?", [])

    expect(answer).toBe("Claude's answer.")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toContain("anthropic.com")
  })

  it("falls through to the next provider when the first fails", async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: "server error" }, false))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: "OpenAI's answer." } }] }))

    const answer = await answerQuestion("Acme", [page], "What is this about?", [])

    expect(answer).toBe("OpenAI's answer.")
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][0]).toContain("openai.com")
  })

  it("returns null (never throws) when every configured provider fails", async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValue(jsonResponse({ error: "down" }, false))

    await expect(answerQuestion("Acme", [page], "What is this about?", [])).resolves.toBeNull()
  })

  it("falls through on a network-level rejection, not just a non-2xx response", async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: "Recovered via OpenAI." } }] }))

    const answer = await answerQuestion("Acme", [page], "What is this about?", [])
    expect(answer).toBe("Recovered via OpenAI.")
  })
})
