import { createHmac, randomUUID } from "node:crypto"
import request from "supertest"
import { describe, expect, it, vi } from "vitest"

import { hasIntegrationEncryption, isCreditGrantingEnabled } from "../../src/env.js"
import { pool } from "../../src/lib/db.js"
import { encryptSecret } from "../../src/lib/crypto.js"
import { loadConversationContext } from "../../src/services/conversation.service.js"
import { issueWidgetSession } from "../../src/services/customerSession.service.js"
import { creditTopup } from "../../src/services/topup.service.js"
import { currentBillingPeriod } from "../../src/services/usage.service.js"
import { app } from "../helpers.js"
import { CHATBOT_SCOPED_ROUTES } from "../helpers/crossTenantRoutePack.js"
import { authed, seedOwnedChatbot } from "../helpers/seedTenant.js"

vi.mock("../../src/lib/commerceQueue.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/commerceQueue.js")>("../../src/lib/commerceQueue.js")
  return { ...actual, enqueueCommerceWebhookProcessing: vi.fn(async () => {}) }
})

// CS-17 (B09-001): public chat turns in this file used to reach a paid AI
// provider. Tenant isolation is decided before the completion, so a
// deterministic fake keeps every assertion meaningful.
vi.mock("../../src/lib/ai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/ai.js")>()
  const { fakeAnswerQuestion } = await import("../helpers/fakeAi.js")
  return { ...actual, answerQuestion: vi.fn(fakeAnswerQuestion), completeCheaply: vi.fn(async () => null) }
})

const CHILD_UUID = "00000000-0000-4000-8000-000000000001"
const WEBHOOK_SECRET_A = "whsec_tenant_a"
const WEBHOOK_SECRET_B = "whsec_tenant_b"

type Owner404Case = {
  method: "get" | "post" | "put" | "patch" | "delete"
  path: (chatbotId: string) => string
  body?: Record<string, unknown>
  attach?: boolean
  marker: string
}

