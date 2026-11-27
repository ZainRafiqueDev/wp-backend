import { describe, expect, it } from "vitest"

import { createActionSchema } from "../../src/validators/actions.validator.js"
import { connectBooklySchema } from "../../src/validators/booklyCredentials.validator.js"
import { chatbotSourceSchema, createChatbotSchema, retryChatbotSchema } from "../../src/validators/chatbot.validator.js"
import { connectWooCommerceSchema } from "../../src/validators/commerceWooCommerce.validator.js"
import { createOkfConceptSchema } from "../../src/validators/okf.validator.js"

// CS-08 (B08-011): z.string().url() alone accepts javascript:, file:, gopher:,
// data: ... Tenant-supplied URLs must be http(s) only.

const BAD = [
  "javascript:alert(document.cookie)",
  "JavaScript:alert(1)",
  "file:///etc/passwd",
  "gopher://127.0.0.1:6379/_FLUSHALL",
  "data:text/html,<script>alert(1)</script>",
  "ftp://example.com/",
  "vbscript:msgbox(1)",
  "ws://example.com/",
]
const GOOD = ["https://example.com/", "http://shop.example.com/wp", "  https://example.com/path?q=1  "]

const okfBase = { type: "Policy", title: "t", bodyMd: "b" }

const cases: [string, (url: string) => boolean][] = [
  ["bookly baseUrl", (u) => connectBooklySchema.safeParse({ baseUrl: u, resourceId: "r1", apiKey: "k" }).success],
  [
    "woocommerce storeUrl",
    (u) =>
      connectWooCommerceSchema.safeParse({ storeUrl: u, consumerKey: "a", consumerSecret: "b", webhookSecret: "c" })
        .success,
  ],
  ["chatbot websiteUrl", (u) => createChatbotSchema.safeParse({ name: "Test bot", websiteUrl: u }).success],
  ["chatbot retry websiteUrl", (u) => retryChatbotSchema.safeParse({ websiteUrl: u }).success],
  [
    "chatbot source url",
    (u) => chatbotSourceSchema.safeParse({ type: "website", label: "site", url: u, characters: 0 }).success,
  ],
  ["okf resourceUrl", (u) => createOkfConceptSchema.safeParse({ ...okfBase, resourceUrl: u.trim() }).success],
]

describe("tenant URL validators accept only http(s) (CS-08)", () => {
  for (const [name, accepts] of cases) {
    it.each(BAD)(`${name} rejects %s`, (url) => {
      expect(accepts(url)).toBe(false)
    })
    it.each(GOOD)(`${name} accepts %s`, (url) => {
      expect(accepts(url)).toBe(true)
    })
  }

  it("okf resourceUrl still accepts empty string / null / omitted", () => {
    expect(createOkfConceptSchema.safeParse({ ...okfBase, resourceUrl: "" }).success).toBe(true)
    expect(createOkfConceptSchema.safeParse({ ...okfBase, resourceUrl: null }).success).toBe(true)
    expect(createOkfConceptSchema.safeParse(okfBase).success).toBe(true)
  })
})

describe("custom action urlTemplate scheme (CS-08)", () => {
  const base = { name: "get_order", description: "Look up an order", httpMethod: "GET" as const }
  it.each(["javascript:alert(1)", "file:///etc/passwd", "gopher://x/", "{{base}}/orders", "/orders/{{id}}", "https://"])(
    "rejects %s",
    (urlTemplate) => {
      expect(createActionSchema.safeParse({ ...base, urlTemplate }).success).toBe(false)
    },
  )
  it.each(["https://api.example.com/orders/{{order_id}}", "http://{{host}}.example.com/x", "HTTPS://api.example.com/"])(
    "accepts %s",
    (urlTemplate) => {
      expect(createActionSchema.safeParse({ ...base, urlTemplate }).success).toBe(true)
    },
  )
})
