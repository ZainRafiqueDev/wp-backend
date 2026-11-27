import { randomUUID } from "node:crypto"
import { describe, expect, it, vi } from "vitest"

// CS-13: two concurrent deliveries of the SAME Stripe event id run the
// grant/sync handler exactly once. The handler is replaced by a slow
// counter so the test does not depend on any handler-level idempotency
// (the top-up unique key would otherwise mask a double run).
const handler = vi.hoisted(() => ({ calls: 0 }))
vi.mock("../../src/services/billing.service.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/services/billing.service.js")>()
  return {
    ...actual,
    processStripeWebhookEvent: vi.fn(async () => {
      handler.calls += 1
      await new Promise((r) => setTimeout(r, 150))
    }),
  }
})

const { receiveVerifiedStripeEvent } = await import("../../src/services/stripeWebhookInbox.service.js")
const { pool } = await import("../../src/lib/db.js")

function event(id: string) {
  return { id, type: "invoice.paid", data: { object: { id: `in_${id}` } } } as unknown as import("stripe").Stripe.Event
}

describe("CS-13 Stripe inbox single-processor claim", () => {
  it("processes a concurrently duplicated event once; the losing delivery is told it is in progress", async () => {
    handler.calls = 0
    const e = event(`evt_cs13_concurrent_${randomUUID()}`)
    const outcomes = await Promise.all([receiveVerifiedStripeEvent(e), receiveVerifiedStripeEvent(e), receiveVerifiedStripeEvent(e)])

    expect(handler.calls).toBe(1)
    expect(outcomes.filter((o) => o === "processed")).toHaveLength(1)
    expect(outcomes.filter((o) => o === "in_progress")).toHaveLength(2)

    // A later replay of the processed event is a duplicate and does not run again.
    expect(await receiveVerifiedStripeEvent(e)).toBe("duplicate")
    expect(handler.calls).toBe(1)

    const { rows } = await pool!.query("select attempts, locked_until, processed_at from stripe_webhook_events where stripe_event_id = $1", [e.id])
    expect(rows[0].attempts).toBe(1)
    expect(rows[0].locked_until).toBeNull()
    expect(rows[0].processed_at).not.toBeNull()
  })
})
