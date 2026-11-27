import { describe, expect, it } from "vitest"

import { resolveTenantGucs, runWithTenantContext, isUuid } from "../../src/lib/tenantContext.js"

describe("WP-3.1 tenant context", () => {
  it("rejects non-uuid chatbot and user ids rather than putting them in GUCs", () => {
    const gucs = runWithTenantContext(
      { scope: "user", chatbotId: "not-a-uuid", userId: "also-bad", userEmail: "  A@B.COM " },
      () => resolveTenantGucs(),
    )
    expect(gucs.chatbotId).toBe("")
    expect(gucs.userId).toBe("")
    expect(gucs.userEmail).toBe("a@b.com")
    expect(gucs.scope).toBe("user")
  })

  it("accepts a real uuid", () => {
    expect(isUuid("6acda70b-a97e-45bf-8ba4-f1fb8db92246")).toBe(true)
    expect(isUuid("public")).toBe(false)
  })
})
