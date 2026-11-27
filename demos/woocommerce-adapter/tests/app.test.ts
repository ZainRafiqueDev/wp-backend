import { beforeEach, describe, expect, it, vi } from "vitest"
import request from "supertest"

vi.mock("../src/wooClient.js", async () => {
  const actual = await vi.importActual<typeof import("../src/wooClient.js")>("../src/wooClient.js")
  return {
    ...actual,
    listProducts: vi.fn(),
    getProduct: vi.fn(),
    createOrder: vi.fn(),
    updateProductStock: vi.fn(),
  }
})

const { createApp } = await import("../src/app.js")
const wooClient = await import("../src/wooClient.js")

const WOO_CONFIG = { storeUrl: "https://shop.example.com", consumerKey: "ck", consumerSecret: "cs" }

describe("woocommerce-adapter app", () => {
  beforeEach(() => {
    vi.mocked(wooClient.listProducts).mockReset()
    vi.mocked(wooClient.getProduct).mockReset()
    vi.mocked(wooClient.createOrder).mockReset()
    vi.mocked(wooClient.updateProductStock).mockReset()
  })

  it("GET /health never requires the inbound API key", async () => {
    const app = createApp({ apiKey: "secret", woo: WOO_CONFIG })
    const res = await request(app).get("/health")
    expect(res.status).toBe(200)
  })

  it("rejects an inbound request without the configured API key", async () => {
    const app = createApp({ apiKey: "secret", woo: WOO_CONFIG })
    const res = await request(app).get("/products")
    expect(res.status).toBe(401)
  })

  it("GET /products returns the contract's read shape, translated from real WooCommerce products", async () => {
    vi.mocked(wooClient.listProducts).mockResolvedValueOnce([
      { id: 1, name: "Wireless Mouse", price: "24.99", regular_price: "24.99", sku: "sku_1", stock_status: "instock", stock_quantity: 14, manage_stock: true },
    ])
    const app = createApp({ woo: WOO_CONFIG })
    const res = await request(app).get("/products")
    expect(res.status).toBe(200)
    expect(res.body).toEqual([{ id: "1", name: "Wireless Mouse", price: "24.99", sku: "sku_1", stock: 14, stockStatus: "instock" }])
  })

  it("GET /products/:id/availability translates a real WooCommerce product to the contract's availability shape", async () => {
    vi.mocked(wooClient.getProduct).mockResolvedValueOnce({
      id: 1,
      name: "Wireless Mouse",
      price: "24.99",
      regular_price: "24.99",
      sku: "sku_1",
      stock_status: "instock",
      stock_quantity: 14,
      manage_stock: true,
    })
    const app = createApp({ woo: WOO_CONFIG })
    const res = await request(app).get("/products/1/availability")
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ available: true, quantity: 14, stockStatus: "instock" })
  })

  it("GET /products/:id/availability 404s when WooCommerce has no such product", async () => {
    const { WooApiError } = await vi.importActual<typeof import("../src/wooClient.js")>("../src/wooClient.js")
    vi.mocked(wooClient.getProduct).mockRejectedValueOnce(new WooApiError(404, "Invalid ID."))
    const app = createApp({ woo: WOO_CONFIG })
    const res = await request(app).get("/products/999/availability")
    expect(res.status).toBe(404)
  })

  it("POST /orders — the write side implemented for the first time this pass — creates a real order and returns the contract's write shape", async () => {
    vi.mocked(wooClient.createOrder).mockResolvedValueOnce({ id: 501, number: "501", status: "processing", currency: "USD", total: "49.98" })
    const app = createApp({ woo: WOO_CONFIG })
    const res = await request(app)
      .post("/orders")
      .send({ productId: "1", quantity: 2, customer: { name: "Ada Lovelace", email: "ada@example.com" } })
    expect(res.status).toBe(201)
    expect(res.body).toEqual({ orderId: "501", status: "confirmed", confirmationDetails: "Order #501 (processing). Total: USD49.98." })
    expect(wooClient.createOrder).toHaveBeenCalledWith(WOO_CONFIG, {
      productId: "1",
      quantity: 2,
      customerName: "Ada Lovelace",
      customerEmail: "ada@example.com",
      customerPhone: null,
    })
  })

  it("POST /orders 400s a malformed request before ever calling WooCommerce", async () => {
    const app = createApp({ woo: WOO_CONFIG })
    const res = await request(app).post("/orders").send({ productId: "1" })
    expect(res.status).toBe(400)
    expect(wooClient.createOrder).not.toHaveBeenCalled()
  })

  it("PATCH /products/:id/inventory — the write side implemented for the first time this pass — updates real stock", async () => {
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
    const res = await request(app).patch("/products/1/inventory").send({ quantity: 25 })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ id: "1", stock: 25 })
    expect(wooClient.updateProductStock).toHaveBeenCalledWith(WOO_CONFIG, "1", 25)
  })

  it("PATCH /products/:id/inventory 400s a negative quantity before calling WooCommerce", async () => {
    const app = createApp({ woo: WOO_CONFIG })
    const res = await request(app).patch("/products/1/inventory").send({ quantity: -1 })
    expect(res.status).toBe(400)
    expect(wooClient.updateProductStock).not.toHaveBeenCalled()
  })

  it("PATCH /products/:id/inventory accepts quantity as a numeric string, the shape a real Custom Action template call actually sends", async () => {
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
    const res = await request(app).patch("/products/1/inventory").send({ quantity: "25" })
    expect(res.status).toBe(200)
    expect(wooClient.updateProductStock).toHaveBeenCalledWith(WOO_CONFIG, "1", 25)
  })
})
