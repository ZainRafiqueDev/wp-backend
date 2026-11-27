import { randomUUID, createHash, randomBytes } from "node:crypto"
import type { Client } from "pg"
import { afterAll, describe, expect, it, vi } from "vitest"

import { liveBooklyGate, startLiveBookly, stopLiveBookly, type LiveBookly } from "../helpers/liveBookly.js"

// This test's ENTIRE point is exercising a real network hop to a real
// Bookly process backed by a real Postgres exclusion constraint - so
// nothing about the booking path itself is mocked. The one, deliberate
// exception: lib/crawler/ssrf.ts's assertSafeUrl correctly and
// permanently blocks loopback/RFC1918 targets (see tests/unit/ssrf.test.ts
// - "rejects loopback", "rejects RFC1918 private ranges" - never weaken
// that shared check itself, it protects WooCommerce/backend-link too).
// There is no way to reach a same-machine test server without a loopback
// or private-LAN address, so this ONE test file mocks only the SSRF
// pre-check, leaving the real fetch(), the real spawned Bookly server, and
// the real Postgres constraint fully live - the only thing this narrows is
// "can this specific test's URL pass the pre-flight check," not the
// guarantee under test.
vi.mock("../../src/lib/crawler/ssrf.js", () => ({
  assertSafeUrl: async () => {},
  isPrivateAddress: () => false,
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}))

// Part B hardening item 4 — concurrent booking race condition, a REAL
// integration test: two near-simultaneous booking requests for the
// IDENTICAL resource/time slot, sent through the full
// ChatMate360 -> Bookly path (commitBooking -> the real Bookly HTTP API),
// not directly against Bookly alone. This is the one guarantee that can't
// be proven by mocking the Bookly connector (see
// booklyAuthorizationOrdering's tests for those) - the actual safety net is
// Bookly's own Postgres EXCLUDE constraint (backend/src/db/schema.sql), so
// this test spins up a REAL Bookly server against a real (test) Postgres
// database and asserts the integration layer neither introduces its own
// race nor turns Bookly's clean 409 into an unhandled 500.
//
// CS-17 (B08-023): runs only when explicitly enabled — RUN_LIVE_BOOKLY_TESTS=1
// plus BOOKLY_REPO_DIR (absolute path to the Bookly git checkout) and
// BOOKLY_REPO_SHA (the reviewed commit HEAD must match). Bookly's own test
// Postgres must be reachable at BOOKLY_TEST_DATABASE_URL (default: the
// helebooker_test database on port 5455). The spawn/env/cleanup logic is
// shared with the other live Bookly suites in tests/helpers/liveBookly.ts
// (minimal child env, child killed if startup fails).

const BOOKLY_TEST_PORT = Number(process.env.BOOKLY_TEST_PORT || "4091")

let live: LiveBookly | undefined
const gate = liveBooklyGate()
const skipSuite = !gate.enabled
let BOOKLY_BASE_URL = ""
let booklyDb: Client

function hashBooklyKey(rawKey: string): string {
  return createHash("sha256").update(rawKey, "utf8").digest("hex")
}

function generateBooklyApiKey(): string {
  const prefix = randomBytes(8).toString("hex")
  const secret = randomBytes(32).toString("base64url")
  return `bk_${prefix}_${secret}`
}

// Vitest test files support top-level await — resolved once, before the
// describe block below is even evaluated.
if (gate.enabled) {
  live = await startLiveBookly(BOOKLY_TEST_PORT, "booklyBookingRace", gate)
  BOOKLY_BASE_URL = live.baseUrl
  booklyDb = live.db
  // Warm up: the very first real request into a freshly-spawned Node
  // process (module JIT, first DB pool connections, first pino-http
  // request) is measurably slower than steady state — under a fully
  // parallel `vitest run`, that first-hit latency has been observed to
  // occasionally exceed this test's fetch timeout for one of the two racing
  // requests. One throwaway request here absorbs that cold-start cost.
  await fetch(`${BOOKLY_BASE_URL}/appointments/00000000-0000-0000-0000-000000000000`).catch(() => {})
} else {
  console.warn(`[booklyBookingRace] SKIPPED (opt-in live test): ${gate.reason}`)
}

afterAll(async () => {
  await stopLiveBookly(live)
})

