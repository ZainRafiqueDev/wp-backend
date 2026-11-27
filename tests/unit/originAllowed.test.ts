import { describe, expect, it } from "vitest"

import { originAllowed } from "../../src/lib/originAllowed.js"

describe("originAllowed", () => {
  it("matches the bare domain exactly", () => {
    expect(originAllowed("https://example.com", "example.com")).toBe(true)
  })

  it("matches a subdomain of the allowed domain", () => {
    expect(originAllowed("https://shop.example.com", "example.com")).toBe(true)
  })

  it("rejects an unrelated domain", () => {
    expect(originAllowed("https://evil.com", "example.com")).toBe(false)
  })

  it("rejects a domain that merely contains the allowed domain as a substring", () => {
    // notexample.com must NOT match example.com — a naive `.includes()` or
    // unanchored suffix check would wrongly allow this.
    expect(originAllowed("https://notexample.com", "example.com")).toBe(false)
    expect(originAllowed("https://example.com.evil.com", "example.com")).toBe(false)
  })

  it("rejects when allowedDomain is unset", () => {
    expect(originAllowed("https://example.com", undefined)).toBe(false)
  })

  it("rejects a malformed origin", () => {
    expect(originAllowed("not-a-url", "example.com")).toBe(false)
  })

  it("is case-insensitive", () => {
    expect(originAllowed("https://Example.COM", "example.com")).toBe(true)
  })
})
