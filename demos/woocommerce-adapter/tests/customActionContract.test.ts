// Proves that custom-actions.ts's two write-action definitions (the exact
// objects a chatbot owner POSTs to /chatbots/:chatbotId/actions on their
// real ChatMate360 account) produce requests this adapter actually accepts
// — same intent as the booking-api demo's file of the same name.
import { beforeEach, describe, expect, it, vi } from "vitest"
import request from "supertest"

vi.mock("../src/wooClient.js", async () => {
  const actual = await vi.importActual<typeof import("../src/wooClient.js")>("../src/wooClient.js")
  return { ...actual, createOrder: vi.fn(), updateProductStock: vi.fn() }
})

const { createApp } = await import("../src/app.js")
const wooClient = await import("../src/wooClient.js")
const { CREATE_ORDER_ACTION, UPDATE_INVENTORY_ACTION } = await import("../custom-actions.js")

const WOO_CONFIG = { storeUrl: "https://shop.example.com", consumerKey: "ck", consumerSecret: "cs" }

function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (match, key: string) =>
    values[key] === undefined ? match : values[key],
  )
}

describe("Custom Action definitions match the real adapter contract", () => {
  beforeEach(() => {
    vi.mocked(wooClient.createOrder).mockReset()
    vi.mocked(wooClient.updateProductStock).mockReset()
  })

  it("create_order's bodyTemplate resolves to a real, working POST request", async () => {
    vi.mocked(wooClient.createOrder).mockResolvedValueOnce({ id: 501, number: "501", status: "processing", currency: "USD", total: "49.98" })
    const app = createApp({ woo: WOO_CONFIG })

    const values = { product_id: "1", quantity: "2", customer_name: "Ada Lovelace", customer_email: "ada@example.com" }
    expect(CREATE_ORDER_ACTION.httpMethod).toBe("POST")
    const url = new URL(`https://example.invalid${CREATE_ORDER_ACTION.urlTemplate}`)
    const body = JSON.parse(fillTemplate(JSON.stringify(CREATE_ORDER_ACTION.bodyTemplate), values))

    const res = await request(app).post(url.pathname).send(body)
    expect(res.status).toBe(201)
    expect(wooClient.createOrder).toHaveBeenCalledWith(WOO_CONFIG, {
      productId: "1",
      quantity: 2,
      customerName: "Ada Lovelace",
      customerEmail: "ada@example.com",
      customerPhone: null,
    })
  })

  it("update_inventory's urlTemplate + bodyTemplate resolve to a real, working PATCH request", async () => {
    vi.mocked(wooClient.updateProductStock).mockResolvedValueOnce({
      id: 1,
      name: "Wireless Mouse",
      price: "24.99",
      regular_price: "24.99",
      sku: "sku_1",
      stock_status: "instock",
      stock_quantity: 25,
      manage_stock: true,
    })
    const app = createApp({ woo: WOO_CONFIG })

    const values = { product_id: "1", quantity: "25" }
    expect(UPDATE_INVENTORY_ACTION.httpMethod).toBe("PATCH")
    const url = new URL(fillTemplate(`https://example.invalid${UPDATE_INVENTORY_ACTION.urlTemplate}`, values))
    const body = JSON.parse(fillTemplate(JSON.stringify(UPDATE_INVENTORY_ACTION.bodyTemplate), values))

    const res = await request(app).patch(url.pathname).send(body)
    expect(res.status).toBe(200)
    expect(wooClient.updateProductStock).toHaveBeenCalledWith(WOO_CONFIG, "1", 25)
  })

  it("every {{placeholder}} in both actions has a matching declared parameter", () => {
    for (const action of [CREATE_ORDER_ACTION, UPDATE_INVENTORY_ACTION]) {
      const declared = new Set(action.parameters.map((p) => p.name))
      const haystack = action.urlTemplate + JSON.stringify(action.bodyTemplate)
      const placeholders = Array.from(haystack.matchAll(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g)).map((m) => m[1])
      for (const name of placeholders) {
        expect(declared.has(name)).toBe(true)
      }
    }
  })
})
