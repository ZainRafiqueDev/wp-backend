import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Same DNS mock pattern as tests/unit/actionExecutor.test.ts — assertSafeUrl
// does a real DNS lookup for any non-IP-literal hostname; mocked to a
// public address so these tests never depend on this sandbox having real
// DNS/network access.
vi.mock("node:dns/promises", () => ({
  default: { lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) },
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}))

const { getProduct, createOrder, getOrderStatus, buildOrderPayUrl, WooCommerceApiError } = await import("../../../src/lib/woocommerce/connector.js")

const CREDS = { storeUrl: "https://shop.example.com", consumerKey: "ck_test", consumerSecret: "cs_test" }

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) } as Response
}

describe("WooCommerce connector — precisely /wc/v3/, not the generic WordPress REST API", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("calls /wp-json/wc/v3/products/:id with Basic Auth", async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 1, name: "Widget" }))
    await getProduct(CREDS, 1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe("https://shop.example.com/wp-json/wc/v3/products/1")
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from("ck_test:cs_test").toString("base64")}`)
  })

  it("throws WooCommerceApiError with the store's real status/message on a non-2xx response", async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { message: "Invalid ID." }))
    await expect(getProduct(CREDS, 999)).rejects.toBeInstanceOf(WooCommerceApiError)
  })

  it("createOrder posts a real /wc/v3/orders request with line_items and billing", async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { id: 501, number: "501", order_key: "wc_order_abc", status: "pending", currency: "USD", total: "20.00", date_paid: null, payment_method: "chatmate360", payment_method_title: "ChatMate360", line_items: [] }))
    const order = await createOrder(CREDS, { lineItems: [{ productId: 1, quantity: 2 }], customer: { firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" } })
    expect(order.id).toBe(501)
    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(String(init?.body))
    expect(body.line_items).toEqual([{ product_id: 1, quantity: 2 }])
    expect(body.billing.email).toBe("ada@example.com")
  })

  it("getOrderStatus fetches the real, current order — the only source PaymentConfirmationPolicy is ever run against", async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 501, number: "501", order_key: "k", status: "processing", currency: "USD", total: "20.00", date_paid: "2026-01-01", payment_method: "x", payment_method_title: "x", line_items: [] }))
    const order = await getOrderStatus(CREDS, 501)
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://shop.example.com/wp-json/wc/v3/orders/501")
    expect(order.status).toBe("processing")
  })

  it("buildOrderPayUrl uses WooCommerce's own real order_key, never a fabricated value", () => {
    const url = buildOrderPayUrl("https://shop.example.com", { id: 501, order_key: "wc_order_abc123", number: "501", status: "pending", currency: "USD", total: "0", date_paid: null, payment_method: "x", payment_method_title: "x", line_items: [] })
    expect(url).toBe("https://shop.example.com/checkout/order-pay/501/?pay_for_order=true&key=wc_order_abc123")
  })

  it("buildOrderPayUrl refuses to fabricate a URL when order_key is missing (treated as a config error, not guessed)", () => {
    expect(() =>
      buildOrderPayUrl("https://shop.example.com", { id: 501, order_key: "", number: "501", status: "pending", currency: "USD", total: "0", date_paid: null, payment_method: "x", payment_method_title: "x", line_items: [] }),
    ).toThrow(/order_key/)
  })

  it("blocks a private-IP store URL the same way the crawler's SSRF check does", async () => {
    const fetchMock = vi.mocked(fetch)
    await expect(getProduct({ ...CREDS, storeUrl: "http://127.0.0.1:8080" }, 1)).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
