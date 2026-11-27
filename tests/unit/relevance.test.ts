import { describe, expect, it } from "vitest"

import { hasRelevantContent, rankPagesByRelevance } from "../../src/lib/relevance.js"

const pages = [{ path: "/", title: "About Zarar", text: "Zarar is a web developer and graphic designer." }]

// Controlled source that mentions "web development" but not "websites"/"sites"/
// "services" — the synonym/paraphrase cases that previously failed the gate.
const webDevOnly = [
  {
    path: "/",
    title: "Acme",
    text: "Acme Co offers web development for small businesses. Contact us for a quote.",
  },
]

const multiPage = [
  { path: "/about", title: "About", text: "We are a software company based in Lahore." },
  {
    path: "/service/web-development",
    title: "Web Development",
    text: "Our web development team builds custom responsive websites and web apps.",
  },
  { path: "/contact", title: "Contact", text: "Email hello@example.com." },
]

describe("hasRelevantContent", () => {
  it("is true when the question shares a meaningful word with a page", () => {
    expect(hasRelevantContent("What does Zarar do for work?", pages)).toBe(true)
  })

  it("is false when nothing overlaps", () => {
    expect(hasRelevantContent("What is the capital of France?", pages)).toBe(false)
  })

  it("is true for an empty/only-stopword question (documented edge case, not a real gate)", () => {
    expect(hasRelevantContent("what is", pages)).toBe(true)
  })

  it("is case-insensitive", () => {
    expect(hasRelevantContent("WHO IS ZARAR", pages)).toBe(true)
  })
})

describe("hasRelevantContent synonym / paraphrase regression (web development)", () => {
  it("exact phrase still matches", () => {
    expect(hasRelevantContent("What is web development?", webDevOnly)).toBe(true)
  })

  it("abbreviation definition question matches", () => {
    expect(hasRelevantContent("what is web dev?", webDevOnly)).toBe(true)
    expect(hasRelevantContent("web dev", webDevOnly)).toBe(true)
  })

  it("near-synonym phrase matches", () => {
    expect(hasRelevantContent("website development", webDevOnly)).toBe(true)
  })

  it("natural-language paraphrase matches", () => {
    expect(hasRelevantContent("do you build websites?", webDevOnly)).toBe(true)
  })

  it("informal wording matches", () => {
    expect(hasRelevantContent("do you make sites?", webDevOnly)).toBe(true)
  })

  it("service paraphrase matches", () => {
    expect(hasRelevantContent("what web services do you provide?", webDevOnly)).toBe(true)
  })

  it("rejects unrelated weather questions", () => {
    expect(hasRelevantContent("what is the weather tomorrow?", webDevOnly)).toBe(false)
    expect(hasRelevantContent("What is the weather?", webDevOnly)).toBe(false)
  })

  it("rejects unrelated sports questions", () => {
    expect(hasRelevantContent("who won the world cup in 2018?", webDevOnly)).toBe(false)
  })

  it("lets in-scope but unsupported questions through the gate (LLM must decline, not invent)", () => {
    // Gate should NOT collapse IN_SCOPE+INSUFFICIENT into out-of-scope.
    expect(hasRelevantContent("What programming languages do your web developers use?", webDevOnly)).toBe(true)
  })
})

describe("rankPagesByRelevance", () => {
  it("puts the web-development page ahead of unrelated pages for web-dev questions", () => {
    const ranked = rankPagesByRelevance("what is web dev?", multiPage)
    expect(ranked[0].path).toBe("/service/web-development")
  })
})
