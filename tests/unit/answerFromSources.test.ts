import { describe, expect, it } from "vitest"

import { answerFromSources } from "../../src/lib/answerFromSources.js"
import type { ChatbotSource } from "../../src/lib/chatbot.js"

const FALLBACK = "I can only help with questions about Acme. For anything else, please reach out to their team directly."

const sources: ChatbotSource[] = [
  { type: "website", label: "acme.com/pricing", url: "https://acme.com/pricing", characters: 100 },
  { type: "website", label: "acme.com/contact", url: "https://acme.com/contact", characters: 50 },
]

describe("answerFromSources", () => {
  it("answers a sources/trained question by listing sources", () => {
    const result = answerFromSources("what sources are you trained on?", sources, FALLBACK)
    expect(result.text).toContain("2 sources")
  })

  it("finds a pricing page when asked about price", () => {
    const result = answerFromSources("what is the price?", sources, FALLBACK)
    expect(result.text).toMatch(/pricing/i)
    expect(result.text).not.toBe(FALLBACK)
  })

  it("finds a contact page when asked about contact/support", () => {
    const result = answerFromSources("how do I contact support?", sources, FALLBACK)
    expect(result.text).toMatch(/contact/i)
  })

  it("returns the fixed fallback when nothing matches", () => {
    const result = answerFromSources("what's the weather like today?", sources, FALLBACK)
    expect(result.text).toBe(FALLBACK)
  })

  it("returns the fixed fallback when there are no sources at all", () => {
    const result = answerFromSources("anything?", [], FALLBACK)
    expect(result.text).toBe(FALLBACK)
  })
})
