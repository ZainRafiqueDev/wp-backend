
import { getOrderStatus } from "../lib/woocommerce/connector.js"
import { PaymentConfirmationPolicy } from "../lib/woocommerce/paymentPolicy.js"
import { generateBookingNumberCandidate } from "../lib/woocommerce/bookingNumber.js"
import { pool } from "../lib/db.js"
import { AppError } from "../lib/errors.js"
import { log } from "../lib/logger.js"
import { getDecryptedWooCommerceCredentials } from "./commerceCredentials.service.js"
import { promoteVerificationLevel } from "./customerIdentity.service.js"
import { createPaymentConfirmedNotification } from "./commerceNotification.service.js"

export type OrderStatus = "DRAFT" | "PENDING_PAYMENT" | "PAID" | "PROCESSING" | "SHIPPED" | "DELIVERED" | "CANCELLED" | "REFUNDED"
export type OperationalStatus = "PAYMENT_VERIFICATION_PENDING" | "PAYMENT_VERIFICATION_FAILED" | "SYNC_ERROR" | "INTEGRATION_ERROR" | null

export interface CommerceOrder {
  id: string
  chatbotId: string
  customerId: string
  woocommerceOrderId: string
  bookingNumber: string | null
  status: OrderStatus
  operationalStatus: OperationalStatus
  orderSnapshot: Record<string, unknown>
  createdAt: string
  paidAt: string | null
  fulfilledAt: string | null
}


const VALID_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  DRAFT: ["PENDING_PAYMENT"],
  PENDING_PAYMENT: ["PAID", "CANCELLED"],
  PAID: ["PROCESSING", "REFUNDED"],
  PROCESSING: ["SHIPPED", "CANCELLED"],
  SHIPPED: ["DELIVERED"],
  DELIVERED: [],
  CANCELLED: [],
  REFUNDED: [],
}


export interface TransitionEvent {
  source: "commit_order" | "webhook" | "reconciliation-job" | "manual"
  requestId?: string
  graphRunId?: string
  toolCallId?: string
}

export interface TransitionResult {
  order: CommerceOrder
  changed: boolean
}

function requireDbPool() {
  if (!pool) throw new AppError(503, "Database is not configured. Set DATABASE_URL and JWT_SECRET.")
  return pool
}

function mapRow(row: Record<string, unknown>): CommerceOrder {
  return {
    id: row.id as string,
    chatbotId: row.chatbot_id as string,
    customerId: row.customer_id as string,
    woocommerceOrderId: row.woocommerce_order_id as string,
    bookingNumber: (row.booking_number as string | null) ?? null,
    status: row.status as OrderStatus,
    operationalStatus: (row.operational_status as OperationalStatus) ?? null,
    orderSnapshot: row.order_snapshot as Record<string, unknown>,
    createdAt: (row.created_at as Date).toISOString(),
    paidAt: row.paid_at ? (row.paid_at as Date).toISOString() : null,
    fulfilledAt: row.fulfilled_at ? (row.fulfilled_at as Date).toISOString() : null,
  }
}

function isUniqueViolation(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: string }).code === "23505")
}

const MAX_BOOKING_NUMBER_ATTEMPTS = 5

/** ISO 4217 currencies whose minor unit is not 1/100 of the major unit. */
const THREE_DECIMAL_CURRENCIES = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"])
const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "UYI", "VND", "VUV", "XAF", "XOF", "XPF",
])

export function currencyMinorUnitExponent(currency: string): number {
  const code = currency.trim().toUpperCase()
  if (THREE_DECIMAL_CURRENCIES.has(code)) return 3
  if (ZERO_DECIMAL_CURRENCIES.has(code)) return 0
  return 2
}

/**
 * Decimal amount -> integer minor units, parsed from its string form (no
 * binary floating point). Digits beyond the currency's exponent are rounded
 * half-up. Returns null for anything that is not a plain decimal number.
 */
export function toMinorUnits(value: unknown, exponent: number): bigint | null {
  if (value === null || value === undefined) return null
  if (typeof value !== "string" && typeof value !== "number") return null
  if (typeof value === "number" && !Number.isFinite(value)) return null
  const text = String(value).trim()
  const match = /^(-?)(\d+)(?:\.(\d*))?$/.exec(text)
  if (!match) return null
  const [, sign, whole, fraction = ""] = match
  const kept = fraction.slice(0, exponent).padEnd(exponent, "0")
  let minor = BigInt(whole + kept)
  if (fraction.length > exponent && Number(fraction[exponent]) >= 5) minor += 1n
  return sign === "-" ? -minor : minor
}

function formatMinorUnits(minor: bigint, exponent: number): string {
  if (exponent === 0) return minor.toString()
  const negative = minor < 0n
  const digits = (negative ? -minor : minor).toString().padStart(exponent + 1, "0")
  return `${negative ? "-" : ""}${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`
}

export interface PaymentAmountCheck {
  ok: boolean
  reason: string
}

