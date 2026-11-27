import request from "supertest"
import { describe, expect, it, vi } from "vitest"

// This suite tests WP-3.4 memory mechanics (facts, TTL, compaction, privacy),
// not answer quality or extraction wording — so the cheap model is mocked, the
// same way sessionMemory.integration.test.ts does it. completeCheaply is the
// single call site both the summary and the fact extractor go through.
const FACTS_JSON = '[{"key":"order_number","value":"#4471","confidence":0.9},{"key":"shipping_city","value":"Lahore","confidence":0.8}]'

vi.mock("../../src/lib/ai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/ai.js")>()
  return {
    ...actual,
    completeCheaply: vi.fn(async (prompt: string) =>
      prompt.includes("Extract durable facts") ? FACTS_JSON : "Customer asked about order #4471. Sentiment: neutral.",
    ),
  }
})

const { app, createReadyChatbotWithDomain } = await import("../helpers.js")
const { pool } = await import("../../src/lib/db.js")
const { env } = await import("../../src/env.js")
const { resolveCustomerIdentity } = await import("../../src/services/customerIdentity.service.js")
const { signOtpProofToken } = await import("../../src/lib/auth.js")

// What POST /auth/otp/verify hands the widget after a successful
// ORDER_ACCESS/SENSITIVE_ACTION code for this customer.
function memoryProof(chatbotId: string, customerId: string, email: string, purpose: "ORDER_ACCESS" | "SENSITIVE_ACTION" | "EMAIL_VERIFY" = "SENSITIVE_ACTION") {
  return signOtpProofToken({ purpose, email, chatbotId, customerId })
}
const {
  customerIdentifierFromEmail,
  deleteCustomerMemory,
  exportCustomerMemory,
  extractFactsAfterTurn,
  listCustomerFacts,
  purgeExpiredCustomerMemory,
  upsertCustomerFacts,
} = await import("../../src/services/sessionMemory.service.js")
const {
  compactConversation,
  findConversationsNeedingCompaction,
  loadConversationContext,
  recordTurn,
  runConversationMaintenanceTick,
  sweepExpiredConversations,
} = await import("../../src/services/conversation.service.js")

function db() {
  if (!pool) throw new Error("this suite requires a database pool")
  return pool
}

describe("WP-3.4 structured customer facts", () => {
  it("extracts facts from a turn, folds a restatement into the same row, and keeps first_seen_at", async () => {
    const { chatbotId } = await createReadyChatbotWithDomain("facts-extract", `facts-extract-${Date.now()}.test`)
    const identifier = customerIdentifierFromEmail(chatbotId, "facts-extract@example.test")

    const extracted = await extractFactsAfterTurn(chatbotId, identifier, "Where is order #4471?", "It ships to Lahore tomorrow.")
    expect(extracted).toBe(2)

    const facts = await listCustomerFacts(chatbotId, identifier)
    expect(facts.map((fact) => fact.key).sort()).toEqual(["order_number", "shipping_city"])
    const firstSeen = facts.find((fact) => fact.key === "order_number")!.firstSeenAt

    // A later turn restating the same fact must update in place, not duplicate.
    await upsertCustomerFacts(chatbotId, identifier, [{ key: "order_number", value: "#4471 (delivered)", confidence: 1 }])

    const after = await listCustomerFacts(chatbotId, identifier)
    expect(after).toHaveLength(2)
    const orderFact = after.find((fact) => fact.key === "order_number")!
    expect(orderFact.value).toBe("#4471 (delivered)")
    expect(orderFact.firstSeenAt).toBe(firstSeen)
  })

  it("evicts least-recently-seen facts instead of growing without bound", async () => {
    const { chatbotId } = await createReadyChatbotWithDomain("facts-cap", `facts-cap-${Date.now()}.test`)
    const identifier = customerIdentifierFromEmail(chatbotId, "facts-cap@example.test")

    const overCap = env.sessionMemoryMaxFacts + 6
    await upsertCustomerFacts(
      chatbotId,
      identifier,
      Array.from({ length: overCap }, (_, i) => ({ key: `fact_${i}`, value: `value ${i}`, confidence: 0.5 })),
    )

    const { rows } = await db().query<{ n: string }>(
      "select count(*)::text as n from conversation_facts where chatbot_id = $1 and customer_identifier = $2",
      [chatbotId, identifier],
    )
    expect(Number(rows[0].n)).toBe(env.sessionMemoryMaxFacts)
  })

  it("keeps facts isolated per tenant even for the same customer email", async () => {
    const { chatbotId: chatbotA } = await createReadyChatbotWithDomain("facts-tenant-a", `facts-tenant-a-${Date.now()}.test`)
    const { chatbotId: chatbotB } = await createReadyChatbotWithDomain("facts-tenant-b", `facts-tenant-b-${Date.now()}.test`)
    const sharedEmail = "facts-shared@example.test"
    const identifierA = customerIdentifierFromEmail(chatbotA, sharedEmail)
    const identifierB = customerIdentifierFromEmail(chatbotB, sharedEmail)

    await upsertCustomerFacts(chatbotA, identifierA, [{ key: "city", value: "Lahore", confidence: 1 }])

    expect(await listCustomerFacts(chatbotA, identifierA)).toHaveLength(1)
    expect(await listCustomerFacts(chatbotB, identifierB)).toHaveLength(0)
    // Even reusing tenant A's identifier under tenant B must find nothing:
    // chatbot_id is a real column filter, not just an input to the hash.
    expect(await listCustomerFacts(chatbotB, identifierA)).toHaveLength(0)
  })

  it("returns 0 and writes nothing when the model produces no parseable facts", async () => {
    const { chatbotId } = await createReadyChatbotWithDomain("facts-empty", `facts-empty-${Date.now()}.test`)
    const identifier = customerIdentifierFromEmail(chatbotId, "facts-empty@example.test")

    const ai = await import("../../src/lib/ai.js")
    vi.mocked(ai.completeCheaply).mockResolvedValueOnce("I don't see any durable facts here.")

    expect(await extractFactsAfterTurn(chatbotId, identifier, "hello", "hi there")).toBe(0)
    expect(await listCustomerFacts(chatbotId, identifier)).toHaveLength(0)
  })
})

