import { describe, expect, it } from "vitest"

import { PaymentConfirmationPolicy, WooCommerceStatusMapper } from "../../../src/lib/woocommerce/paymentPolicy.js"
import type { WooCommerceOrder } from "../../../src/lib/woocommerce/types.js"

function order(overrides: Partial<WooCommerceOrder> = {}): WooCommerceOrder {
  return {
    id: 1,
    number: "1",
    order_key: "wc_order_abc",
    status: "pending",
    currency: "USD",
    total: "10.00",
    date_paid: null,
    payment_method: "stripe",
    payment_method_title: "Credit card (Stripe)",
    line_items: [],
    ...overrides,
  }
}

describe("PaymentConfirmationPolicy", () => {
  it("confirms payment when date_paid is set, regardless of status", () => {
    const result = PaymentConfirmationPolicy(order({ status: "on-hold", date_paid: "2026-01-01T00:00:00" }))
    expect(result.paymentConfirmed).toBe(true)
    expect(result.reason).toContain("date_paid")
  })

  // CS-13 (B05-012 / B10-014): status alone is not proof of payment.
  it("does NOT confirm payment for a 'processing' order without date_paid (e.g. cash on delivery)", () => {
    const result = PaymentConfirmationPolicy(order({ status: "processing", payment_method: "cod", date_paid: null }))
    expect(result.paymentConfirmed).toBe(false)
  })

  it("does NOT confirm payment for a 'completed' order without date_paid", () => {
    const result = PaymentConfirmationPolicy(order({ status: "completed", date_paid: null }))
    expect(result.paymentConfirmed).toBe(false)
  })

  // CS-13 review: WooCommerce sets date_paid when ANY order enters
  // 'processing', including unpaid cash-on-delivery orders.
  it("does NOT confirm a 'processing' cash-on-delivery order even though WooCommerce set date_paid", () => {
    const result = PaymentConfirmationPolicy(order({ status: "processing", payment_method: "cod", date_paid: "2026-01-01T00:00:00" }))
    expect(result.paymentConfirmed).toBe(false)
  })

  it("does NOT confirm 'processing' bank-transfer or cheque orders with date_paid set", () => {
    for (const payment_method of ["bacs", "cheque"]) {
      expect(PaymentConfirmationPolicy(order({ status: "processing", payment_method, date_paid: "2026-01-01T00:00:00" })).paymentConfirmed).toBe(false)
    }
  })

  it("confirms a cash-on-delivery order once the merchant marks it 'completed'", () => {
    const result = PaymentConfirmationPolicy(order({ status: "completed", payment_method: "cod", date_paid: "2026-01-02T00:00:00" }))
    expect(result.paymentConfirmed).toBe(true)
  })

  it("confirms payment for a 'processing' order once date_paid is set", () => {
    const result = PaymentConfirmationPolicy(order({ status: "processing", date_paid: "2026-01-01T00:00:00" }))
    expect(result.paymentConfirmed).toBe(true)
  })

  it("does NOT confirm payment for a refunded/cancelled order even if date_paid is set", () => {
    for (const status of ["refunded", "cancelled", "failed", "trash"]) {
      expect(PaymentConfirmationPolicy(order({ status, date_paid: "2026-01-01T00:00:00" })).paymentConfirmed).toBe(false)
    }
  })

  it("does NOT confirm payment for 'on-hold' (commonly awaiting offline payment confirmation)", () => {
    const result = PaymentConfirmationPolicy(order({ status: "on-hold", date_paid: null }))
    expect(result.paymentConfirmed).toBe(false)
  })

  it("does NOT confirm payment for 'pending'", () => {
    const result = PaymentConfirmationPolicy(order({ status: "pending", date_paid: null }))
    expect(result.paymentConfirmed).toBe(false)
  })

  it("does NOT confirm payment for 'cancelled' or 'failed'", () => {
    expect(PaymentConfirmationPolicy(order({ status: "cancelled" })).paymentConfirmed).toBe(false)
    expect(PaymentConfirmationPolicy(order({ status: "failed" })).paymentConfirmed).toBe(false)
  })

  it("reports observedStatus and observedPaymentMethod for every decision", () => {
    const result = PaymentConfirmationPolicy(order({ status: "processing", payment_method_title: "Stripe" }))
    expect(result.observedStatus).toBe("processing")
    expect(result.observedPaymentMethod).toBe("Stripe")
  })
})

describe("WooCommerceStatusMapper", () => {
  it("maps a confirmed payment to PAID", () => {
    const o = order({ status: "processing", date_paid: "2026-01-01T00:00:00" })
    expect(WooCommerceStatusMapper(o, PaymentConfirmationPolicy(o))).toBe("PAID")
  })

  it("maps an unpaid cash-on-delivery 'processing' order to PENDING_PAYMENT", () => {
    const o = order({ status: "processing", payment_method: "cod", date_paid: null })
    expect(WooCommerceStatusMapper(o, PaymentConfirmationPolicy(o))).toBe("PENDING_PAYMENT")
  })

  it("maps an unconfirmed payment to PENDING_PAYMENT", () => {
    const o = order({ status: "on-hold" })
    expect(WooCommerceStatusMapper(o, PaymentConfirmationPolicy(o))).toBe("PENDING_PAYMENT")
  })

  it("maps 'refunded' to REFUNDED even if date_paid happens to be set", () => {
    const o = order({ status: "refunded", date_paid: "2026-01-01T00:00:00" })
    expect(WooCommerceStatusMapper(o, PaymentConfirmationPolicy(o))).toBe("REFUNDED")
  })

  it("maps 'cancelled'/'failed'/'trash' to CANCELLED", () => {
    for (const status of ["cancelled", "failed", "trash"]) {
      const o = order({ status })
      expect(WooCommerceStatusMapper(o, PaymentConfirmationPolicy(o))).toBe("CANCELLED")
    }
  })
})