/**
 * CS-13 (B09-008): payment must cover what this order was created for.
 * The expected amount is the total WooCommerce itself computed when
 * commit_order created the order (`wooTotal`/`wooCurrency`, recorded on the
 * snapshot), falling back to the chat snapshot's own total for orders
 * created before that was recorded. An order whose total was lowered after
 * creation (coupon, manual edit), or that was paid in another currency, is
 * not marked PAID. An unknown expected amount fails closed.
 */
export function checkPaidAmountAgainstSnapshot(
  snapshot: Record<string, unknown> | null | undefined,
  paid: { total: string; currency: string },
): PaymentAmountCheck {
  const snap = snapshot ?? {}
  const expectedCurrency = String(snap.wooCurrency ?? snap.currency ?? "").trim().toUpperCase()
  const paidCurrency = String(paid.currency ?? "").trim().toUpperCase()
  if (expectedCurrency && paidCurrency !== expectedCurrency) {
    return { ok: false, reason: `currency mismatch: expected ${expectedCurrency}, WooCommerce reports ${paidCurrency || "none"}` }
  }
  const exponent = currencyMinorUnitExponent(expectedCurrency || paidCurrency)
  const expectedMinor = toMinorUnits(snap.wooTotal, exponent) ?? toMinorUnits(snap.total, exponent)
  const paidMinor = toMinorUnits(paid.total, exponent)
  if (expectedMinor === null) return { ok: false, reason: "order snapshot has no expected total" }
  if (paidMinor === null) return { ok: false, reason: "WooCommerce order has no numeric total" }
  if (paidMinor < expectedMinor) {
    return {
      ok: false,
      reason: `paid total ${formatMinorUnits(paidMinor, exponent)} is below the expected ${formatMinorUnits(expectedMinor, exponent)}`,
    }
  }
  return { ok: true, reason: "paid total and currency match the order" }
}


