import { describe, expect, it, vi } from "vitest"

// One canned concept per call, matching the shape okf.integration.test.ts
// already uses for the document-upload suggestion path — this suite is
// about the crawl-specific filtering/dedup/cap logic in front of that same
// extraction call, not the extraction itself.
vi.mock("../../src/lib/ai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/ai.js")>()
  return {
    ...actual,
    completeCheaply: vi.fn(async () =>
      JSON.stringify({
        concepts: [
          {
            type: "Policy",
            title: "Extracted From Crawl",
            description: "A canonical fact found on a crawled page",
            tags: ["crawl"],
            body_md: "This fact came from a crawled page.",
          },
        ],
      }),
    ),
  }
})

const { pool } = await import("../../src/lib/db.js")
const { suggestOKFConceptsFromCrawledPages } = await import("../../src/services/okfSuggestion.service.js")
const { deactivateConcept } = await import("../../src/services/okf.service.js")
const { seedOwnedChatbot } = await import("../helpers/seedTenant.js")
const { env } = await import("../../src/env.js")

async function conceptCount(chatbotId: string): Promise<number> {
  const { rows } = await pool!.query<{ n: string }>("select count(*)::text as n from okf_concepts where chatbot_id = $1", [chatbotId])
  return Number(rows[0].n)
}