const OWNER_404_CASES: Owner404Case[] = [
  { method: "get", path: (id) => `/chatbots/${id}`, marker: "CROSS_TENANT: GET /chatbots/:chatbotId" },
  {
    method: "post",
    path: (id) => `/chatbots/${id}/retry`,
    body: { websiteUrl: "https://example.com/" },
    marker: "CROSS_TENANT: POST /chatbots/:chatbotId/retry",
  },
  {
    method: "patch",
    path: (id) => `/chatbots/${id}/theme`,
    body: { theme: { primaryColor: "#769656", bgColor: "#ffffff", textColor: "#111111" } },
    marker: "CROSS_TENANT: PATCH /chatbots/:chatbotId/theme",
  },
  {
    method: "patch",
    path: (id) => `/chatbots/${id}/domain`,
    body: { domain: "https://attacker.example" },
    marker: "CROSS_TENANT: PATCH /chatbots/:chatbotId/domain",
  },
  {
    method: "patch",
    path: (id) => `/chatbots/${id}/fallback-message`,
    body: { fallbackMessage: "Hijacked fallback." },
    marker: "CROSS_TENANT: PATCH /chatbots/:chatbotId/fallback-message",
  },
  {
    method: "patch",
    path: (id) => `/chatbots/${id}/preferred-model`,
    body: { preferredModel: "openai" },
    marker: "CROSS_TENANT: PATCH /chatbots/:chatbotId/preferred-model",
  },
  { method: "get", path: (id) => `/chatbots/${id}/usage`, marker: "CROSS_TENANT: GET /chatbots/:chatbotId/usage" },
  { method: "get", path: (id) => `/chatbots/${id}/analytics`, marker: "CROSS_TENANT: GET /chatbots/:chatbotId/analytics" },
  {
    method: "post",
    path: (id) => `/chatbots/${id}/chat`,
    body: { question: "What is the refund policy?", history: [] },
    marker: "CROSS_TENANT: POST /chatbots/:chatbotId/chat",
  },
  { method: "get", path: (id) => `/chatbots/${id}/live-data`, marker: "CROSS_TENANT: GET /chatbots/:chatbotId/live-data" },
  {
    method: "post",
    path: (id) => `/chatbots/${id}/live-data`,
    body: { key: "hours", value: "9-5" },
    marker: "CROSS_TENANT: POST /chatbots/:chatbotId/live-data",
  },
  {
    method: "patch",
    path: (id) => `/chatbots/${id}/live-data/${CHILD_UUID}`,
    body: { value: "hijacked" },
    marker: "CROSS_TENANT: PATCH /chatbots/:chatbotId/live-data/:id",
  },
  {
    method: "delete",
    path: (id) => `/chatbots/${id}/live-data/${CHILD_UUID}`,
    marker: "CROSS_TENANT: DELETE /chatbots/:chatbotId/live-data/:id",
  },
  { method: "get", path: (id) => `/chatbots/${id}/integration`, marker: "CROSS_TENANT: GET /chatbots/:chatbotId/integration" },
  {
    method: "put",
    path: (id) => `/chatbots/${id}/integration`,
    body: { apiKey: "sk-attacker", apiBaseUrl: "https://attacker.example/api" },
    marker: "CROSS_TENANT: PUT /chatbots/:chatbotId/integration",
  },
  { method: "delete", path: (id) => `/chatbots/${id}/integration`, marker: "CROSS_TENANT: DELETE /chatbots/:chatbotId/integration" },
  { method: "get", path: (id) => `/chatbots/${id}/actions`, marker: "CROSS_TENANT: GET /chatbots/:chatbotId/actions" },
  {
    method: "post",
    path: (id) => `/chatbots/${id}/actions`,
    body: {
      name: "lookup_order",
      description: "Look up an order",
      httpMethod: "GET",
      urlTemplate: "https://attacker.example/orders/{id}",
    },
    marker: "CROSS_TENANT: POST /chatbots/:chatbotId/actions",
  },
  {
    method: "put",
    path: (id) => `/chatbots/${id}/actions/${CHILD_UUID}`,
    body: {
      name: "lookup_order",
      description: "Hijacked",
      httpMethod: "GET",
      urlTemplate: "https://attacker.example/orders/{id}",
    },
    marker: "CROSS_TENANT: PUT /chatbots/:chatbotId/actions/:id",
  },
  {
    method: "delete",
    path: (id) => `/chatbots/${id}/actions/${CHILD_UUID}`,
    marker: "CROSS_TENANT: DELETE /chatbots/:chatbotId/actions/:id",
  },
  { method: "get", path: (id) => `/chatbots/${id}/documents`, marker: "CROSS_TENANT: GET /chatbots/:chatbotId/documents" },
  {
    method: "get",
    path: (id) => `/chatbots/${id}/documents/${CHILD_UUID}/status`,
    marker: "CROSS_TENANT: GET /chatbots/:chatbotId/documents/:id/status",
  },
  {
    method: "post",
    path: (id) => `/chatbots/${id}/documents`,
    attach: true,
    marker: "CROSS_TENANT: POST /chatbots/:chatbotId/documents",
  },
  {
    method: "delete",
    path: (id) => `/chatbots/${id}/documents/${CHILD_UUID}`,
    marker: "CROSS_TENANT: DELETE /chatbots/:chatbotId/documents/:id",
  },
  {
    method: "post",
    path: (id) => `/chatbots/${id}/documents/${CHILD_UUID}/retry`,
    marker: "CROSS_TENANT: POST /chatbots/:chatbotId/documents/:id/retry",
  },
  { method: "get", path: (id) => `/chatbots/${id}/okf/overview`, marker: "CROSS_TENANT: GET /chatbots/:chatbotId/okf/overview" },
  { method: "get", path: (id) => `/chatbots/${id}/okf/index`, marker: "CROSS_TENANT: GET /chatbots/:chatbotId/okf/index" },
  { method: "get", path: (id) => `/chatbots/${id}/okf/export`, marker: "CROSS_TENANT: GET /chatbots/:chatbotId/okf/export" },
  { method: "get", path: (id) => `/chatbots/${id}/okf/concepts`, marker: "CROSS_TENANT: GET /chatbots/:chatbotId/okf/concepts" },
  {
    method: "post",
    path: (id) => `/chatbots/${id}/okf/concepts`,
    body: { type: "Policy", title: "Probe", bodyMd: "Probe body" },
    marker: "CROSS_TENANT: POST /chatbots/:chatbotId/okf/concepts",
  },
  {
    method: "get",
    path: (id) => `/chatbots/${id}/okf/concepts/${CHILD_UUID}`,
    marker: "CROSS_TENANT: GET /chatbots/:chatbotId/okf/concepts/:id",
  },
  {
    method: "put",
    path: (id) => `/chatbots/${id}/okf/concepts/${CHILD_UUID}`,
    body: { title: "Probe" },
    marker: "CROSS_TENANT: PUT /chatbots/:chatbotId/okf/concepts/:id",
  },
  {
    method: "post",
    path: (id) => `/chatbots/${id}/okf/concepts/${CHILD_UUID}/approve`,
    marker: "CROSS_TENANT: POST /chatbots/:chatbotId/okf/concepts/:id/approve",
  },
  {
    method: "delete",
    path: (id) => `/chatbots/${id}/okf/concepts/${CHILD_UUID}`,
    marker: "CROSS_TENANT: DELETE /chatbots/:chatbotId/okf/concepts/:id",
  },
  {
    method: "get",
    path: (id) => `/chatbots/${id}/okf/concepts/${CHILD_UUID}/audit`,
    marker: "CROSS_TENANT: GET /chatbots/:chatbotId/okf/concepts/:id/audit",
  },
  {
    method: "post",
    path: (id) => `/chatbots/${id}/okf/concepts/${CHILD_UUID}/restore`,
    body: { auditId: CHILD_UUID },
    marker: "CROSS_TENANT: POST /chatbots/:chatbotId/okf/concepts/:id/restore",
  },
  { method: "get", path: (id) => `/chatbots/${id}/woocommerce`, marker: "CROSS_TENANT: GET /chatbots/:chatbotId/woocommerce" },
  {
    method: "post",
    path: (id) => `/chatbots/${id}/woocommerce`,
    body: {
      storeUrl: "https://shop.example.com",
      consumerKey: "ck",
      consumerSecret: "cs",
      webhookSecret: "whsec",
    },
    marker: "CROSS_TENANT: POST /chatbots/:chatbotId/woocommerce",
  },
  { method: "delete", path: (id) => `/chatbots/${id}/woocommerce`, marker: "CROSS_TENANT: DELETE /chatbots/:chatbotId/woocommerce" },
  {
    method: "post",
    path: (id) => `/chatbots/${id}/woocommerce/sync`,
    marker: "CROSS_TENANT: POST /chatbots/:chatbotId/woocommerce/sync",
  },
  { method: "get", path: (id) => `/chatbots/${id}/bookly`, marker: "CROSS_TENANT: GET /chatbots/:chatbotId/bookly" },
  {
    method: "post",
    path: (id) => `/chatbots/${id}/bookly`,
    body: {
      baseUrl: "https://booking.example.com",
      resourceId: "res-1",
      apiKey: "bookly-key",
    },
    marker: "CROSS_TENANT: POST /chatbots/:chatbotId/bookly",
  },
  { method: "delete", path: (id) => `/chatbots/${id}/bookly`, marker: "CROSS_TENANT: DELETE /chatbots/:chatbotId/bookly" },
  {
    method: "get",
    path: (id) => `/chatbots/${id}/bookly/meeting-history`,
    marker: "CROSS_TENANT: GET /chatbots/:chatbotId/bookly/meeting-history",
  },
  {
    method: "get",
    path: (id) => `/chatbots/${id}/bookly-admin-audit-log`,
    marker: "CROSS_TENANT: GET /chatbots/:chatbotId/bookly-admin-audit-log",
  },
  {
    method: "post",
    path: (id) => `/billing/chatbots/${id}/topup`,
    body: { model: "openai" },
    marker: "CROSS_TENANT: POST /billing/chatbots/:chatbotId/topup",
  },
  { method: "get", path: (id) => `/chatbots/${id}/attachments`, marker: "CROSS_TENANT: GET /chatbots/:chatbotId/attachments" },
  {
    method: "get",
    path: (id) => `/chatbots/${id}/attachments/${CHILD_UUID}`,
    marker: "CROSS_TENANT: GET /chatbots/:chatbotId/attachments/:attachmentId",
  },
]