describe("WP-3.4 conversation TTL and off-request-path compaction", () => {
  it("recordTurn only writes the turn — it flags compaction instead of doing it inline", async () => {
    const { chatbotId } = await createReadyChatbotWithDomain("compact-async", `compact-async-${Date.now()}.test`)
    const sessionId = `session-${Date.now()}`
    const { conversationId } = await loadConversationContext(chatbotId, sessionId)

    for (let turn = 0; turn < env.conversationSummaryThresholdTurns; turn += 1) {
      await recordTurn(conversationId, `question ${turn}`, `answer ${turn}`)
    }

    const { rows: flagged } = await db().query<{ needs_compaction: boolean; summary: string | null }>(
      "select needs_compaction, summary from conversations where id = $1",
      [conversationId],
    )
    expect(flagged[0].needs_compaction).toBe(true)
    // Nothing compacted yet: the request path must not have touched messages.
    expect(flagged[0].summary).toBeNull()

    const { rows: beforeCount } = await db().query<{ n: string }>(
      "select count(*)::text as n from messages where conversation_id = $1",
      [conversationId],
    )
    expect(Number(beforeCount[0].n)).toBe(env.conversationSummaryThresholdTurns * 2)

    expect(await findConversationsNeedingCompaction(50)).toContain(conversationId)

    const compacted = await compactConversation(conversationId)
    expect(compacted).toBeGreaterThan(0)

    const { rows: after } = await db().query<{ needs_compaction: boolean; summary: string | null }>(
      "select needs_compaction, summary from conversations where id = $1",
      [conversationId],
    )
    expect(after[0].needs_compaction).toBe(false)
    expect(after[0].summary).toContain("question 0")

    const { rows: afterCount } = await db().query<{ n: string }>(
      "select count(*)::text as n from messages where conversation_id = $1",
      [conversationId],
    )
    expect(Number(afterCount[0].n)).toBe(env.conversationContextTurns * 2)
  })

  it("clears the flag without compacting when a flagged conversation turns out to be short", async () => {
    const { chatbotId } = await createReadyChatbotWithDomain("compact-noop", `compact-noop-${Date.now()}.test`)
    const { conversationId } = await loadConversationContext(chatbotId, `session-noop-${Date.now()}`)
    await db().query("update conversations set needs_compaction = true where id = $1", [conversationId])

    expect(await compactConversation(conversationId)).toBe(0)
    const { rows } = await db().query<{ needs_compaction: boolean }>(
      "select needs_compaction from conversations where id = $1",
      [conversationId],
    )
    expect(rows[0].needs_compaction).toBe(false)
  })

  it("stamps an idle TTL on create, pushes it out on every turn, and sweeps only expired rows", async () => {
    const { chatbotId } = await createReadyChatbotWithDomain("ttl-sweep", `ttl-sweep-${Date.now()}.test`)
    const liveSession = `live-${Date.now()}`
    const staleSession = `stale-${Date.now()}`

    const live = await loadConversationContext(chatbotId, liveSession)
    const stale = await loadConversationContext(chatbotId, staleSession)

    const { rows: stamped } = await db().query<{ expires_at: Date | null }>(
      "select expires_at from conversations where id = $1",
      [live.conversationId],
    )
    expect(stamped[0].expires_at).not.toBeNull()

    // Backdate both, then touch only the live one — a turn must refresh the TTL.
    await db().query("update conversations set expires_at = now() - interval '1 hour' where id = any($1::uuid[])", [
      [live.conversationId, stale.conversationId],
    ])
    await recordTurn(live.conversationId, "still here", "welcome back")

    await sweepExpiredConversations()

    const { rows: remaining } = await db().query<{ id: string }>(
      "select id from conversations where id = any($1::uuid[])",
      [[live.conversationId, stale.conversationId]],
    )
    expect(remaining.map((row) => row.id)).toEqual([live.conversationId])
  })

  it("a new session after expiry starts cold rather than inheriting the old summary", async () => {
    const { chatbotId } = await createReadyChatbotWithDomain("ttl-cold", `ttl-cold-${Date.now()}.test`)
    const sessionId = `reused-${Date.now()}`

    const first = await loadConversationContext(chatbotId, sessionId)
    await db().query("update conversations set summary = 'old business', expires_at = now() - interval '1 day' where id = $1", [
      first.conversationId,
    ])
    await sweepExpiredConversations()

    const second = await loadConversationContext(chatbotId, sessionId)
    expect(second.conversationId).not.toBe(first.conversationId)
    expect(second.history).toEqual([])
  })

  it("deletes a conversation's messages along with it", async () => {
    const { chatbotId } = await createReadyChatbotWithDomain("ttl-cascade", `ttl-cascade-${Date.now()}.test`)
    const { conversationId } = await loadConversationContext(chatbotId, `cascade-${Date.now()}`)
    await recordTurn(conversationId, "q", "a")
    await db().query("update conversations set expires_at = now() - interval '1 day' where id = $1", [conversationId])

    await sweepExpiredConversations()

    const { rows } = await db().query<{ n: string }>(
      "select count(*)::text as n from messages where conversation_id = $1",
      [conversationId],
    )
    expect(Number(rows[0].n)).toBe(0)
  })
})

