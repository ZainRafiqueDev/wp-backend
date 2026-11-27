import { randomUUID } from "node:crypto"

import { beforeEach, describe, expect, it, vi } from "vitest"

// Same cross-module mocking approach tests/integration/chatbot.integration.test.ts
// uses for the crawler: mock the module answerChatbotQuestion.ts actually
// imports (lib/ai.js's answerQuestion), not answerChatbotQuestion.ts's own
// exports, so the real caching/grounding logic under test still runs.
const { answerQuestionMock } = vi.hoisted(() => ({ answerQuestionMock: vi.fn() }))
// completeCheaply backs query rewriting (lib/queryRewrite.ts) on multi-turn
// calls; returning null makes it fall back to the regex heuristic offline.
vi.mock("../../src/lib/ai.js", () => ({ answerQuestion: answerQuestionMock, completeCheaply: vi.fn(async () => null) }))
// answerChatbotQuestion.ts now also loads a chatbot's Custom Actions on
// every call (to build the tools list and feed the relevance gate) — mocked
// out here for the same reason lib/ai.js is: these tests use synthetic,
// non-UUID chatbot ids that were never meant to hit a real Postgres query,
// and this suite is specifically about Redis-backed caching, not actions.
vi.mock("../../src/services/actions.service.js", () => ({
  getActionsForAnswering: vi.fn(async () => ({ actions: [], eligibleModels: [] })),
}))
// Same reason as actions.service.js above — Task 2's backend-link read
// tier and Task 3's cost-cap check both do their own real Postgres lookups
// keyed by chatbotId (chatbot_integrations / subscriptions joined to
// chatbots), which this suite's synthetic non-UUID ids were never meant to
// survive. This suite is about answer caching, not either of those.
vi.mock("../../src/lib/backendLink.js", () => ({ fetchBackendLiveContext: vi.fn(async () => []) }))
vi.mock("../../src/services/usage.service.js", () => ({ recordUsage: vi.fn(async () => {}) }))
// The unified answering gate (trial/deactivation/cost-cap, Section 2/3 of
// the MVP-launch pass) does its own real Postgres join (chatbots -> users)
// keyed by chatbotId, same reason as actions.service.js/backendLink.js
// above — mocked to always allow, since gating behavior itself is covered
// by tests/integration/accessGate.integration.test.ts, not this suite.
vi.mock("../../src/services/accessGate.service.js", () => ({ checkAnsweringGate: vi.fn(async () => ({ blocked: false })) }))
// PHASE C — quota-based model selection also does its own real Postgres
// lookup (getEntitlementForChatbot) whenever a call has no pinned model
// yet, which every call in this suite doesn't (none pass a `conversation`
// argument) — same reason as accessGate.service.js above.
vi.mock("../../src/services/modelSelection.service.js", () => ({
  selectModelForNewConversation: vi.fn(async () => null),
  selectModelForConversation: vi.fn(async () => null),
}))
// Document ingestion (Crawl Plus) — answerChatbotQuestion.ts now fetches
// the chatbot's entitlement unconditionally (not just on the cost-cap
// path) to decide whether to look up uploaded-document chunks, which is
// its own real Postgres lookup keyed by chatbotId — same reason as
// modelSelection.service.js above. documentIngestion: false keeps this
// suite's existing behavior (no document lookup) unchanged.
vi.mock("../../src/services/billing.service.js", () => ({
  getEntitlementForChatbot: vi.fn(async () => ({
    plan: "free",
    maxChatbots: 1,
    maxSeats: 1,
    allowedModels: ["gemini"],
    perModelCapUsd: 0.5,
    documentIngestion: { enabled: false, maxDocuments: 0, maxFileSizeBytes: 0, maxChatbotBytes: 0 },
    chatAttachments: { enabled: false, maxFileSizeBytes: 0, maxFilesPerMessage: 0, retentionDays: 0, allowedTypes: [], totalStorageBytes: 0 },
    active: false,
  })),
}))
vi.mock("../../src/services/documentIngestion.service.js", () => ({
  lookupRelevantDocumentChunks: vi.fn(async () => []),
}))

