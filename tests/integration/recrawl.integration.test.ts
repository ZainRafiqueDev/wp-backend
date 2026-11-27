import { beforeEach, describe, expect, it, vi } from "vitest"

import type { GateResult } from "../../src/services/accessGate.service.js"

const { crawlWebsiteForChatbotMock, checkAnsweringGateMock } = vi.hoisted(() => ({
  crawlWebsiteForChatbotMock: vi.fn(),
  checkAnsweringGateMock: vi.fn<() => Promise<GateResult>>(async () => ({ blocked: false })),
}))
vi.mock("../../src/services/chatbot.service.js", () => ({ crawlWebsiteForChatbot: crawlWebsiteForChatbotMock }))
vi.mock("../../src/services/accessGate.service.js", () => ({
  checkAnsweringGate: checkAnsweringGateMock,
  isUsageGateReason: (reason?: string) =>
    reason === "monthly_credits_exhausted" || reason === "burst_limited" || reason === "cost_cap_exceeded",
}))

// A real DB is needed for the chatbots-row lookup at the top of
// runIncrementalRecrawl — this suite uses the same real local test Postgres
// every other integration test does, seeding just the one chatbots row it
// needs directly, since that's cheaper than a full signup+createChatbot
// round trip for a unit-level test focused purely on the hash-skip logic.
const { pool } = await import("../../src/lib/db.js")
const { runIncrementalRecrawl } = await import("../../src/services/recrawl.service.js")

async function seedChatbot(sources: unknown[]): Promise<string> {
  const { rows } = await pool!.query<{ id: string }>(
    `insert into users (email, password_hash, name) values ($1, 'x', 'Test') returning id`,
    [`recrawl-test-${Date.now()}-${Math.random()}@example.test`],
  )
  const userId = rows[0].id
  const { rows: chatbotRows } = await pool!.query<{ id: string }>(
    `insert into chatbots (user_id, name, sources, website_url, status) values ($1, 'Bot', $2, 'https://example.test', 'ready') returning id`,
    [userId, JSON.stringify(sources)],
  )
  return chatbotRows[0].id
}

beforeEach(() => {
  crawlWebsiteForChatbotMock.mockReset()
  checkAnsweringGateMock.mockReset().mockResolvedValue({ blocked: false })
})

describe("runIncrementalRecrawl — content-hash skip logic (Section 5/9)", () => {
  it("skips a page whose fresh content hash matches the stored one, and updates only the changed page", async () => {
    const existingSources = [
      { type: "website", label: "unchanged", url: "https://example.test/unchanged", characters: 10, content: "same text", contentHash: "hash-unchanged" },
      { type: "website", label: "changed", url: "https://example.test/changed", characters: 10, content: "old text", contentHash: "hash-old" },
    ]
    const chatbotId = await seedChatbot(existingSources)

    crawlWebsiteForChatbotMock.mockResolvedValue({
      siteName: "Bot",
      pagesFound: 2,
      sources: [
        { type: "website", label: "unchanged", url: "https://example.test/unchanged", characters: 10, content: "same text", contentHash: "hash-unchanged" },
        { type: "website", label: "changed", url: "https://example.test/changed", characters: 12, content: "NEW text!", contentHash: "hash-new" },
      ],
    })

    const outcome = await runIncrementalRecrawl(chatbotId)

    expect(outcome).toMatchObject({ skipped: false, pagesChecked: 2, pagesChanged: 1, pagesSkipped: 1 })

    const { rows } = await pool!.query<{ sources: { url: string; content: string; contentHash: string }[] }>(
      "select sources from chatbots where id = $1",
      [chatbotId],
    )
    const stored = rows[0].sources
    const unchanged = stored.find((s) => s.url === "https://example.test/unchanged")
    const changed = stored.find((s) => s.url === "https://example.test/changed")
    expect(unchanged?.content).toBe("same text")
    expect(changed?.content).toBe("NEW text!")
    expect(changed?.contentHash).toBe("hash-new")
  })

  it("treats a page with no prior stored hash as changed (first recrawl after this feature shipped)", async () => {
    const chatbotId = await seedChatbot([
      { type: "website", label: "page", url: "https://example.test/page", characters: 5, content: "old" },
    ])

    crawlWebsiteForChatbotMock.mockResolvedValue({
      siteName: "Bot",
      pagesFound: 1,
      sources: [{ type: "website", label: "page", url: "https://example.test/page", characters: 5, content: "old", contentHash: "hash-1" }],
    })

    const outcome = await runIncrementalRecrawl(chatbotId)
    expect(outcome).toMatchObject({ pagesChanged: 1, pagesSkipped: 0 })
  })

  it("skips entirely (no crawl attempt) for a chatbot the answering gate blocks", async () => {
    checkAnsweringGateMock.mockResolvedValue({ blocked: true, reason: "trial_expired" })
    const chatbotId = await seedChatbot([])

    const outcome = await runIncrementalRecrawl(chatbotId)

    expect(outcome).toMatchObject({ skipped: true, reason: "trial_expired" })
    expect(crawlWebsiteForChatbotMock).not.toHaveBeenCalled()
  })

  it("does NOT skip for cost_cap_exceeded — crawling isn't an AI-token cost in this architecture", async () => {
    checkAnsweringGateMock.mockResolvedValue({ blocked: true, reason: "cost_cap_exceeded" })
    const chatbotId = await seedChatbot([])
    crawlWebsiteForChatbotMock.mockResolvedValue({ siteName: "Bot", pagesFound: 0, sources: [] })

    const outcome = await runIncrementalRecrawl(chatbotId)

    expect(outcome.skipped).toBe(false)
    expect(crawlWebsiteForChatbotMock).toHaveBeenCalledTimes(1)
  })

  it("does NOT skip for monthly_credits_exhausted or burst_limited", async () => {
    for (const reason of ["monthly_credits_exhausted", "burst_limited"] as const) {
      checkAnsweringGateMock.mockReset().mockResolvedValue({ blocked: true, reason })
      crawlWebsiteForChatbotMock.mockReset().mockResolvedValue({ siteName: "Bot", pagesFound: 0, sources: [] })
      const chatbotId = await seedChatbot([])
      const outcome = await runIncrementalRecrawl(chatbotId)
      expect(outcome.skipped).toBe(false)
      expect(crawlWebsiteForChatbotMock).toHaveBeenCalledTimes(1)
    }
  })

  it("skips a chatbot with no stored website_url", async () => {
    const { rows } = await pool!.query<{ id: string }>(
      `insert into users (email, password_hash, name) values ($1, 'x', 'Test') returning id`,
      [`recrawl-no-url-${Date.now()}@example.test`],
    )
    const { rows: chatbotRows } = await pool!.query<{ id: string }>(
      `insert into chatbots (user_id, name, sources, status) values ($1, 'Bot', '[]', 'ready') returning id`,
      [rows[0].id],
    )

    const outcome = await runIncrementalRecrawl(chatbotRows[0].id)
    expect(outcome).toMatchObject({ skipped: true, reason: "no-website-url" })
    expect(crawlWebsiteForChatbotMock).not.toHaveBeenCalled()
  })
})