describe.skipIf(skipSuite)("Bookly booking race — the full ChatMate360 -> Bookly path (Part B item 4)", () => {
  it("two near-simultaneous commitBooking calls for the identical resource/slot: exactly one CONFIRMED, one clean failure (never a raw 500)", async () => {
    const { pool: chatmatePool } = await import("../../src/lib/db.js")
    const { encryptSecret } = await import("../../src/lib/crypto.js")
    const { commitBooking } = await import("../../src/services/booklyBooking.service.js")
    const { signupUser } = await import("../helpers.js")

    // --- Seed a real resource + wide-open availability directly in
    // Bookly's own database (bypassing HTTP for setup - only the actual
    // booking calls below go over the real network to the live server).
    const { rows: resourceRows } = await booklyDb.query(
      "INSERT INTO resources (name, timezone, slot_duration_minutes) VALUES ($1, 'UTC', 30) RETURNING id",
      [`Race Test Resource ${randomUUID()}`],
    )
    const booklyResourceId = resourceRows[0].id as string
    for (let day = 0; day <= 6; day += 1) {
      await booklyDb.query(
        "INSERT INTO availability_rules (resource_id, day_of_week, start_time, end_time) VALUES ($1, $2, '00:00', '23:59')",
        [booklyResourceId, day],
      )
    }

    const rawApiKey = generateBooklyApiKey()
    const [, prefix] = rawApiKey.split("_")
    await booklyDb.query(
      "INSERT INTO api_keys (key_hash, key_prefix, label, resource_id) VALUES ($1, $2, 'race-test-key', $3)",
      [hashBooklyKey(rawApiKey), prefix, booklyResourceId],
    )

    // --- Wire up a ChatMate360 chatbot pointed at this live Bookly server.
    const db = chatmatePool!
    const { user } = await signupUser("bookly-race")
    await db.query(`insert into subscriptions (user_id, stripe_customer_id, plan, status) values ($1, $2, 'full_custom', 'active')`, [user.id, `cus_${randomUUID()}`])
    const { rows: chatbotRows } = await db.query("insert into chatbots (user_id, name, sources, theme, status) values ($1, 'bot', '[]', '{}', 'ready') returning id", [user.id])
    const chatbotId = chatbotRows[0].id as string
    await db.query(
      `insert into chatbot_bookly_credentials (chatbot_id, base_url, resource_id, resource_label, api_key_encrypted) values ($1, $2, $3, 'Race Resource', $4)`,
      [chatbotId, BOOKLY_BASE_URL, booklyResourceId, encryptSecret(rawApiKey)],
    )
    const { rows: customerRows } = await db.query("insert into customer_identities (chatbot_id, email) values ($1, $2) returning id", [chatbotId, `race-${randomUUID()}@example.test`])
    const customerId = customerRows[0].id as string

    // A near-future slot, on-grid for a 30-minute-duration resource
    // (availability is open every day of the week, but Bookly's own
    // available-slots computation only considers times aligned to the
    // resource's slot_duration_minutes grid — an arbitrary "now + 7 days"
    // timestamp would fail Bookly's OWN pre-insert availability check for
    // BOTH concurrent requests, which would still return two 409s but
    // wouldn't be exercising the exclusion-constraint race this test
    // exists to prove).
    const sevenDaysOut = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    sevenDaysOut.setUTCHours(10, 0, 0, 0)
    const startTime = sevenDaysOut.toISOString()

    // --- Fire both requests truly concurrently, DIFFERENT idempotency
    // keys (two genuinely different booking attempts wanting the same
    // slot - not a retry of the same one, which commitBooking's own
    // idempotency-claim already covers separately).
    const bookingInput = (name: string) => ({
      chatbotId,
      customerId,
      startTime,
      duration: 30,
      customer: { name, email: `${name.toLowerCase()}@example.com` },
      idempotencyKey: randomUUID(),
    })

    const results = await Promise.allSettled([commitBooking(bookingInput("RaceCustomerA")), commitBooking(bookingInput("RaceCustomerB"))])

    const fulfilled = results.filter((r) => r.status === "fulfilled")
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[]

    // Exactly one succeeds.
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)

    // The loser fails CLEANLY - a typed AppError with a real 4xx status,
    // never an unhandled exception/raw 500 leaking out of the integration
    // layer.
    const loserReason = rejected[0].reason as { status?: number; message?: string }
    expect(loserReason.status).toBeDefined()
    expect(loserReason.status).toBeLessThan(500)
    expect(loserReason.status).toBeGreaterThanOrEqual(400)

    // The database (Bookly's own, the real source of truth) contains
    // EXACTLY ONE CONFIRMED appointment for that resource/slot - proving
    // the integration layer didn't introduce a double-booking on top of
    // whatever Bookly's own exclusion constraint already guarantees.
    const { rows: confirmedRows } = await booklyDb.query(
      "SELECT id FROM appointments WHERE resource_id = $1 AND start_time = $2 AND status = 'CONFIRMED'",
      [booklyResourceId, startTime],
    )
    expect(confirmedRows).toHaveLength(1)
  }, 30_000)
})
