import { describe, expect, it } from "vitest"

import { isLikelyOkfRelevantPage, scoreOkfRelevance } from "../../src/lib/okfPageRelevance.js"

describe("okfPageRelevance — deterministic pre-filter for crawl-triggered OKF suggestions", () => {
  it("matches a page whose URL path looks like a policy/pricing page", () => {
    expect(isLikelyOkfRelevantPage("https://store.example/refund-policy", "some generic text")).toBe(true)
    expect(isLikelyOkfRelevantPage("https://store.example/pricing", "some generic text")).toBe(true)
    expect(isLikelyOkfRelevantPage("https://store.example/faq", "some generic text")).toBe(true)
    expect(isLikelyOkfRelevantPage("https://store.example/shipping-info", "some generic text")).toBe(true)
  })

  it("rejects boilerplate pages by URL even if the deny list would otherwise not apply", () => {
    expect(isLikelyOkfRelevantPage("https://store.example/blog/our-2026-roadmap", "generic content")).toBe(false)
    expect(isLikelyOkfRelevantPage("https://store.example/about-us", "generic content")).toBe(false)
    expect(isLikelyOkfRelevantPage("https://store.example/careers", "generic content")).toBe(false)
    expect(isLikelyOkfRelevantPage("https://store.example/news/press-release", "generic content")).toBe(false)
  })

  it("the deny list wins even when the URL also contains an allow-listed word", () => {
    // A blog post *about* pricing is still a blog post, not a pricing page.
    expect(isLikelyOkfRelevantPage("https://store.example/blog/pricing-explained", "we discuss pricing")).toBe(false)
  })

  it("matches on content signal alone when the URL gives no hint (single-page site, query-string routing)", () => {
    const policyText = "Our refund policy: items may be returned within 30 days for a full refund."
    expect(isLikelyOkfRelevantPage("https://store.example/page?id=42", policyText)).toBe(true)
  })

  it("matches a currency amount as a content signal", () => {
    expect(isLikelyOkfRelevantPage("https://store.example/", "The starter plan costs $29 per month.")).toBe(true)
  })

  it("does not match a generic page with no policy/pricing signal at all", () => {
    expect(isLikelyOkfRelevantPage("https://store.example/", "Welcome to our website. We build great products.")).toBe(false)
  })

  it("only checks the first 5000 characters of content for a signal", () => {
    const padding = "x".repeat(6000)
    const buriedSignal = `${padding} Our refund policy: 30 days, $50 fee.`
    expect(isLikelyOkfRelevantPage("https://store.example/some-page", buriedSignal)).toBe(false)
  })

  it("scores a page matching both URL and content signals higher than one matching only one signal", () => {
    const urlOnly = scoreOkfRelevance("https://store.example/pricing", "no signals here")
    const urlAndContent = scoreOkfRelevance("https://store.example/pricing", "Plans start at $29/month.")
    const contentOnly = scoreOkfRelevance("https://store.example/", "Plans start at $29/month.")
    expect(urlOnly).toBeGreaterThan(0)
    expect(urlAndContent).toBeGreaterThan(urlOnly)
    expect(contentOnly).toBeGreaterThan(0)
    expect(contentOnly).toBeLessThan(urlAndContent)
  })

  it("scores a denied page as exactly 0 regardless of content", () => {
    expect(scoreOkfRelevance("https://store.example/blog/post", "Our refund policy is 30 days, $50 fee.")).toBe(0)
  })

  it("falls back to treating the raw string as the path when the URL fails to parse", () => {
    expect(isLikelyOkfRelevantPage("not-a-real-url-but-has-pricing-in-it", "no content signal")).toBe(true)
    expect(isLikelyOkfRelevantPage("not-a-real-url-blog-post", "no content signal")).toBe(false)
  })
})