describe("WP-3.4 retention and the maintenance tick", () => {
  it("purges cross-session memory past the retention window and leaves fresh memory alone", async () => {
    const { chatbotId } = await createReadyChatbotWithDomain("memory-retention", `memory-retention-${Date.now()}.test`)
    const staleIdentifier = customerIdentifierFromEmail(chatbotId, "stale@example.test")
    const freshIdentifier = customerIdentifierFromEmail(chatbotId, "fresh@example.test")
    const pastRetention = env.sessionMemoryRetentionDays + 1

    for (const identifier of [staleIdentifier, freshIdentifier]) {
      await db().query(
        "insert into session_summaries (chatbot_id, customer_identifier, summary_md) values ($1, $2, 'older business')",
        [chatbotId, identifier],
      )
      await upsertCustomerFacts(chatbotId, identifier, [{ key: "city", value: "Lahore", confidence: 1 }])
    }

    await db().query(
      `update session_summaries set updated_at = now() - ($1 * interval '1 day')
        where chatbot_id = $2 and customer_identifier = $3`,
      [pastRetention, chatbotId, staleIdentifier],
    )
    await db().query(
      `update conversation_facts set last_seen_at = now() - ($1 * interval '1 day')
        where chatbot_id = $2 and customer_identifier = $3`,
      [pastRetention, chatbotId, staleIdentifier],
    )

    await purgeExpiredCustomerMemory()

    expect((await exportCustomerMemory(chatbotId, staleIdentifier)).summary).toBeNull()
    expect(await listCustomerFacts(chatbotId, staleIdentifier)).toHaveLength(0)
    expect((await exportCustomerMemory(chatbotId, freshIdentifier)).summary).not.toBeNull()
    expect(await listCustomerFacts(chatbotId, freshIdentifier)).toHaveLength(1)
  })

  it("one maintenance tick compacts, expires, and purges in a single pass", async () => {
    const { chatbotId } = await createReadyChatbotWithDomain("maintenance-tick", `maintenance-tick-${Date.now()}.test`)

    const { conversationId } = await loadConversationContext(chatbotId, `tick-compact-${Date.now()}`)
    for (let turn = 0; turn < env.conversationSummaryThresholdTurns; turn += 1) {
      await recordTurn(conversationId, `question ${turn}`, `answer ${turn}`)
    }

    const expiring = await loadConversationContext(chatbotId, `tick-expire-${Date.now()}`)
    await db().query("update conversations set expires_at = now() - interval '1 day' where id = $1", [
      expiring.conversationId,
    ])

    const result = await runConversationMaintenanceTick()
    expect(result.compacted).toBeGreaterThanOrEqual(1)
    expect(result.expired).toBeGreaterThanOrEqual(1)

    const { rows } = await db().query<{ needs_compaction: boolean; summary: string | null }>(
      "select needs_compaction, summary from conversations where id = $1",
      [conversationId],
    )
    expect(rows[0].needs_compaction).toBe(false)
    expect(rows[0].summary).not.toBeNull()

    const { rows: gone } = await db().query("select 1 from conversations where id = $1", [expiring.conversationId])
    expect(gone).toHaveLength(0)
  })
})