async function confirmAndPay(
  client: { query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  order: Record<string, unknown>,
  event: TransitionEvent,
): Promise<TransitionResult> {
  const chatbotId = order.chatbot_id as string
  const orderId = order.id as string
  const creds = await getDecryptedWooCommerceCredentials(chatbotId)
  if (!creds) {
    const { rows } = await client.query(
      "update commerce_orders set operational_status = 'INTEGRATION_ERROR' where id = $1 returning *",
      [orderId],
    )
    log().error({ ...event, orderId, chatbotId }, "cannot verify payment: no WooCommerce credentials configured for this chatbot")
    return { order: mapRow(rows[0]), changed: false }
  }

  let wooOrder
  try {
    wooOrder = await getOrderStatus(creds, Number(order.woocommerce_order_id))
  } catch (err) {
    const { rows } = await client.query(
      "update commerce_orders set operational_status = 'SYNC_ERROR' where id = $1 returning *",
      [orderId],
    )
    log().error({ ...event, orderId, chatbotId, err: err instanceof Error ? err.message : String(err) }, "payment re-verification failed: could not reach WooCommerce")
    return { order: mapRow(rows[0]), changed: false }
  }

  const policy = PaymentConfirmationPolicy(wooOrder)
  log().info(
    { ...event, orderId, chatbotId, woocommerceOrderId: order.woocommerce_order_id, paymentConfirmed: policy.paymentConfirmed, reason: policy.reason, observedStatus: policy.observedStatus, observedPaymentMethod: policy.observedPaymentMethod },
    "payment confirmation policy evaluated",
  )

  if (!policy.paymentConfirmed) {
    const { rows } = await client.query(
      "update commerce_orders set operational_status = 'PAYMENT_VERIFICATION_PENDING' where id = $1 returning *",
      [orderId],
    )
    return { order: mapRow(rows[0]), changed: false }
  }

  const amount = checkPaidAmountAgainstSnapshot(order.order_snapshot as Record<string, unknown>, wooOrder)
  if (!amount.ok) {
    const { rows } = await client.query(
      "update commerce_orders set operational_status = 'PAYMENT_VERIFICATION_FAILED' where id = $1 returning *",
      [orderId],
    )
    log().error(
      { ...event, orderId, chatbotId, woocommerceOrderId: order.woocommerce_order_id, reason: amount.reason },
      "payment not accepted: WooCommerce amount/currency does not match the order",
    )
    return { order: mapRow(rows[0]), changed: false }
  }


  for (let attempt = 0; attempt < MAX_BOOKING_NUMBER_ATTEMPTS; attempt++) {
    const candidate = generateBookingNumberCandidate()
    
    await client.query("SAVEPOINT booking_number_attempt")
    try {
      const { rows } = await client.query(
        `update commerce_orders
         set status = 'PAID', booking_number = $1, paid_at = now(), operational_status = null
         where id = $2
         returning *`,
        [candidate, orderId],
      )
      await client.query("RELEASE SAVEPOINT booking_number_attempt")
      log().info({ ...event, orderId, chatbotId, bookingNumber: candidate, attempt: attempt + 1 }, "order transitioned to PAID, booking number generated")
     
      return { order: mapRow(rows[0]), changed: true }
    } catch (err) {
      if (isUniqueViolation(err)) {
        await client.query("ROLLBACK TO SAVEPOINT booking_number_attempt")
        log().warn({ ...event, orderId, chatbotId, attempt: attempt + 1 }, "booking number collision, retrying with a new candidate")
        continue
      }
      throw err
    }
  }
  throw new AppError(500, "Could not generate a unique booking number after several attempts.")
}

export async function transitionOrderState(orderId: string, newState: OrderStatus, event: TransitionEvent): Promise<TransitionResult> {
  const db = requireDbPool()
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    const { rows } = await client.query("select * from commerce_orders where id = $1 for update", [orderId])
    const order = rows[0]
    if (!order) {
      throw new AppError(404, "Order not found.")
    }

    const currentState = order.status as OrderStatus

    if (currentState === newState) {
      await client.query("COMMIT")
      log().info({ ...event, orderId, status: currentState }, "transition_order_state: already in target state, no-op")
      return { order: mapRow(order), changed: false }
    }

    const allowed = VALID_TRANSITIONS[currentState] ?? []
    if (!allowed.includes(newState)) {
      throw new AppError(409, `Cannot transition order from ${currentState} to ${newState}.`)
    }

    if (currentState === "PENDING_PAYMENT" && newState === "PAID") {
      const result = await confirmAndPay(client, order, event)
      await client.query("COMMIT")

      if (result.changed && result.order.bookingNumber) {
       
        await promoteVerificationLevel(result.order.customerId, "ORDER_VERIFIED").catch((err) => {
          log().warn({ ...event, orderId, chatbotId: result.order.chatbotId, err: err instanceof Error ? err.message : String(err) }, "verification-level promotion failed (non-fatal)")
        })
        await createPaymentConfirmedNotification(result.order.chatbotId, result.order.customerId, orderId, result.order.bookingNumber).catch((err) => {
          log().warn({ ...event, orderId, chatbotId: result.order.chatbotId, err: err instanceof Error ? err.message : String(err) }, "customer notification write failed (non-fatal)")
        })
      }
      return result
    }

    const { rows: updated } = await client.query("update commerce_orders set status = $1 where id = $2 returning *", [newState, orderId])
    await client.query("COMMIT")
    log().info({ ...event, orderId, from: currentState, to: newState }, "order state transitioned")
    return { order: mapRow(updated[0]), changed: true }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

export interface AttachWooOrderInput {
  orderId: string
  placeholderOrderId: string
  woocommerceOrderId: string
  paymentUrl: string
  wooTotal: string
  wooCurrency: string
}

/**
 * CS-13 (B06-018): the DRAFT -> PENDING_PAYMENT edge for commit_order.
 * Sets the real WooCommerce order id and moves the state in one locked,
 * guarded transaction, so it only ever applies to the still-DRAFT claim
 * row that carries this commit's placeholder id.
 */
export async function attachWooOrderAndMarkPending(input: AttachWooOrderInput, event: TransitionEvent): Promise<CommerceOrder> {
  const db = requireDbPool()
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    const { rows } = await client.query("select * from commerce_orders where id = $1 for update", [input.orderId])
    const order = rows[0]
    if (!order) throw new AppError(404, "Order not found.")
    if (order.status !== "DRAFT" || order.woocommerce_order_id !== input.placeholderOrderId) {
      throw new AppError(409, `Cannot attach a WooCommerce order to an order in state ${String(order.status)}.`)
    }
    const { rows: updated } = await client.query(
      `update commerce_orders
       set woocommerce_order_id = $1, status = 'PENDING_PAYMENT', operational_status = null,
           order_snapshot = order_snapshot || jsonb_build_object('paymentUrl', $2::text, 'wooTotal', $3::text, 'wooCurrency', $4::text)
       where id = $5 and status = 'DRAFT'
       returning *`,
      [input.woocommerceOrderId, input.paymentUrl, input.wooTotal, input.wooCurrency, input.orderId],
    )
    await client.query("COMMIT")
    log().info({ ...event, orderId: input.orderId, from: "DRAFT", to: "PENDING_PAYMENT" }, "order state transitioned")
    return mapRow(updated[0])
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/**
 * CS-13 (B06-018): mark a DRAFT claim whose WooCommerce create call failed,
 * so a retry with the same idempotency key can re-claim it instead of
 * getting 409 forever. Only touches the still-DRAFT placeholder row.
 */
export async function markDraftCreateFailed(orderId: string, placeholderOrderId: string): Promise<void> {
  const db = requireDbPool()
  await db.query(
    `update commerce_orders set operational_status = 'INTEGRATION_ERROR'
     where id = $1 and status = 'DRAFT' and woocommerce_order_id = $2`,
    [orderId, placeholderOrderId],
  )
}

export async function getCommerceOrder(orderId: string): Promise<CommerceOrder | null> {
  const db = requireDbPool()
  const { rows } = await db.query("select * from commerce_orders where id = $1", [orderId])
  return rows[0] ? mapRow(rows[0]) : null
}
