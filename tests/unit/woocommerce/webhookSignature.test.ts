import { createHmac } from "node:crypto"
import { describe, expect, it } from "vitest"

import { verifyWooCommerceWebhookSignature } from "../../../src/lib/woocommerce/webhookSignature.js"

describe("verifyWooCommerceWebhookSignature", () => {
  const secret = "whsec_test_123"
  const body = Buffer.from(JSON.stringify({ id: 1, status: "processing" }))

  it("accepts a correctly-computed HMAC-SHA256 signature", () => {
    const signature = createHmac("sha256", secret).update(body).digest("base64")
    expect(verifyWooCommerceWebhookSignature(body, signature, secret)).toBe(true)
  })

  it("rejects a missing signature header", () => {
    expect(verifyWooCommerceWebhookSignature(body, undefined, secret)).toBe(false)
  })

  it("rejects a tampered body (signature no longer matches)", () => {
    const signature = createHmac("sha256", secret).update(body).digest("base64")
    const tamperedBody = Buffer.from(JSON.stringify({ id: 1, status: "completed" }))
    expect(verifyWooCommerceWebhookSignature(tamperedBody, signature, secret)).toBe(false)
  })

  it("rejects a signature computed with the wrong secret", () => {
    const signature = createHmac("sha256", "wrong-secret").update(body).digest("base64")
    expect(verifyWooCommerceWebhookSignature(body, signature, secret)).toBe(false)
  })

  it("rejects a garbage signature value", () => {
    expect(verifyWooCommerceWebhookSignature(body, "not-a-real-signature", secret)).toBe(false)
  })
})