describe("WP-3.4 privacy export and erasure", () => {
  it("exports summary plus facts, and hard-deletes both on request", async () => {
    const { chatbotId, domain } = await createReadyChatbotWithDomain("memory-privacy", `memory-privacy-${Date.now()}.test`)
    const identity = await resolveCustomerIdentity(chatbotId, "privacy-customer@example.test")
    const identifier = customerIdentifierFromEmail(chatbotId, identity.email!)

    await db().query(
      "insert into session_summaries (chatbot_id, customer_identifier, summary_md) values ($1, $2, 'Asked about order #4471.')",
      [chatbotId, identifier],
    )
    await upsertCustomerFacts(chatbotId, identifier, [{ key: "order_number", value: "#4471", confidence: 0.9 }])

    const headers = { "X-Widget-Origin": `https://${domain}`, Referer: `https://${domain}/page` }

    const exported = await request(app)
      .post(`/public/chatbots/${chatbotId}/memory/export`)
      .set(headers)
      .send({ proofToken: memoryProof(chatbotId, identity.id, identity.email!) })

    expect(exported.status).toBe(200)
    expect(exported.body.memory.summary.summaryMd).toContain("#4471")
    expect(exported.body.memory.facts).toHaveLength(1)
    // The export must never echo the raw email, only the hashed identifier.
    expect(JSON.stringify(exported.body)).not.toContain("privacy-customer@example.test")

    const deleted = await request(app)
      .post(`/public/chatbots/${chatbotId}/memory/delete`)
      .set(headers)
      .send({ proofToken: memoryProof(chatbotId, identity.id, identity.email!) })

    expect(deleted.status).toBe(200)
    expect(deleted.body.deleted).toEqual({ summariesDeleted: 1, factsDeleted: 1 })

    const after = await exportCustomerMemory(chatbotId, identifier)
    expect(after.summary).toBeNull()
    expect(after.facts).toHaveLength(0)
  })

  it("refuses a customer id belonging to a different chatbot", async () => {
    // CROSS_TENANT: POST /public/chatbots/:chatbotId/memory/export
    const { chatbotId: ownerBot } = await createReadyChatbotWithDomain("memory-owner", `memory-owner-${Date.now()}.test`)
    const { chatbotId: otherBot, domain: otherDomain } = await createReadyChatbotWithDomain(
      "memory-other",
      `memory-other-${Date.now()}.test`,
    )
    const identity = await resolveCustomerIdentity(ownerBot, "cross-tenant-privacy@example.test")

    const res = await request(app)
      .post(`/public/chatbots/${otherBot}/memory/export`)
      .set({ "X-Widget-Origin": `https://${otherDomain}`, Referer: `https://${otherDomain}/p` })
      // A validly signed proof for otherBot naming ownerBot's customer.
      .send({ proofToken: memoryProof(otherBot, identity.id, identity.email!) })

    expect(res.status).toBe(404)
  })

  it("cannot erase another chatbot's customer memory", async () => {
    // CROSS_TENANT: POST /public/chatbots/:chatbotId/memory/delete
    const { chatbotId: ownerBot } = await createReadyChatbotWithDomain("memory-del-owner", `memory-del-owner-${Date.now()}.test`)
    const { chatbotId: otherBot, domain: otherDomain } = await createReadyChatbotWithDomain(
      "memory-del-other",
      `memory-del-other-${Date.now()}.test`,
    )
    const identity = await resolveCustomerIdentity(ownerBot, "cross-tenant-erase@example.test")
    const identifier = customerIdentifierFromEmail(ownerBot, identity.email!)
    await upsertCustomerFacts(ownerBot, identifier, [{ key: "city", value: "Lahore", confidence: 1 }])

    const res = await request(app)
      .post(`/public/chatbots/${otherBot}/memory/delete`)
      .set({ "X-Widget-Origin": `https://${otherDomain}`, Referer: `https://${otherDomain}/p` })
      // A validly signed proof for otherBot naming ownerBot's customer.
      .send({ proofToken: memoryProof(otherBot, identity.id, identity.email!) })

    // 404 rather than 403: a 403 would confirm the id exists, turning this
    // endpoint into an oracle for probing another tenant's customers.
    expect(res.status).toBe(404)
    expect(await listCustomerFacts(ownerBot, identifier)).toHaveLength(1)
  })

  it("rejects a request from a domain the chatbot does not allow", async () => {
    const { chatbotId } = await createReadyChatbotWithDomain("memory-origin", `memory-origin-${Date.now()}.test`)
    const identity = await resolveCustomerIdentity(chatbotId, "origin-check@example.test")

    const res = await request(app)
      .post(`/public/chatbots/${chatbotId}/memory/export`)
      .set({ "X-Widget-Origin": "https://not-allowed.example" })
      .send({ proofToken: memoryProof(chatbotId, identity.id, identity.email!) })

    expect(res.status).toBe(403)
  })

  it("deleting memory that does not exist is a no-op, not an error", async () => {
    const { chatbotId } = await createReadyChatbotWithDomain("memory-empty-delete", `memory-empty-delete-${Date.now()}.test`)
    const identifier = customerIdentifierFromEmail(chatbotId, "never-stored@example.test")

    expect(await deleteCustomerMemory(chatbotId, identifier)).toEqual({ summariesDeleted: 0, factsDeleted: 0 })
  })
})