// CS-17 (B09-003): these checks used to fall back to "anything but 200" or
// return early when INTEGRATION_ENCRYPTION_KEY / credit grants were not
// configured, so the cross-tenant assertions silently never ran. The test
// env (vitest.config.ts) now always provides both; if it ever stops doing
// so, the suite fails here instead of passing without checking anything.
function requireSecurityTestPreconditions(): void {
  expect(hasIntegrationEncryption, "INTEGRATION_ENCRYPTION_KEY must be configured for cross-tenant tests").toBe(true)
  expect(isCreditGrantingEnabled(), "credit grants must be enabled for cross-tenant top-up tests").toBe(true)
}

function signWoo(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64")
}

async function seedWooWebhook(chatbotId: string, secret: string): Promise<void> {
  await pool!.query(
    `insert into chatbot_woocommerce_credentials
       (chatbot_id, store_url, consumer_key_encrypted, consumer_secret_encrypted, webhook_secret_encrypted)
     values ($1, 'https://shop.example.com', $2, $3, $4)`,
    [chatbotId, encryptSecret("ck"), encryptSecret("cs"), encryptSecret(secret)],
  )
}

describe("WP-1.7 cross-tenant negative pack", () => {
  it("covers every owner-404 catalog route in this file", () => {
    const markers = new Set(OWNER_404_CASES.map((item) => item.marker))
    const expected = CHATBOT_SCOPED_ROUTES.filter((route) => route.isolation === "owner-404").map((route) => route.coveringMarker)
    expect([...expected].sort()).toEqual([...markers].sort())
  })

  it("returns 404 (never the foreign row) when another tenant hits owner-scoped chatbot routes", async () => {
    requireSecurityTestPreconditions()
    const owner = await seedOwnedChatbot("xt-owner", "full_custom")
    const attacker = await seedOwnedChatbot("xt-attacker", "full_custom")

    for (const item of OWNER_404_CASES) {
      const url = item.path(owner.chatbotId)
      let req = request(app)[item.method](url).set(authed(attacker.token))
      if (item.attach) {
        req = req.attach("file", Buffer.from("cross tenant upload probe\n"), "probe.txt")
      } else if (item.body) {
        req = req.send(item.body)
      }
      const res = await req
      expect(res.status, item.marker).toBe(404)
      expect(JSON.stringify(res.body).toLowerCase(), item.marker).not.toContain(owner.chatbotId)
    }

    const ownerStatus = await request(app).get(`/chatbots/${owner.chatbotId}`).set(authed(owner.token))
    expect(ownerStatus.status).toBe(200)
    expect(ownerStatus.body.chatbot.id).toBe(owner.chatbotId)
  })

  it("eight concurrent document reads from another tenant all 404 and leave the owner listing intact", async () => {
    const owner = await seedOwnedChatbot("xt-docs-race-owner")
    const attacker = await seedOwnedChatbot("xt-docs-race-attacker")
    await pool!.query(
      `insert into chatbot_documents (chatbot_id, file_name, file_type, file_size, status, chunk_count)
       values ($1, 'secret.txt', 'txt', 12, 'ready', 1)`,
      [owner.chatbotId],
    )

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        request(app).get(`/chatbots/${owner.chatbotId}/documents`).set(authed(attacker.token)),
      ),
    )
    expect(results.every((res) => res.status === 404)).toBe(true)

    const ownerList = await request(app).get(`/chatbots/${owner.chatbotId}/documents`).set(authed(owner.token))
    expect(ownerList.status).toBe(200)
    expect(ownerList.body.documents).toHaveLength(1)
  })

  it("never lists or deletes another tenant's documents", async () => {
    const owner = await seedOwnedChatbot("xt-docs-owner")
    const attacker = await seedOwnedChatbot("xt-docs-attacker")
    const doc = await pool!.query<{ id: string }>(
      `insert into chatbot_documents (chatbot_id, file_name, file_type, file_size, status, chunk_count)
       values ($1, 'secret.txt', 'txt', 12, 'ready', 1) returning id`,
      [owner.chatbotId],
    )

    const list = await request(app).get(`/chatbots/${owner.chatbotId}/documents`).set(authed(attacker.token))
    expect(list.status).toBe(404)

    const remove = await request(app)
      .delete(`/chatbots/${owner.chatbotId}/documents/${doc.rows[0].id}`)
      .set(authed(attacker.token))
    expect(remove.status).toBe(404)

    const retry = await request(app)
      .post(`/chatbots/${owner.chatbotId}/documents/${doc.rows[0].id}/retry`)
      .set(authed(attacker.token))
    expect(retry.status).toBe(404)

    const stillThere = await pool!.query("select id from chatbot_documents where id = $1", [doc.rows[0].id])
    expect(stillThere.rows).toHaveLength(1)
  })

  it("does not let one tenant read another tenant's conversations via analytics or usage", async () => {
    const owner = await seedOwnedChatbot("xt-conv-owner")
    const attacker = await seedOwnedChatbot("xt-conv-attacker")
    await pool!.query(`insert into conversations (chatbot_id, session_id) values ($1, $2)`, [
      owner.chatbotId,
      `secret-${randomUUID()}`,
    ])
    await pool!.query(
      `insert into chatbot_usage (chatbot_id, billing_period, model, input_tokens, output_tokens, estimated_cost)
       values ($1, $2, 'openai', 999, 999, 9.99)`,
      [owner.chatbotId, currentBillingPeriod()],
    )

    const analytics = await request(app).get(`/chatbots/${owner.chatbotId}/analytics`).set(authed(attacker.token))
    expect(analytics.status).toBe(404)

    const usage = await request(app).get(`/chatbots/${owner.chatbotId}/usage`).set(authed(attacker.token))
    expect(usage.status).toBe(404)

    const ownerAnalytics = await request(app).get(`/chatbots/${owner.chatbotId}/analytics`).set(authed(owner.token))
    expect(ownerAnalytics.status).toBe(200)
    expect(ownerAnalytics.body.analytics.totalConversations).toBe(1)
    expect(ownerAnalytics.body.analytics.tokensConsumed).toBe(1998)
  })

  it("loadConversationContext for chatbot A never returns chatbot B messages, even with the same session id", async () => {
    const a = await seedOwnedChatbot("xt-session-a")
    const b = await seedOwnedChatbot("xt-session-b")
    const sharedSession = `shared-${randomUUID()}`

    const contextB = await loadConversationContext(b.chatbotId, sharedSession)
    await pool!.query(`insert into messages (conversation_id, role, content) values ($1, 'user', $2)`, [
      contextB.conversationId,
      "tenant B secret question about pricing",
    ])

    const contextA = await loadConversationContext(a.chatbotId, sharedSession)
    expect(contextA.conversationId).not.toBe(contextB.conversationId)
    expect(contextA.history.some((turn) => turn.content.includes("tenant B secret"))).toBe(false)

    const { rows } = await pool!.query<{ chatbot_id: string }>(
      "select chatbot_id from conversations where id = $1",
      [contextA.conversationId],
    )
    expect(rows[0].chatbot_id).toBe(a.chatbotId)
  })

  it("bookly admin chat on another tenant does not succeed or leak that tenant's data", async () => {
    // CROSS_TENANT: POST /chatbots/:chatbotId/bookly-admin-chat
    const owner = await seedOwnedChatbot("xt-bookly-owner", "full_custom")
    await request(app)
      .post(`/chatbots/${owner.chatbotId}/bookly-admin-chat`)
      .send({ message: "list resources", booklyAdminToken: "stolen-token" })
      .then((res) => {
        expect([401, 402, 403, 404]).toContain(res.status)
        expect(res.status).not.toBe(200)
        expect(JSON.stringify(res.body).toLowerCase()).not.toContain("secret")
      })
  })

  it("public widget config is scoped to the requested chatbot id only", async () => {
    // CROSS_TENANT: GET /public/chatbots/:chatbotId
    const a = await seedOwnedChatbot("xt-public-a")
    const b = await seedOwnedChatbot("xt-public-b")
    await pool!.query(`update chatbots set allowed_domain = $2, name = $3 where id = $1`, [
      a.chatbotId,
      "a.example",
      "Alpha Public Bot",
    ])
    await pool!.query(`update chatbots set allowed_domain = $2, name = $3 where id = $1`, [
      b.chatbotId,
      "b.example",
      "Beta Public Bot",
    ])

    const resA = await request(app).get(`/public/chatbots/${a.chatbotId}`).set("X-Widget-Origin", "https://a.example")
    const resB = await request(app).get(`/public/chatbots/${b.chatbotId}`).set("X-Widget-Origin", "https://b.example")
    expect(resA.status).toBe(200)
    expect(resB.status).toBe(200)
    expect(JSON.stringify(resA.body)).toContain("Alpha Public Bot")
    expect(JSON.stringify(resA.body)).not.toContain("Beta Public Bot")
    expect(JSON.stringify(resB.body)).toContain("Beta Public Bot")
    expect(JSON.stringify(resB.body)).not.toContain("Alpha Public Bot")
  })

  it("public chat for chatbot A does not create a conversation on chatbot B", async () => {
    // CROSS_TENANT: POST /public/chatbots/:chatbotId/chat
    const a = await seedOwnedChatbot("xt-public-chat-a")
    const b = await seedOwnedChatbot("xt-public-chat-b")
    await pool!.query(`update chatbots set allowed_domain = $2 where id = $1`, [a.chatbotId, "a.example"])

    const before = await pool!.query<{ count: string }>(
      "select count(*)::text as count from conversations where chatbot_id = $1",
      [b.chatbotId],
    )

    await request(app)
      .post(`/public/chatbots/${a.chatbotId}/chat`)
      .set("X-Widget-Origin", "https://a.example")
      .send({ message: "hello from widget", history: [], sessionId: `sess-${randomUUID()}` })

    const after = await pool!.query<{ count: string }>(
      "select count(*)::text as count from conversations where chatbot_id = $1",
      [b.chatbotId],
    )
    expect(Number(after.rows[0].count)).toBe(Number(before.rows[0].count))
  })

  it("a public attachment upload to chatbot A is never associated with chatbot B", async () => {
    // CROSS_TENANT: POST /public/chatbots/:chatbotId/attachments
    const a = await seedOwnedChatbot("xt-public-attach-a")
    const b = await seedOwnedChatbot("xt-public-attach-b")
    await pool!.query(`update chatbots set allowed_domain = $2 where id = $1`, [a.chatbotId, "a.example"])

    const before = await pool!.query<{ count: string }>(
      "select count(*)::text as count from chatbot_attachments where chatbot_id = $1",
      [b.chatbotId],
    )

    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([1, 2, 3])])
    const upload = await request(app)
      .post(`/public/chatbots/${a.chatbotId}/attachments`)
      .set("X-Widget-Origin", "https://a.example")
      // CS-04: uploads bind to a server-issued session token, not a client id.
      .field("sessionToken", issueWidgetSession(a.chatbotId).sessionToken)
      .attach("file", png, "photo.png")
    expect(upload.status).toBe(201)

    const after = await pool!.query<{ count: string }>(
      "select count(*)::text as count from chatbot_attachments where chatbot_id = $1",
      [b.chatbotId],
    )
    expect(Number(after.rows[0].count)).toBe(Number(before.rows[0].count))

    const bOwnerList = await request(app).get(`/chatbots/${b.chatbotId}/attachments`).set(authed(b.token))
    expect(bOwnerList.status).toBe(200)
    expect(JSON.stringify(bOwnerList.body)).not.toContain(upload.body.attachment.id)
  })

  it("a WooCommerce webhook signed for tenant A cannot write events onto tenant B", async () => {
    // CROSS_TENANT: POST /webhooks/woocommerce/:chatbotId
    requireSecurityTestPreconditions()
    const a = await seedOwnedChatbot("xt-woo-a", "full_custom")
    const b = await seedOwnedChatbot("xt-woo-b", "full_custom")
    await seedWooWebhook(a.chatbotId, WEBHOOK_SECRET_A)
    await seedWooWebhook(b.chatbotId, WEBHOOK_SECRET_B)

    const body = JSON.stringify({ id: 4242, status: "processing", date_modified: "2026-09-27T00:00:00" })
    const cross = await request(app)
      .post(`/webhooks/woocommerce/${b.chatbotId}`)
      .set("Content-Type", "application/json")
      .set("X-WC-Webhook-Signature", signWoo(body, WEBHOOK_SECRET_A))
      .set("X-WC-Webhook-Topic", "order.updated")
      .send(body)
    expect(cross.status).toBe(401)

    const ok = await request(app)
      .post(`/webhooks/woocommerce/${a.chatbotId}`)
      .set("Content-Type", "application/json")
      .set("X-WC-Webhook-Signature", signWoo(body, WEBHOOK_SECRET_A))
      .set("X-WC-Webhook-Topic", "order.updated")
      .send(body)
    expect(ok.status).toBe(200)

    const onA = await pool!.query("select id from commerce_webhook_events where chatbot_id = $1", [a.chatbotId])
    const onB = await pool!.query("select id from commerce_webhook_events where chatbot_id = $1", [b.chatbotId])
    expect(onA.rows).toHaveLength(1)
    expect(onB.rows).toHaveLength(0)
  })

  it("a Stripe top-up credit for chatbot A never lands on chatbot B", async () => {
    requireSecurityTestPreconditions()
    const a = await seedOwnedChatbot("xt-stripe-a")
    const b = await seedOwnedChatbot("xt-stripe-b")
    const period = currentBillingPeriod()
    const sessionId = `cs_xt_${randomUUID()}`

    await creditTopup(a.chatbotId, "openai", period, 4, sessionId, 10)

    const creditsA = await pool!.query(
      "select credited_usd from chatbot_model_credits where chatbot_id = $1 and stripe_checkout_session_id = $2",
      [a.chatbotId, sessionId],
    )
    const creditsB = await pool!.query("select credited_usd from chatbot_model_credits where chatbot_id = $1", [b.chatbotId])
    expect(creditsA.rows).toHaveLength(1)
    expect(Number(creditsA.rows[0].credited_usd)).toBe(4)
    expect(creditsB.rows).toHaveLength(0)

    await creditTopup(b.chatbotId, "openai", period, 4, sessionId, 10)
    const stillB = await pool!.query("select credited_usd from chatbot_model_credits where chatbot_id = $1", [b.chatbotId])
    expect(stillB.rows).toHaveLength(0)
  })
})
