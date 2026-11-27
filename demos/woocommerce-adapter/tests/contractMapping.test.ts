import { describe, expect, it } from "vitest"

import { contractOrderRequestToWooInput, orderToContract, productToAvailability, productToContract } from "../src/contractMapping.js"
import type { WooOrder, WooProduct } from "../src/wooClient.js"

function wooProduct(overrides: Partial<WooProduct> = {}): WooProduct {
  return {
    id: 1,
    name: "Wireless Mouse",
    price: "24.99",
    regular_price: "24.99",
    sku: "sku_123",
    stock_status: "instock",
    stock_quantity: 14,
    manage_stock: true,
    ...overrides,
  }
}

describe("productToContract", () => {
  it("matches the contract's documented read shape", () => {
    expect(productToContract(wooProduct())).toMatchObject({ id: "1", name: "Wireless Mouse", price: "24.99", stock: 14 })
  })

  it("reports stock as null (not 0) when the store doesn't manage stock for this product", () => {
    const product = wooProduct({ manage_stock: false, stock_quantity: null })
    expect(productToContract(product).stock).toBeNull()
  })
})

describe("productToAvailability", () => {
  it("is available and quantified for a stock-managed, in-stock product", () => {
    expect(productToAvailability(wooProduct())).toEqual({ available: true, quantity: 14, stockStatus: "instock" })
  })

  it("is unavailable for an out-of-stock product", () => {
    const product = wooProduct({ stock_status: "outofstock", stock_quantity: 0 })
    expect(productToAvailability(product).available).toBe(false)
  })

  it("is available but with a null quantity for a non-stock-managed product (WooCommerce never reports a count)", () => {
    const product = wooProduct({ manage_stock: false, stock_quantity: null })
    expect(productToAvailability(product)).toEqual({ available: true, quantity: null, stockStatus: "instock" })
  })
})

describe("orderToContract", () => {
  it("maps a processing WooCommerce order to a confirmed contract order", () => {
    const order: WooOrder = { id: 501, number: "501", status: "processing", currency: "USD", total: "24.99" }
    expect(orderToContract(order)).toEqual({
      orderId: "501",
      status: "confirmed",
      confirmationDetails: "Order #501 (processing). Total: USD24.99.",
    })
  })

  it("maps a cancelled WooCommerce order to a failed contract order", () => {
    const order: WooOrder = { id: 502, number: "502", status: "cancelled", currency: "USD", total: "0.00" }
    expect(orderToContract(order).status).toBe("failed")
  })
})

describe("contractOrderRequestToWooInput", () => {
  it("accepts a well-formed contract order request", () => {
    const result = contractOrderRequestToWooInput({
      productId: "1",
      quantity: 2,
      customer: { name: "Ada Lovelace", email: "ada@example.com", phone: "555-1234" },
    })
    expect(result).toEqual({ productId: "1", quantity: 2, customerName: "Ada Lovelace", customerEmail: "ada@example.com", customerPhone: "555-1234" })
  })

  it("rejects a request missing required fields", () => {
    expect(contractOrderRequestToWooInput({ productId: "1", quantity: 2 })).toBeNull()
    expect(contractOrderRequestToWooInput({ quantity: 2, customer: { name: "A", email: "a@b.com" } })).toBeNull()
    expect(contractOrderRequestToWooInput({ productId: "1", quantity: 0, customer: { name: "A", email: "a@b.com" } })).toBeNull()
  })

  it("accepts quantity as a numeric string, the shape a real Custom Action template call actually sends", () => {
    const result = contractOrderRequestToWooInput({
      productId: "1",
      quantity: "2",
      customer: { name: "Ada Lovelace", email: "ada@example.com" },
    })
    expect(result?.quantity).toBe(2)
  })
})
