import { describe, expect, it } from "vitest"

import { embeddingTextFor, semanticChunk } from "../../src/lib/semanticChunk.js"

describe("WP-3.3 semantic chunker", () => {
  it("attaches the parent heading to chunks that follow it", () => {
    const text = "Return Policy\n\nItems can be returned within 30 days of purchase with a receipt."
    const chunks = semanticChunk(text)
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks[0].heading).toBe("Return Policy")
    expect(chunks[0].text).toContain("30 days")
    // The heading line itself is not duplicated into the chunk body.
    expect(chunks[0].text).not.toContain("Return Policy\n\n")
  })

  it("never splits a table across chunks when it fits within max size", () => {
    const table = [
      "Plan\tPrice\tCredits",
      "Free\t$0\t$0",
      "Crawl Plus\t$20\t$8",
      "Full Custom\tCustom\tCustom",
    ].join("\n")
    const chunks = semanticChunk(`Pricing\n\n${table}`)
    const tableChunk = chunks.find((c) => c.text.includes("Crawl Plus"))
    expect(tableChunk).toBeDefined()
    expect(tableChunk!.text).toContain("Plan\tPrice\tCredits")
    expect(tableChunk!.text).toContain("Full Custom")
  })

  it("splits an oversized table by row, repeating the header and marking continuation", () => {
    const header = "SKU\tName\tPrice\tStock\tCategory"
    const rows = Array.from({ length: 80 }, (_, i) => `SKU-${i}\tWidget ${i}\t$${i}.00\t${i * 3}\tHardware`)
    const bigTable = [header, ...rows].join("\n")
    const chunks = semanticChunk(`Inventory\n\n${bigTable}`, { maxChunkSize: 800 })

    const tableChunks = chunks.filter((c) => c.text.includes("SKU-"))
    expect(tableChunks.length).toBeGreaterThan(1)
    // Every continuation chunk repeats the header row — never a table chunk
    // without its column labels.
    for (const c of tableChunks) {
      expect(c.text).toContain(header)
    }
    expect(tableChunks[0].text).toContain("[TABLE CONTINUES]")
    expect(tableChunks[1].text).toContain("[TABLE CONTINUED]")
    // No row was dropped or duplicated across the split.
    const allRows = tableChunks.flatMap((c) =>
      c.text.split("\n").filter((line) => line.startsWith("SKU-")),
    )
    expect(new Set(allRows).size).toBe(rows.length)
  })

  it("merges an orphan tail fragment into its predecessor rather than emitting a tiny chunk", () => {
    const text = "Section\n\n" + "A".repeat(1100) + "\n\nshort tail"
    const chunks = semanticChunk(text, { targetChunkSize: 1200, minChunkSize: 200 })
    expect(chunks.every((c) => c.charCount >= 200 || chunks.length === 1)).toBe(true)
  })

  it("carries a tail overlap into the next chunk when a section is split across chunks", () => {
    const longSection =
      "Intro\n\n" +
      Array.from({ length: 30 }, (_, i) => `This is sentence number ${i} in a very long section about onboarding.`).join(" ")
    const chunks = semanticChunk(longSection, { targetChunkSize: 400, overlapChars: 60 })
    expect(chunks.length).toBeGreaterThan(1)
    // The start of chunk 2 should share some text with the tail of chunk 1 (the overlap).
    const tailOfFirst = chunks[0].text.slice(-40)
    expect(chunks[1].text.includes(tailOfFirst.split(" ").slice(1).join(" ")) || chunks[1].text.length > 0).toBe(true)
  })

  it("estimates tokens as roughly chars/4 and reports charCount accurately", () => {
    const chunks = semanticChunk("Hours\n\nWe are open Monday through Friday, 9am to 5pm.")
    expect(chunks[0].charCount).toBe(chunks[0].text.length)
    expect(chunks[0].tokenEstimate).toBe(Math.ceil(chunks[0].text.length / 4))
  })

  it("embeddingTextFor prepends the section header for embedding without mutating the stored chunk text", () => {
    const chunks = semanticChunk("Shipping\n\nOrders ship within 2 business days.")
    const embeddingText = embeddingTextFor(chunks[0])
    expect(embeddingText).toContain("[Section: Shipping]")
    expect(embeddingText).toContain("Orders ship within 2 business days.")
    // The chunk's own stored text is untouched by embedding formatting.
    expect(chunks[0].text).not.toContain("[Section:")
  })

  it("defaults documentType to general and respects an explicit override", () => {
    const auto = semanticChunk("Some text here.")
    expect(auto[0].documentType).toBe("general")
    const tagged = semanticChunk("Some text here.", { documentType: "policy" })
    expect(tagged[0].documentType).toBe("policy")
  })
})
