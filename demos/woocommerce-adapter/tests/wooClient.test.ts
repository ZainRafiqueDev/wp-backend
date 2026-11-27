import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createOrder, getProduct, listProducts, updateProductStock, WooApiError } from "../src/wooClient.js"

const CONFIG = { storeUrl: "https://shop.example.com", consumerKey: "ck_test", consumerSecret: "cs_test" }

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as Response
}

describe("wooClient", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("lists products from the real WooCommerce REST endpoint with Basic Auth", async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValueOnce(jsonResponse(200, [{ id: 1, name: "Wireless Mouse" }]))

    const products = await listProducts(CONFIG)
    expect(products).toEqual([{ id: 1, name: "Wireless Mouse" }])

    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe("https://shop.example.com/wp-json/wc/v3/products?per_page=50")
    const auth = (init?.headers as Record<string, string>).Authorization
    expect(auth).toBe(`Basic ${Buffer.from("ck_test:cs_test").toString("base64")}`)
  })

  it("gets a single product by id", async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 42, name: "Keyboard" }))

    const product = await getProduct(CONFIG, "42")
    expect(product.id).toBe(42)
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://shop.example.com/wp-json/wc/v3/products/42")
  })

  it("throws a WooApiError with the store's message on a non-2xx response", async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValue(jsonResponse(404, { message: "Invalid ID." }))

    await expect(getProduct(CONFIG, "999")).rejects.toMatchObject({ status: 404, message: "Invalid ID." })
    await expect(getProduct(CONFIG, "999")).rejects.toBeInstanceOf(WooApiError)
  })

  it("creates a real WooCommerce order with line_items built from productId/quantity", async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { id: 501, number: "501", status: "processing", currency: "USD", total: "24.99" }))

    const order = await createOrder(CONFIG, {
      productId: "1",
      quantity: 2,
      customerName: "Ada Lovelace",
      customerEmail: "ada@example.com",
    })

    expect(order.id).toBe(501)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe("https://shop.example.com/wp-json/wc/v3/orders")
    expect(init?.method).toBe("POST")
    const body = JSON.parse(String(init?.body))
    expect(body.line_items).toEqual([{ product_id: 1, quantity: 2 }])
    expect(body.billing).toEqual({ first_name: "Ada", last_name: "Lovelace", email: "ada@example.com", phone: "" })
  })

  it("updates a product's stock quantity via a real PUT request", async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 1, stock_quantity: 25, manage_stock: true }))

    const product = await updateProductStock(CONFIG, "1", 25)
    expect(product.stock_quantity).toBe(25)
    const [, init] = fetchMock.mock.calls[0]
    expect(init?.method).toBe("PUT")
    expect(JSON.parse(String(init?.body))).toEqual({ manage_stock: true, stock_quantity: 25 })
  })
})