describe("WP-3.4 privacy endpoints require proof of identity, not just a customer id", () => {
  async function setup(label: string) {
    const { chatbotId, domain } = await createReadyChatbotWithDomain(label, `${label}-${Date.now()}.test`)
    const identity = await resolveCustomerIdentity(chatbotId, `${label}@example.test`)
    const identifier = customerIdentifierFromEmail(chatbotId, identity.email!)
    await upsertCustomerFacts(chatbotId, identifier, [{ key: "city", value: "Lahore", confidence: 1 }])
    const headers = { "X-Widget-Origin": `https://${domain}`, Referer: `https://${domain}/p` }
    return { chatbotId, identity, identifier, headers }
  }

  it.each(["export", "delete"])("%s refuses a bare customerId (the old credential)", async (op) => {
    const { chatbotId, identity, identifier, headers } = await setup(`mem-bare-${op}`)
    const res = await request(app).post(`/public/chatbots/${chatbotId}/memory/${op}`).set(headers).send({ customerId: identity.id })
    expect(res.status).toBe(400)
    expect(await listCustomerFacts(chatbotId, identifier)).toHaveLength(1)
  })

  it.each(["export", "delete"])("%s refuses a forged or wrongly-scoped proof token", async (op) => {
    const { chatbotId, identity, identifier, headers } = await setup(`mem-forged-${op}`)
    const { chatbotId: elsewhere } = await createReadyChatbotWithDomain(`mem-elsewhere-${op}`, `mem-elsewhere-${op}-${Date.now()}.test`)
    const badTokens = [
      "not-a-jwt",
      memoryProof(elsewhere, identity.id, identity.email!), // issued for a different chatbot
      memoryProof(chatbotId, identity.id, identity.email!, "EMAIL_VERIFY"), // wrong purpose
    ]
    for (const proofToken of badTokens) {
      const res = await request(app).post(`/public/chatbots/${chatbotId}/memory/${op}`).set(headers).send({ proofToken })
      expect(res.status).toBe(401)
    }
    expect(await listCustomerFacts(chatbotId, identifier)).toHaveLength(1)
  })
})
