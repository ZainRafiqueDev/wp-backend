import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Same reasoning as tests/unit/actionExecutor.test.ts: assertSafeUrl does a
// real DNS lookup for a non-IP-literal hostname — mocked to a public
// address so the "successful call" tests below don't depend on real DNS.
vi.mock("node:dns/promises", () => ({
  default: { lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) },
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}))

const { getBackendLinkForChatbotMock } = vi.hoisted(() => ({ getBackendLinkForChatbotMock: vi.fn() }))
vi.mock("../../src/services/integration.service.js", () => ({
  getBackendLinkForChatbot: getBackendLinkForChatbotMock,
}))

const { cacheKey, getCached, setCached } = await import("../../src/lib/cache.js")
const { redis } = await import("../../src/lib/redis.js")
const { fetchBackendLiveContext } = await import("../../src/lib/backendLink.js")

// Seeded from Date.now(), not a small counter starting at 0/1/2... — this
// suite runs against a real, shared Redis (see vitest.config.ts's
// REDIS_URL), and fetchBackendLiveContext's own cache TTL
// (env.backendLinkCacheTtlSeconds, 30s default) could otherwise still hold
// a cached [] from a previous run of this same suite moments earlier,
// colliding on a small/predictable version number.
let version = Date.now()

beforeEach(() => {
  getBackendLinkForChatbotMock.mockReset()
  vi.stubGlobal("fetch", vi.fn())
  version += 1
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("fetchBackendLiveContext", () => {
  it("returns no pages and makes no HTTP call when no backend link is configured", async () => {
    getBackendLinkForChatbotMock.mockResolvedValue(null)

    const pages = await fetchBackendLiveContext("chatbot-1", version)

    expect(pages).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })

  it("blocks a private-IP api_base_url the same way the crawler's SSRF check does", async () => {
    getBackendLinkForChatbotMock.mockResolvedValue({ apiBaseUrl: "http://127.0.0.1:8080", apiKey: null })

    const pages = await fetchBackendLiveContext("chatbot-2", version)

    expect(pages).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })

  it("fetches /products and /products/{id}/availability, tagging both as live-tier pages", async () => {
    getBackendLinkForChatbotMock.mockResolvedValue({ apiBaseUrl: "https://owner-backend.test/api", apiKey: "owner-key" })
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockImplementation(async (input) => {
      const url = String(input)
      if (url === "https://owner-backend.test/api/products") {
        return {
          ok: true,
          json: async () => [{ id: "sku_1", name: "Widget", stock: 5 }],
        } as Response
      }
      if (url === "https://owner-backend.test/api/products/sku_1/availability") {
        return { ok: true, json: async () => ({ available: true, quantity: 5 }) } as Response
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    const pages = await fetchBackendLiveContext("chatbot-3", version)

    expect(pages).toHaveLength(2)
    expect(pages.every((p) => p.kind === "live")).toBe(true)
    expect(pages.find((p) => p.path === "backend:sku_1")?.text).toContain("Widget")
    expect(pages.find((p) => p.path === "backend:sku_1:availability")?.text).toContain("available")

    // Authorization header carries the owner's api key on both calls.
    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer owner-key")
    }
  })

  it("degrades to no pages, never throwing, when the products call fails", async () => {
    getBackendLinkForChatbotMock.mockResolvedValue({ apiBaseUrl: "https://owner-backend.test/api", apiKey: null })
    vi.mocked(fetch).mockRejectedValue(new Error("connect ECONNREFUSED"))

    const pages = await fetchBackendLiveContext("chatbot-4", version)

    expect(pages).toEqual([])
  })

  it("degrades to no pages when the products endpoint returns a non-2xx status", async () => {
    getBackendLinkForChatbotMock.mockResolvedValue({ apiBaseUrl: "https://owner-backend.test/api", apiKey: null })
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as Response)

    const pages = await fetchBackendLiveContext("chatbot-5", version)

    expect(pages).toEqual([])
  })

  it("caches the fetched context per chatbot+cacheVersion, not re-fetching on a repeat call", async () => {
    getBackendLinkForChatbotMock.mockResolvedValue({ apiBaseUrl: "https://owner-backend.test/api", apiKey: null })
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValue({ ok: true, json: async () => [] } as Response)

    await fetchBackendLiveContext("chatbot-6", version)
    await fetchBackendLiveContext("chatbot-6", version)

    expect(getBackendLinkForChatbotMock).toHaveBeenCalledTimes(1)
  })
})

describe("cache helpers used by fetchBackendLiveContext", () => {
  it("round-trips through the real cache layer (sanity check for the test above)", async () => {
    const key = cacheKey("chatbot-cache-sanity", "backend-link", "test")
    await setCached(key, [{ ok: true }], 5)
    expect(await getCached(key)).toEqual([{ ok: true }])
    await redis.del(key)
  })
})
