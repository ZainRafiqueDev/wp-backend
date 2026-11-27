import { describe, expect, it, vi } from "vitest"

vi.mock("../../src/lib/ai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/ai.js")>()
  return {
    ...actual,
    completeCheaply: vi.fn(async () =>
      JSON.stringify({
        concepts: [
          {
            type: "Policy",
            title: "Extracted Refund Policy",
            description: "Refund window from the uploaded document",
            tags: ["refund"],
            body_md: "Refunds are accepted within 14 days of purchase.",
          },
        ],
      }),
    ),
  }
})

import { pool } from "../../src/lib/db.js"
import { formatOKFAnswer } from "../../src/lib/okf.js"
import { runWithTenantContext } from "../../src/lib/tenantContext.js"
import { approveConcept, createConcept, deactivateConcept } from "../../src/services/okf.service.js"
import { routeQuery } from "../../src/services/okfRouter.service.js"
import { authed, seedOwnedChatbot } from "../helpers/seedTenant.js"
import { app } from "../helpers.js"
import request from "supertest"

describe("WP-5 OKF router and isolation", () => {
  it("matches an approved concept by title and returns the body verbatim", async () => {
    if (!pool) throw new Error("pool required")
    const tenant = await seedOwnedChatbot("okf-title")
    const body = "Customers have **14 days** from purchase to request a full refund."
    const created = await createConcept(tenant.token, tenant.chatbotId, {
      type: "Policy",
      title: "Refund Window",
      bodyMd: body,
      resourceUrl: "https://store.example/refund",
    })
    await expect(
      request(app)
        .post(`/chatbots/${tenant.chatbotId}/okf/concepts/${created.id}/approve`)
        .send({})
        .set(authed(tenant.token)),
    ).resolves.toMatchObject({ status: 200 })

    const routed = await runWithTenantContext({ scope: "worker", chatbotId: tenant.chatbotId }, () =>
      routeQuery(tenant.chatbotId, "Refund Window"),
    )
    expect(routed.matched).toBe(true)
    expect(routed.routingMethod).toBe("exact_title")
    expect(routed.answer).toBe(formatOKFAnswer({ title: "Refund Window", bodyMd: body, resourceUrl: "https://store.example/refund" }, "Refund Window"))
    expect(routed.answer).toContain(body)
  })

  it("does not route a concept with approved_at NULL", async () => {
    if (!pool) throw new Error("pool required")
    const tenant = await seedOwnedChatbot("okf-pending")
    await createConcept(tenant.token, tenant.chatbotId, {
      type: "Policy",
      title: "Secret Pending Policy",
      bodyMd: "This must never reach customers.",
    })
    const routed = await runWithTenantContext({ scope: "worker", chatbotId: tenant.chatbotId }, () =>
      routeQuery(tenant.chatbotId, "Secret Pending Policy"),
    )
    expect(routed.matched).toBe(false)
  })

  it("does not route a deactivated concept", async () => {
    if (!pool) throw new Error("pool required")
    const tenant = await seedOwnedChatbot("okf-off")
    const created = await createConcept(tenant.token, tenant.chatbotId, {
      type: "Policy",
      title: "Retired Hours",
      bodyMd: "We used to be open 24 hours.",
    })
    await approveConcept(tenant.token, tenant.chatbotId, created.id)
    await deactivateConcept(tenant.token, tenant.chatbotId, created.id)
    const routed = await runWithTenantContext({ scope: "worker", chatbotId: tenant.chatbotId }, () =>
      routeQuery(tenant.chatbotId, "Retired Hours"),
    )
    expect(routed.matched).toBe(false)
  })

  it("does not return tenant A's concept for tenant B", async () => {
    if (!pool) throw new Error("pool required")
    const a = await seedOwnedChatbot("okf-iso-a")
    const b = await seedOwnedChatbot("okf-iso-b")
    const created = await createConcept(a.token, a.chatbotId, {
      type: "Policy",
      title: "Tenant A Only Policy",
      bodyMd: "A's refund is 14 days.",
    })
    await approveConcept(a.token, a.chatbotId, created.id)

    const asB = await request(app).get(`/chatbots/${a.chatbotId}/okf/concepts/${created.id}`).set(authed(b.token))
    expect(asB.status).toBe(404)

    const routed = await runWithTenantContext({ scope: "worker", chatbotId: b.chatbotId }, () =>
      routeQuery(b.chatbotId, "Tenant A Only Policy"),
    )
    expect(routed.matched).toBe(false)
  })

  it("rejects an empty body_md on create", async () => {
    if (!pool) throw new Error("pool required")
    const tenant = await seedOwnedChatbot("okf-empty")
    const created = await request(app)
      .post(`/chatbots/${tenant.chatbotId}/okf/concepts`)
      .set(authed(tenant.token))
      .send({ type: "FAQ", title: "Empty", bodyMd: "" })
    expect(created.status).toBe(400)
  })

  it("creates AI suggestions as pending, never live", async () => {
    if (!pool) throw new Error("pool required")
    const tenant = await seedOwnedChatbot("okf-suggest")
    const doc = await pool.query<{ id: string }>(
      `insert into chatbot_documents (chatbot_id, file_name, file_type, file_size, status, chunk_count)
       values ($1, 'policy.pdf', 'pdf', 12, 'ready', 1) returning id`,
      [tenant.chatbotId],
    )
    await pool.query(
      `insert into chatbot_document_chunks (document_id, chatbot_id, content)
       values ($1, $2, $3)`,
      [doc.rows[0].id, tenant.chatbotId, "Our refund policy: customers have 14 days to request a refund."],
    )
    const { suggestOKFConcepts } = await import("../../src/services/okfSuggestion.service.js")
    const count = await runWithTenantContext({ scope: "worker", chatbotId: tenant.chatbotId }, () =>
      suggestOKFConcepts(doc.rows[0].id, tenant.chatbotId),
    )
    expect(count).toBeGreaterThan(0)
    const { rows } = await pool.query<{ approved_at: Date | null; created_by: string }>(
      `select approved_at, created_by from okf_concepts where chatbot_id = $1`,
      [tenant.chatbotId],
    )
    expect(rows[0].approved_at).toBeNull()
    expect(rows[0].created_by).toBe("ai_extracted")
    const routed = await runWithTenantContext({ scope: "worker", chatbotId: tenant.chatbotId }, () =>
      routeQuery(tenant.chatbotId, "Extracted Refund Policy"),
    )
    expect(routed.matched).toBe(false)
  })
})