describe("suggestOKFConceptsFromCrawledPages — the crawl/recrawl entry point", () => {
  it("skips pages that fail the relevance filter (boilerplate URL, no policy content)", async () => {
    if (!pool) throw new Error("pool required")
    const tenant = await seedOwnedChatbot("okf-crawl-irrelevant")

    await suggestOKFConceptsFromCrawledPages(tenant.chatbotId, [
      { url: "https://store.example/blog/our-story", content: "We started this company in a garage." },
      { url: "https://store.example/about-us", content: "Meet the team behind the product." },
    ])

    expect(await conceptCount(tenant.chatbotId)).toBe(0)
  })

  it("suggests concepts for a page that passes the relevance filter", async () => {
    if (!pool) throw new Error("pool required")
    const tenant = await seedOwnedChatbot("okf-crawl-relevant")

    await suggestOKFConceptsFromCrawledPages(tenant.chatbotId, [
      { url: "https://store.example/refund-policy", content: "Items may be returned within 30 days for a full refund." },
    ])

    expect(await conceptCount(tenant.chatbotId)).toBeGreaterThan(0)
    const { rows } = await pool.query<{ resource_url: string | null; created_by: string; approved_at: Date | null }>(
      "select resource_url, created_by, approved_at from okf_concepts where chatbot_id = $1",
      [tenant.chatbotId],
    )
    expect(rows[0].resource_url).toBe("https://store.example/refund-policy")
    expect(rows[0].created_by).toBe("ai_extracted")
    expect(rows[0].approved_at).toBeNull()
  })

  it("does not create a second suggestion for a URL that already has a pending concept", async () => {
    if (!pool) throw new Error("pool required")
    const tenant = await seedOwnedChatbot("okf-crawl-dedup")
    const page = { url: "https://store.example/shipping-policy", content: "We ship within 2 business days, $5 flat rate." }

    await suggestOKFConceptsFromCrawledPages(tenant.chatbotId, [page])
    const afterFirst = await conceptCount(tenant.chatbotId)
    expect(afterFirst).toBeGreaterThan(0)

    // Recrawled with the exact same page again — must not spawn a second
    // pending suggestion sitting next to the first, unreviewed one.
    await suggestOKFConceptsFromCrawledPages(tenant.chatbotId, [page])
    expect(await conceptCount(tenant.chatbotId)).toBe(afterFirst)
  })

  it("caps the number of pages sent to the suggestion step per call, preferring higher-relevance pages first", async () => {
    if (!pool) throw new Error("pool required")
    const tenant = await seedOwnedChatbot("okf-crawl-cap")

    // 3 pages, each URL-relevant; give one of them an extra content signal
    // so it should be prioritized if the cap were smaller than 3.
    const pages = [
      { url: "https://store.example/faq", content: "General frequently asked questions." },
      { url: "https://store.example/warranty", content: "Standard warranty terms apply." },
      { url: "https://store.example/pricing", content: "Plans start at $29/month, billed monthly." },
    ]

    await suggestOKFConceptsFromCrawledPages(tenant.chatbotId, pages)

    // With the default cap (5) comfortably above 3 relevant pages, all 3
    // should produce a suggestion each (1 concept per mocked call).
    expect(await conceptCount(tenant.chatbotId)).toBe(3)
  })

  it("respects a lower configured cap by only processing the top-N highest-scoring pages", async () => {
    if (!pool) throw new Error("pool required")
    const originalCap = env.okfCrawlSuggestMaxPagesPerRun
    env.okfCrawlSuggestMaxPagesPerRun = 1
    try {
      const tenant = await seedOwnedChatbot("okf-crawl-cap-low")
      const pages = [
        { url: "https://store.example/faq", content: "General frequently asked questions." },
        // Higher score: URL match + a content signal.
        { url: "https://store.example/pricing", content: "Plans start at $29/month, billed monthly." },
      ]

      await suggestOKFConceptsFromCrawledPages(tenant.chatbotId, pages)

      expect(await conceptCount(tenant.chatbotId)).toBe(1)
      const { rows } = await pool.query<{ resource_url: string | null }>(
        "select resource_url from okf_concepts where chatbot_id = $1",
        [tenant.chatbotId],
      )
      // The higher-scoring page (URL + content signal) should be the one processed.
      expect(rows[0].resource_url).toBe("https://store.example/pricing")
    } finally {
      env.okfCrawlSuggestMaxPagesPerRun = originalCap
    }
  })

  it("does nothing when the feature is disabled via env", async () => {
    if (!pool) throw new Error("pool required")
    const originalEnabled = env.okfCrawlSuggestEnabled
    env.okfCrawlSuggestEnabled = false
    try {
      const tenant = await seedOwnedChatbot("okf-crawl-disabled")
      await suggestOKFConceptsFromCrawledPages(tenant.chatbotId, [
        { url: "https://store.example/refund-policy", content: "Refunds within 30 days." },
      ])
      expect(await conceptCount(tenant.chatbotId)).toBe(0)
    } finally {
      env.okfCrawlSuggestEnabled = originalEnabled
    }
  })

  it("allows re-suggesting a URL whose prior concept was dismissed, but not one still pending/approved", async () => {
    if (!pool) throw new Error("pool required")
    const tenant = await seedOwnedChatbot("okf-crawl-dismiss-resuggest")
    const page = { url: "https://store.example/return-policy", content: "Returns accepted within 14 days, restocking fee may apply." }

    await suggestOKFConceptsFromCrawledPages(tenant.chatbotId, [page])
    const { rows: firstRows } = await pool.query<{ id: string; is_active: boolean }>(
      "select id, is_active from okf_concepts where chatbot_id = $1 and resource_url = $2",
      [tenant.chatbotId, page.url],
    )
    expect(firstRows).toHaveLength(1)
    expect(firstRows[0].is_active).toBe(true)

    // Still pending (not dismissed) — recrawl must not duplicate it.
    await suggestOKFConceptsFromCrawledPages(tenant.chatbotId, [page])
    expect(await conceptCount(tenant.chatbotId)).toBe(1)

    // Dismiss it, then recrawl the same page — a fresh suggestion must be allowed.
    await deactivateConcept(tenant.token, tenant.chatbotId, firstRows[0].id)
    await suggestOKFConceptsFromCrawledPages(tenant.chatbotId, [page])

    const { rows: afterDismiss } = await pool.query<{ id: string; is_active: boolean }>(
      "select id, is_active from okf_concepts where chatbot_id = $1 and resource_url = $2 order by created_at",
      [tenant.chatbotId, page.url],
    )
    expect(afterDismiss).toHaveLength(2)
    expect(afterDismiss[0].is_active).toBe(false)
    expect(afterDismiss[1].is_active).toBe(true)
  })

  it("tenant isolation: suggesting for one chatbot's pages never touches another chatbot's concepts", async () => {
    if (!pool) throw new Error("pool required")
    const a = await seedOwnedChatbot("okf-crawl-iso-a")
    const b = await seedOwnedChatbot("okf-crawl-iso-b")

    await suggestOKFConceptsFromCrawledPages(a.chatbotId, [
      { url: "https://store.example/refund-policy", content: "Refunds within 30 days." },
    ])

    expect(await conceptCount(a.chatbotId)).toBeGreaterThan(0)
    expect(await conceptCount(b.chatbotId)).toBe(0)
  })
})
