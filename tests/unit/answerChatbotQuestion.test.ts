import { describe, expect, it } from "vitest"

import { liveDataToPages, mergePages, sourcesToPages } from "../../src/lib/answerChatbotQuestion.js"
import type { ChatbotSource } from "../../src/lib/chatbot.js"

describe("sourcesToPages", () => {
  it("keeps only sources with real crawled content", () => {
    const sources: ChatbotSource[] = [
      { type: "website", label: "Home", url: "https://x.test/", characters: 10, content: "Welcome to X." },
      { type: "pdf", label: "handbook.pdf", characters: 5 }, // no .content — not extracted yet
    ]
    const pages = sourcesToPages(sources)
    expect(pages).toHaveLength(1)
    expect(pages[0]).toMatchObject({ title: "Home", text: "Welcome to X.", kind: "crawled" })
  })
})

describe("liveDataToPages", () => {
  it("maps each live-data entry to a page tagged kind: live", () => {
    const pages = liveDataToPages([
      { key: "Widget X stock", value: "42 in stock" },
      { key: "Shipping", value: "Ships in 2 business days" },
    ])
    expect(pages).toEqual([
      { path: "live:Widget X stock", title: "Widget X stock", text: "42 in stock", kind: "live" },
      { path: "live:Shipping", title: "Shipping", text: "Ships in 2 business days", kind: "live" },
    ])
  })

  it("produces an empty array for no live data, never throwing", () => {
    expect(liveDataToPages([])).toEqual([])
  })
})

describe("mergePages", () => {
  const sources: ChatbotSource[] = [
    { type: "website", label: "Pricing", url: "https://x.test/pricing", characters: 20, content: "Plans start at $9." },
  ]
  const liveData = [{ key: "Widget X stock", value: "42 in stock" }]

  it("puts live-data pages ahead of crawled pages (live is the higher-priority tier)", () => {
    const pages = mergePages(liveData, sources)
    expect(pages).toHaveLength(2)
    expect(pages[0].kind).toBe("live")
    expect(pages[1].kind).toBe("crawled")
  })

  it("works with only live data and no crawled sources (a chatbot that hasn't been crawled yet)", () => {
    const pages = mergePages(liveData, [])
    expect(pages).toEqual([{ path: "live:Widget X stock", title: "Widget X stock", text: "42 in stock", kind: "live" }])
  })

  it("works with only crawled sources and no live data (unchanged from pre-live-data behavior)", () => {
    const pages = mergePages([], sources)
    expect(pages).toHaveLength(1)
    expect(pages[0].kind).toBe("crawled")
  })

  it("returns an empty array when there's neither live data nor crawled content", () => {
    expect(mergePages([], [])).toEqual([])
  })
})
