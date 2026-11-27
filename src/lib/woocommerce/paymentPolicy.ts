
import type { WooCommerceOrder } from "./types.js"

export interface PaymentConfirmationResult {
  paymentConfirmed: boolean
  reason: string
  observedStatus: string
  observedPaymentMethod: string
}


/** Woo statuses that never mean "money is held for this order", whatever date_paid says. */
const NOT_PAID_STATUSES = new Set(["cancelled", "failed", "refunded", "trash"])

/**
 * Offline gateways: money is collected outside WooCommerce (cash on
 * delivery, bank transfer, cheque). WooCommerce core still sets `date_paid`
 * as soon as such an order enters `processing` (which COD does at checkout,
 * and which a manual status change does too), so neither `date_paid` nor
 * `processing` proves payment for them. Only the merchant marking the order
 * `completed` does. Extend this list for other offline/manual gateways.
 *
 * Known consequence (accepted): a bank-transfer (`bacs`) or cheque order
 * stays PENDING_PAYMENT, with no booking number, until the merchant marks
 * it `completed` in WooCommerce, even after the money has arrived and the
 * merchant moved it to `processing`. Merchants using these gateways should
 * complete the order once payment is reconciled.
 */
export const OFFLINE_PAYMENT_GATEWAYS: ReadonlySet<string> = new Set(["cod", "bacs", "cheque"])

/**
 * CS-13 (B05-012 / B10-014): only WooCommerce's own payment-complete signal,
 * `date_paid`, confirms payment. A `processing` or `completed` status alone
 * does not: cash-on-delivery, bank-transfer and cheque gateways (and manual
 * admin edits) put an order in `processing` before any money is collected.
 */
export function PaymentConfirmationPolicy(order: WooCommerceOrder): PaymentConfirmationResult {
  const observedStatus = order.status
  const observedPaymentMethod = order.payment_method_title || order.payment_method || "unknown"

  if (NOT_PAID_STATUSES.has(observedStatus)) {
    return {
      paymentConfirmed: false,
      reason: `order status is '${observedStatus}' — never treated as paid, even if date_paid is set.`,
      observedStatus,
      observedPaymentMethod,
    }
  }

  if (OFFLINE_PAYMENT_GATEWAYS.has((order.payment_method || "").trim().toLowerCase())) {
    const completed = observedStatus === "completed"
    return {
      paymentConfirmed: completed,
      reason: completed
        ? `offline gateway '${order.payment_method}' and the merchant marked the order 'completed' — treated as paid.`
        : `offline gateway '${order.payment_method}' with status '${observedStatus}' — not treated as paid until the merchant marks it 'completed' (WooCommerce sets date_paid on entering 'processing' even when no money was collected).`,
      observedStatus,
      observedPaymentMethod,
    }
  }

  if (order.date_paid) {
    return {
      paymentConfirmed: true,
      reason: `order.date_paid is set (${order.date_paid}) — WooCommerce's own authoritative payment-complete signal, set by the gateway calling payment_complete().`,
      observedStatus,
      observedPaymentMethod,
    }
  }

  return {
    paymentConfirmed: false,
    reason: `order status is '${observedStatus}' with no date_paid set — not treated as paid (a 'processing'/'completed' status without date_paid can be an unpaid cash-on-delivery or offline-gateway order).`,
    observedStatus,
    observedPaymentMethod,
  }
}

export function WooCommerceStatusMapper(order: WooCommerceOrder, policy: PaymentConfirmationResult): string {
  if (order.status === "refunded") return "REFUNDED"
  if (order.status === "cancelled" || order.status === "failed" || order.status === "trash") return "CANCELLED"
  if (!policy.paymentConfirmed) return "PENDING_PAYMENT"
  return "PAID"
}
