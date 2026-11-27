import { describe, expect, it } from "vitest"
import type { ErrorEvent } from "@sentry/node"

import { scrubEvent } from "../../src/lib/sentry.js"

function baseEvent(overrides: Partial<ErrorEvent> = {}): ErrorEvent {
  return { ...overrides } as ErrorEvent
}

describe("scrubEvent — Sentry beforeSend PII/secret scrubbing", () => {
  it("strips the request body entirely — a customer's chat message must never leave the process", () => {
    const event = baseEvent({
      request: { data: { message: "my real name is John and my card is 4111111111111111" } },
    })
    const scrubbed = scrubEvent(event)
    expect(scrubbed.request?.data).toBeUndefined()
  })

  it("strips query strings and cookies", () => {
    const event = baseEvent({
      request: { query_string: "token=abc123", cookies: { chatmate360_access_token: "secret" } },
    })
    const scrubbed = scrubEvent(event)
    expect(scrubbed.request?.query_string).toBeUndefined()
    expect(scrubbed.request?.cookies).toBeUndefined()
  })

  it("strips Authorization and Cookie headers but keeps other headers", () => {
    const event = baseEvent({
      request: {
        headers: { authorization: "Bearer real-token", "user-agent": "vitest" },
      },
    })
    const scrubbed = scrubEvent(event)
    expect(scrubbed.request?.headers?.authorization).toBeUndefined()
    expect(scrubbed.request?.headers?.["user-agent"]).toBe("vitest")
  })

  it("reduces event.user to just an id, dropping email and IP", () => {
    const event = baseEvent({ user: { id: "user-123", email: "real@customer.com", ip_address: "1.2.3.4" } })
    const scrubbed = scrubEvent(event)
    expect(scrubbed.user).toEqual({ id: "user-123" })
  })

  it("drops event.user entirely when it has no id", () => {
    const event = baseEvent({ user: { email: "real@customer.com" } })
    const scrubbed = scrubEvent(event)
    expect(scrubbed.user).toBeUndefined()
  })

  it("redacts secret-shaped substrings inside breadcrumb messages and drops breadcrumb data", () => {
    const event = baseEvent({
      breadcrumbs: [
        {
          message: "Stripe call failed with key sk_live_abc123def456",
          data: { headers: { authorization: "Bearer real-token" } },
        },
      ],
    })
    const scrubbed = scrubEvent(event)
    expect(scrubbed.breadcrumbs?.[0].message).toBe("Stripe call failed with key [redacted]")
    expect(scrubbed.breadcrumbs?.[0].data).toBeUndefined()
  })

  it("redacts secret-shaped substrings inside exception values", () => {
    const event = baseEvent({
      exception: {
        values: [{ type: "Error", value: "webhook signature whsec_abcdef123456 did not match" }],
      },
    })
    const scrubbed = scrubEvent(event)
    expect(scrubbed.exception?.values?.[0].value).toBe("webhook signature [redacted] did not match")
  })
})
