import { randomUUID } from "node:crypto"
import { describe, expect, it, vi } from "vitest"

// A multi-resource chatbot's resource-ownership boundary — a customer
// booking against ONE named resource must never be able to touch a
// DIFFERENT resource, even a real one configured for the SAME chatbot,
// by supplying its id directly (adversarial-prompting scenario, same
// discipline as booklyToolAuthorization's cross-tenant tests).
vi.mock("../../src/lib/bookly/connector.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/bookly/connector.js")>("../../src/lib/bookly/connector.js")
  return { ...actual, getAvailableSlots: vi.fn().mockResolvedValue([]) }
})

const { pool } = await import("../../src/lib/db.js")
const { encryptSecret } = await import("../../src/lib/crypto.js")
const { authorizeToolCall } = await import("../../src/services/toolAuthorization.service.js")
const { addBooklyResource, listBooklyResourceOptions } = await import("../../src/services/booklyCredentials.service.js")
const booklyConnector = await import("../../src/lib/bookly/connector.js")
const { signupUser } = await import("../helpers.js")

async function seedFullCustomBooklyChatbot(label: string) {
  const db = pool!
  const signup = await signupUser(label)
  await db.query(`insert into subscriptions (user_id, stripe_customer_id, plan, status) values ($1, $2, 'full_custom', 'active')`, [signup.user.id, `cus_${randomUUID()}`])
  const { rows: chatbotRows } = await db.query("insert into chatbots (user_id, name, sources, theme, status) values ($1, 'bot', '[]', '{}', 'ready') returning id", [signup.user.id])
  const chatbotId = chatbotRows[0].id as string
  const primaryResourceId = `resource-${randomUUID()}`
  await db.query(
    `insert into chatbot_bookly_credentials (chatbot_id, base_url, resource_id, resource_label, api_key_encrypted) values ($1, 'https://bookly.example.com', $2, 'Alice', $3)`,
    [chatbotId, primaryResourceId, encryptSecret("test-bookly-api-key")],
  )
  return { chatbotId, primaryResourceId, accessToken: signup.session.access_token as string }
}

describe("Multi-resource Bookly chatbots — staff selection and cross-resource isolation", () => {
  it("a single-resource chatbot returns exactly its one option, unchanged from before multi-resource support existed", async () => {
    const { chatbotId, primaryResourceId } = await seedFullCustomBooklyChatbot("multi-resource-single")
    const options = await listBooklyResourceOptions(chatbotId)
    expect(options).toEqual([{ resourceId: primaryResourceId, resourceLabel: "Alice" }])
  })

  it("addBooklyResource validates against the real Bookly connection and, once added, both resources are listed", async () => {
    vi.mocked(booklyConnector.getAvailableSlots).mockReset()
    vi.mocked(booklyConnector.getAvailableSlots).mockResolvedValueOnce([]) // the new resource's own validation call

    const { chatbotId, accessToken } = await seedFullCustomBooklyChatbot("multi-resource-add")
    const bobResourceId = `resource-${randomUUID()}`
    const options = await addBooklyResource(accessToken, chatbotId, { resourceId: bobResourceId, resourceLabel: "Bob" })

    expect(options.map((o) => o.resourceLabel).sort()).toEqual(["Alice", "Bob"])
  })

  it("addBooklyResource rejects a resource id that doesn't actually exist on the connected Bookly server (validated at settings-save time)", async () => {
    vi.mocked(booklyConnector.getAvailableSlots).mockReset()
    vi.mocked(booklyConnector.getAvailableSlots).mockRejectedValueOnce(
      Object.assign(new booklyConnector.BooklyApiError(404, "not found"), {}),
    )

    const { chatbotId, accessToken } = await seedFullCustomBooklyChatbot("multi-resource-invalid")
    await expect(addBooklyResource(accessToken, chatbotId, { resourceId: "does-not-exist", resourceLabel: "Ghost" })).rejects.toThrow(/no bookly resource was found/i)
  })

  it("a tool call naming a resource NOT configured for this chatbot is rejected, even though it's a real resource id on a DIFFERENT chatbot's configuration", async () => {
    const chatbotA = await seedFullCustomBooklyChatbot("multi-resource-tenant-a")
    const chatbotB = await seedFullCustomBooklyChatbot("multi-resource-tenant-b")

    await expect(
      authorizeToolCall({ chatbotId: chatbotA.chatbotId, customerId: null, operation: "check_availability", resource: { type: "bookly_resource", id: chatbotB.primaryResourceId } }),
    ).rejects.toThrow(/not found/i)

    // The chatbot's OWN resource is fine.
    await expect(
      authorizeToolCall({ chatbotId: chatbotA.chatbotId, customerId: null, operation: "check_availability", resource: { type: "bookly_resource", id: chatbotA.primaryResourceId } }),
    ).resolves.toBeUndefined()
  })
})