const { getActionsForAnswering } = await import("../../src/services/actions.service.js")
const { answerChatbotQuestion } = await import("../../src/lib/answerChatbotQuestion.js")
const { bumpChatbotCacheVersion, cacheKey, cacheSchemaTag } = await import("../../src/lib/cache.js")
const { redis } = await import("../../src/lib/redis.js")

const sources = [
  { type: "website" as const, label: "Home", url: "https://x.test/", characters: 40, content: "Widget X is our flagship product." },
]

beforeEach(() => {
  answerQuestionMock.mockReset()
  vi.mocked(getActionsForAnswering).mockResolvedValue({ actions: [], eligibleModels: [] })
})

describe("answerChatbotQuestion — answer caching (Task 4)", () => {
  it("serves a near-exact repeat question from cache instead of calling the AI provider again", async () => {
    answerQuestionMock.mockResolvedValue("Widget X is in stock.")
    const chatbotId = `test-cache-${randomUUID()}`

    const first = await answerChatbotQuestion(chatbotId, "Test Bot", sources, "is widget x in stock?", [])
    expect(first.aiGenerated).toBe(true)
    expect(answerQuestionMock).toHaveBeenCalledTimes(1)

    // Same question, different case/whitespace — normalizeQuestionKey (lib/cache.ts)
    // should treat this as the same cache entry.
    const second = await answerChatbotQuestion(chatbotId, "Test Bot", sources, "  Is Widget X In Stock?  ", [])
    expect(second).toEqual(first)
    expect(answerQuestionMock).toHaveBeenCalledTimes(1) // not called again

    await redis.del(cacheKey(chatbotId, "version"))
  })

  it("misses the cache again after the chatbot's cache version is bumped (simulating a live-data write or re-crawl)", async () => {
    answerQuestionMock.mockResolvedValue("Widget X is in stock.")
    const chatbotId = `test-cache-${randomUUID()}`

    await answerChatbotQuestion(chatbotId, "Test Bot", sources, "is widget x in stock?", [])
    expect(answerQuestionMock).toHaveBeenCalledTimes(1)

    await bumpChatbotCacheVersion(chatbotId)

    await answerChatbotQuestion(chatbotId, "Test Bot", sources, "is widget x in stock?", [])
    expect(answerQuestionMock).toHaveBeenCalledTimes(2) // called again — the old cache entry is orphaned, not reused

    await redis.del(cacheKey(chatbotId, "version"))
  })

  it("does not cache an answer that fails the Task 3 grounding check", async () => {
    // $49.99 never appears anywhere in `sources` above — this must fail
    // verifyGroundedClaims and get swapped for the fallback message.
    answerQuestionMock.mockResolvedValue("Widget X costs $49.99.")
    const chatbotId = `test-cache-${randomUUID()}`

    const first = await answerChatbotQuestion(chatbotId, "Test Bot", sources, "how much is widget x?", [])
    expect(first.aiGenerated).toBe(false) // swapped for the fallback, not the ungrounded AI text
    expect(answerQuestionMock).toHaveBeenCalledTimes(1)

    // A second identical request must call the AI provider again — a
    // rejected answer was never cached, so there's nothing to serve from
    // cache for the next attempt.
    const second = await answerChatbotQuestion(chatbotId, "Test Bot", sources, "how much is widget x?", [])
    expect(second.aiGenerated).toBe(false)
    expect(answerQuestionMock).toHaveBeenCalledTimes(2)

    await redis.del(cacheKey(chatbotId, "version"))
  })

  it("never shares an answer cache entry across chatbots", async () => {
    answerQuestionMock.mockResolvedValue("Widget X is in stock.")
    const chatbotA = `test-cache-${randomUUID()}`
    const chatbotB = `test-cache-${randomUUID()}`

    await answerChatbotQuestion(chatbotA, "Test Bot", sources, "is widget x in stock?", [])
    expect(answerQuestionMock).toHaveBeenCalledTimes(1)

    await answerChatbotQuestion(chatbotB, "Test Bot", sources, "is widget x in stock?", [])
    expect(answerQuestionMock).toHaveBeenCalledTimes(2)

    const keys = await redis.keys(`tenant:${chatbotA}:${cacheSchemaTag()}:answer:*`)
    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) {
      expect(key.startsWith(`tenant:${chatbotA}:${cacheSchemaTag()}:`)).toBe(true)
      expect(key).not.toContain(chatbotB)
    }

    await redis.del(cacheKey(chatbotA, "version"), cacheKey(chatbotB, "version"), ...keys)
  })

  it("never reads or writes the answer cache for a tool-relevant question", async () => {
    answerQuestionMock.mockResolvedValue("Order 42 shipped this morning.")
    const chatbotId = `test-cache-${randomUUID()}`
    vi.mocked(getActionsForAnswering).mockResolvedValue({
      actions: [
        {
          id: randomUUID(),
          chatbotId,
          name: "check_order_status",
          description: "Use this when the user asks about an order status or whether widget stock shipped.",
          httpMethod: "GET",
          urlTemplate: "https://example.test/orders",
          headersTemplate: {},
          bodyTemplate: null,
          parameters: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      eligibleModels: ["openai"],
    })

    await answerChatbotQuestion(chatbotId, "Test Bot", sources, "did my order ship?", [])
    await answerChatbotQuestion(chatbotId, "Test Bot", sources, "did my order ship?", [])
    expect(answerQuestionMock).toHaveBeenCalledTimes(2)

    const answerKeys = await redis.keys(`tenant:${chatbotId}:${cacheSchemaTag()}:answer:*`)
    expect(answerKeys).toEqual([])

    await redis.del(cacheKey(chatbotId, "version"))
  })

  it("never reads or writes the answer cache when live data is present", async () => {
    answerQuestionMock.mockResolvedValue("The live price is 12.")
    const chatbotId = `test-cache-${randomUUID()}`

    await answerChatbotQuestion(chatbotId, "Test Bot", sources, "what is the live price?", [], undefined, [
      { key: "price", value: "The live price is 12." },
    ])
    await answerChatbotQuestion(chatbotId, "Test Bot", sources, "what is the live price?", [], undefined, [
      { key: "price", value: "The live price is 12." },
    ])
    expect(answerQuestionMock).toHaveBeenCalledTimes(2)

    const answerKeys = await redis.keys(`tenant:${chatbotId}:${cacheSchemaTag()}:answer:*`)
    expect(answerKeys).toEqual([])

    await redis.del(cacheKey(chatbotId, "version"))
  })

  // CS-06 (VER-04): personalised answers must never land in the shared cache.
  describe("personalised context never enters the shared caches", () => {
    const memoryA = {
      identifier: "cust-a-hash",
      summaryMd: "Alice asked about Widget X for her bakery last week.",
      interruptedByCreditExhaustion: false,
      facts: [{ key: "name", value: "Alice" }],
    }

    it("does not serve visitor A's memory-informed answer to visitor B asking the same question", async () => {
      const chatbotId = `test-cache-${randomUUID()}`
      answerQuestionMock
        .mockResolvedValueOnce("Alice, Widget X is our flagship product.")
        .mockResolvedValueOnce("Widget X is our flagship product.")

      const a = await answerChatbotQuestion(
        chatbotId, "Test Bot", sources, "tell me about widget x", [], undefined, [], undefined, null, memoryA,
      )
      expect(a.text).toContain("Alice")

      const b = await answerChatbotQuestion(chatbotId, "Test Bot", sources, "tell me about widget x", [])
      expect(answerQuestionMock).toHaveBeenCalledTimes(2)
      expect(b.text).not.toContain("Alice")

      await redis.del(cacheKey(chatbotId, "version"), ...(await redis.keys(`tenant:${chatbotId}:*`)))
    })

    it("never reads or writes the answer or relevance cache for a customer with memory", async () => {
      const chatbotId = `test-cache-${randomUUID()}`
      answerQuestionMock.mockResolvedValue("Widget X is our flagship product.")

      await answerChatbotQuestion(chatbotId, "Test Bot", sources, "tell me about widget x", [], undefined, [], undefined, null, memoryA)
      await answerChatbotQuestion(chatbotId, "Test Bot", sources, "tell me about widget x", [], undefined, [], undefined, null, memoryA)
      expect(answerQuestionMock).toHaveBeenCalledTimes(2)

      expect(await redis.keys(`tenant:${chatbotId}:${cacheSchemaTag()}:answer:*`)).toEqual([])
      expect(await redis.keys(`tenant:${chatbotId}:${cacheSchemaTag()}:relevance:*`)).toEqual([])

      await redis.del(cacheKey(chatbotId, "version"), ...(await redis.keys(`tenant:${chatbotId}:*`)))
    })

    it("does not share an answer generated with prior conversation history", async () => {
      const chatbotId = `test-cache-${randomUUID()}`
      answerQuestionMock
        .mockResolvedValueOnce("As you mentioned, Widget X is our flagship product.")
        .mockResolvedValueOnce("Widget X is our flagship product.")
      const history = [
        { role: "user" as const, content: "My name is Alice and I run a bakery." },
        { role: "assistant" as const, content: "Nice to meet you, Alice." },
      ]

      await answerChatbotQuestion(chatbotId, "Test Bot", sources, "tell me about widget x", history)
      const b = await answerChatbotQuestion(chatbotId, "Test Bot", sources, "tell me about widget x", [])
      expect(answerQuestionMock).toHaveBeenCalledTimes(2)
      expect(b.text).toBe("Widget X is our flagship product.")
      // Only B's anonymous first turn may have written the relevance key.
      expect((await redis.keys(`tenant:${chatbotId}:${cacheSchemaTag()}:relevance:*`)).length).toBe(1)

      await redis.del(cacheKey(chatbotId, "version"), ...(await redis.keys(`tenant:${chatbotId}:*`)))
    })

    it("still caches an anonymous first-turn question", async () => {
      const chatbotId = `test-cache-${randomUUID()}`
      answerQuestionMock.mockResolvedValue("Widget X is our flagship product.")

      await answerChatbotQuestion(chatbotId, "Test Bot", sources, "tell me about widget x", [])
      await answerChatbotQuestion(chatbotId, "Test Bot", sources, "tell me about widget x", [])
      expect(answerQuestionMock).toHaveBeenCalledTimes(1)
      expect((await redis.keys(`tenant:${chatbotId}:${cacheSchemaTag()}:answer:*`)).length).toBe(1)
      expect((await redis.keys(`tenant:${chatbotId}:${cacheSchemaTag()}:relevance:*`)).length).toBe(1)

      await redis.del(cacheKey(chatbotId, "version"), ...(await redis.keys(`tenant:${chatbotId}:*`)))
    })
  
    it("does not count personalised (cache-bypassing) requests towards the abuse window, but still counts anonymous misses", async () => {
      answerQuestionMock.mockResolvedValue("Widget X is our flagship product.")
      const history = [{ role: "user" as const, content: "Hi, I am Alice." }]
      const n = 5

      const personalBot = `test-cache-${randomUUID()}`
      for (let i = 0; i < n; i++) {
        await answerChatbotQuestion(personalBot, "Test Bot", sources, `tell me about widget x ${i}`, [], undefined, [], undefined, null, memoryA)
        await answerChatbotQuestion(personalBot, "Test Bot", sources, `tell me about widget x ${i}`, history)
      }
      expect(await redis.get(`abuse-window:${personalBot}`)).toBeNull()

      const anonBot = `test-cache-${randomUUID()}`
      for (let i = 0; i < n; i++) {
        await answerChatbotQuestion(anonBot, "Test Bot", sources, `tell me about widget x ${i}`, [])
      }
      expect(Number(await redis.get(`abuse-window:${anonBot}`))).toBe(n)

      for (const bot of [personalBot, anonBot]) {
        await redis.del(cacheKey(bot, "version"), `abuse-window:${bot}`, ...(await redis.keys(`tenant:${bot}:*`)))
      }
    })
  })
})
