import { describe, expect, it } from "vitest"

// Part B item 5 — the audit log carries the same tenant-scoping discipline
// as every other multi-tenant table in this project: one chatbot's admin
// actions must never be readable through another chatbot's id, even
// though both are real, valid Full Custom chatbots in the same database.
const { pool } = await import("../../src/lib/db.js")
const { recordAdminAction, listAdminAuditLogForChatbot } = await import("../../src/services/booklyAdminAudit.service.js")
const { signupUser } = await import("../helpers.js")

async function seedChatbot(label: string) {
  const db = pool!
  const { user } = await signupUser(label)
  const { rows } = await db.query("insert into chatbots (user_id, name, sources, theme, status) values ($1, 'bot', '[]', '{}', 'ready') returning id", [user.id])
  return rows[0].id as string
}

describe("Admin-chat audit log — shape and cross-tenant isolation (Part B item 5)", () => {
  it("records every required field, and never a credential-shaped field", async () => {
    const chatbotId = await seedChatbot("audit-shape")
    await recordAdminAction({
      chatbotId,
      adminId: "admin-shape-1",
      adminEmail: "admin@example.test",
      conversationId: "conv-1",
      requestId: "req-1",
      action: "admin_create_resource",
      targetResource: "resource-1",
      beforeState: null,
      afterState: { name: "Test Room" },
      success: true,
    })

    const rows = await listAdminAuditLogForChatbot(chatbotId)
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.chatbotId).toBe(chatbotId)
    expect(row.adminId).toBe("admin-shape-1")
    expect(row.adminEmail).toBe("admin@example.test")
    expect(row.conversationId).toBe("conv-1")
    expect(row.requestId).toBe("req-1")
    expect(row.action).toBe("admin_create_resource")
    expect(row.targetResource).toBe("resource-1")
    expect(row.afterState).toEqual({ name: "Test Room" })
    expect(row.success).toBe(true)
    expect(row.createdAt).toBeTruthy()

    // Never a credential-shaped field, in ANY field of the row — the
    // RecordAdminActionInput type has no such field to accidentally pass,
    // but this also guards against a future caller stuffing one into
    // beforeState/afterState.
    const serialized = JSON.stringify(row).toLowerCase()
    expect(serialized).not.toMatch(/"token"|"jwt"|"apikey"|"password"|"cookie"/)
  })

  it("records a failed action with its error message, never a raw payload", async () => {
    const chatbotId = await seedChatbot("audit-failure")
    await recordAdminAction({
      chatbotId,
      adminId: "admin-fail-1",
      adminEmail: "admin@example.test",
      conversationId: "conv-2",
      action: "admin_set_availability_rule",
      targetResource: "resource-2",
      success: false,
      errorMessage: "Bookly admin request failed (400)",
    })

    const rows = await listAdminAuditLogForChatbot(chatbotId)
    expect(rows[0].success).toBe(false)
    expect(rows[0].errorMessage).toBe("Bookly admin request failed (400)")
  })

  it("chatbot A's admin actions are never returned when listing chatbot B's audit log, even though both are real rows in the same table", async () => {
    const chatbotA = await seedChatbot("audit-tenant-a")
    const chatbotB = await seedChatbot("audit-tenant-b")

    await recordAdminAction({
      chatbotId: chatbotA,
      adminId: "admin-a",
      adminEmail: "a@example.test",
      conversationId: "conv-a",
      action: "admin_create_resource",
      targetResource: "resource-a",
      success: true,
    })
    await recordAdminAction({
      chatbotId: chatbotB,
      adminId: "admin-b",
      adminEmail: "b@example.test",
      conversationId: "conv-b",
      action: "admin_create_resource",
      targetResource: "resource-b",
      success: true,
    })

    const rowsForA = await listAdminAuditLogForChatbot(chatbotA)
    const rowsForB = await listAdminAuditLogForChatbot(chatbotB)

    expect(rowsForA).toHaveLength(1)
    expect(rowsForA[0].chatbotId).toBe(chatbotA)
    expect(rowsForA[0].adminId).toBe("admin-a")
    expect(rowsForA.some((r) => r.chatbotId === chatbotB)).toBe(false)

    expect(rowsForB).toHaveLength(1)
    expect(rowsForB[0].chatbotId).toBe(chatbotB)
    expect(rowsForB[0].adminId).toBe("admin-b")
    expect(rowsForB.some((r) => r.chatbotId === chatbotA)).toBe(false)
  })
})

// The real end-to-end "a genuine tool call writes an audit row" wiring is
// already exercised (and asserted via its own log output) by
// booklyAdminConfirmationBypass.integration.test.ts's second test — kept
// out of this file because vi.mock must be hoisted at module top level to
// reliably intercept adminConnector.js in ESM, which conflicts with this
// file's earlier tests using the REAL (unmocked) module.
