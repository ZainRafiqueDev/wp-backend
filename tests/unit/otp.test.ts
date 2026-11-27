import { describe, expect, it } from "vitest"

import { generateOtpCode } from "../../src/services/otp.service.js"
import { signOtpProofToken, verifyOtpProofToken } from "../../src/lib/auth.js"
import { hashToken } from "../../src/services/notification.service.js"

describe("OTP helpers", () => {
  it("generateOtpCode returns a 6-digit string", () => {
    for (let i = 0; i < 20; i++) {
      const code = generateOtpCode()
      expect(code).toMatch(/^\d{6}$/)
    }
  })

  it("hashes OTPs the same way as opaque tokens (never store plaintext)", () => {
    expect(hashToken("482193")).toBe(hashToken("482193"))
    expect(hashToken("482193")).not.toBe("482193")
  })

  it("otp proof tokens round-trip and reject garbage", () => {
    const token = signOtpProofToken({
      purpose: "ORDER_ACCESS",
      email: "customer@example.test",
      chatbotId: "11111111-1111-1111-1111-111111111111",
      customerId: "22222222-2222-2222-2222-222222222222",
    })
    const claims = verifyOtpProofToken(token)
    expect(claims?.purpose).toBe("ORDER_ACCESS")
    expect(claims?.email).toBe("customer@example.test")
    expect(verifyOtpProofToken("forged")).toBeNull()
  })
})
