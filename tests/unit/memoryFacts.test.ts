import { describe, expect, it } from "vitest"

import { formatFactsForPrompt, normalizeFactKey, parseExtractedFacts } from "../../src/lib/memoryFacts.js"

describe("WP-3.4 customer fact parsing", () => {
  it("normalizes keys to snake_case so the same fact upserts instead of duplicating", () => {
    expect(normalizeFactKey("Order Number")).toBe("order_number")
    expect(normalizeFactKey("  shipping-city!! ")).toBe("shipping_city")
    expect(normalizeFactKey("Préférence")).toBe("pr_f_rence")
  })

  it("extracts facts from a clean JSON array", () => {
    const facts = parseExtractedFacts(
      '[{"key":"order_number","value":"#4471","confidence":0.9},{"key":"city","value":"Lahore","confidence":0.6}]',
      25,
    )
    expect(facts).toEqual([
      { key: "order_number", value: "#4471", confidence: 0.9 },
      { key: "city", value: "Lahore", confidence: 0.6 },
    ])
  })

  it("finds the array inside prose or a code fence", () => {
    const facts = parseExtractedFacts(
      'Sure! Here are the facts:\n```json\n[{"key":"plan","value":"Crawl Plus","confidence":1}]\n```\nHope that helps.',
      25,
    )
    expect(facts).toEqual([{ key: "plan", value: "Crawl Plus", confidence: 1 }])
  })

  it("returns an empty list for unparseable, empty, or non-array responses", () => {
    expect(parseExtractedFacts(null, 25)).toEqual([])
    expect(parseExtractedFacts("", 25)).toEqual([])
    expect(parseExtractedFacts("I could not find any facts.", 25)).toEqual([])
    expect(parseExtractedFacts('[{"key":"a","value":', 25)).toEqual([])
    expect(parseExtractedFacts('{"key":"a","value":"b"}', 25)).toEqual([])
  })

  it("drops entries missing a usable key or value, and keeps the last value for a repeated key", () => {
    const facts = parseExtractedFacts(
      '[{"key":"","value":"x"},{"key":"a","value":""},{"value":"no key"},"junk",{"key":"city","value":"Karachi"},{"key":"City","value":"Lahore"}]',
      25,
    )
    expect(facts).toEqual([{ key: "city", value: "Lahore", confidence: 0.5 }])
  })

  it("clamps confidence into 0..1 and defaults a missing or non-numeric one", () => {
    const facts = parseExtractedFacts(
      '[{"key":"a","value":"1","confidence":7},{"key":"b","value":"2","confidence":-3},{"key":"c","value":"3"},{"key":"d","value":"4","confidence":"nope"}]',
      25,
    )
    expect(facts.map((fact) => fact.confidence)).toEqual([1, 0, 0.5, 0.5])
  })

  it("never returns more than the configured ceiling", () => {
    const raw = JSON.stringify(
      Array.from({ length: 40 }, (_, i) => ({ key: `fact_${i}`, value: `value ${i}`, confidence: 0.5 })),
    )
    expect(parseExtractedFacts(raw, 5)).toHaveLength(5)
  })

  it("truncates an overlong value rather than dropping the fact", () => {
    const facts = parseExtractedFacts(JSON.stringify([{ key: "note", value: "x".repeat(900) }]), 25)
    expect(facts[0].value).toHaveLength(500)
  })

  it("renders facts as a readable prompt block", () => {
    expect(formatFactsForPrompt([{ key: "order_number", value: "#4471" }, { key: "city", value: "Lahore" }])).toBe(
      "- order number: #4471\n- city: Lahore",
    )
  })
})
