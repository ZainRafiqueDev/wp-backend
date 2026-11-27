import { describe, expect, it } from "vitest"

import { generateBookingNumberCandidate } from "../../../src/lib/woocommerce/bookingNumber.js"

describe("generateBookingNumberCandidate", () => {
  it("produces a CM-prefixed code from the expected alphabet", () => {
    const candidate = generateBookingNumberCandidate()
    expect(candidate).toMatch(/^CM-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/)
  })

  it("produces different candidates across calls (not deterministic)", () => {
    const candidates = new Set(Array.from({ length: 20 }, () => generateBookingNumberCandidate()))
    expect(candidates.size).toBeGreaterThan(1)
  })
})
