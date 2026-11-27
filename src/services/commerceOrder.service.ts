
import { pool } from "../lib/db.js"
import { AppError } from "../lib/errors.js"
import { log } from "../lib/logger.js"
import { createOrder, buildOrderPayUrl, type WooCommerceCredentials } from "../lib/woocommerce/connector.js"
import { authorizeToolCall, type ToolAuthorizationRequest } from "./toolAuthorization.service.js"
import {
  attachWooOrderAndMarkPending,
  getCommerceOrder,
  markDraftCreateFailed,
  type CommerceOrder,
} from "./orderState.service.js"

function requireDbPool() {
  if (!pool) throw new AppError(503, "Database is not configured. Set DATABASE_URL and JWT_SECRET.")
  return pool
}

export interface OrderSnapshotLineItem {
  productId: number
  productName: string
  sku: string | null
  quantity: number
  unitPrice: number
  subtotal: number
}


export interface OrderSnapshot {
  lineItems: OrderSnapshotLineItem[]
  shipping: number
  tax: number
  total: number
  currency: string
}

export interface CommitOrderInput {
  chatbotId: string
  customerId: string
  creds: WooCommerceCredentials
  snapshot: OrderSnapshot
  customer: { firstName: string; lastName: string; email: string; phone?: string | null }
 
  idempotencyKey: string
  requestId?: string
  graphRunId?: string
  toolCallId?: string
}

export interface CommitOrderResult {
  order: CommerceOrder
  paymentUrl: string
}

function requireOwnedResult(order: Record<string, unknown>): CommerceOrder {
  return {
    id: order.id as string,
    chatbotId: order.chatbot_id as string,
    customerId: order.customer_id as string,
    woocommerceOrderId: order.woocommerce_order_id as string,
    bookingNumber: (order.booking_number as string | null) ?? null,
    status: order.status as CommerceOrder["status"],
    operationalStatus: (order.operational_status as CommerceOrder["operationalStatus"]) ?? null,
    orderSnapshot: order.order_snapshot as Record<string, unknown>,
    createdAt: (order.created_at as Date).toISOString(),
    paidAt: order.paid_at ? (order.paid_at as Date).toISOString() : null,
    fulfilledAt: order.fulfilled_at ? (order.fulfilled_at as Date).toISOString() : null,
  }
}


export async function commitOrder(input: CommitOrderInput): Promise<CommitOrderResult> {
  const authReq: ToolAuthorizationRequest = {
    chatbotId: input.chatbotId,
    customerId: input.customerId,
    operation: "create_order",
    requestId: input.requestId,
    graphRunId: input.graphRunId,
    toolCallId: input.toolCallId,
  }
  await authorizeToolCall(authReq)

  const db = requireDbPool()
  const placeholderOrderId = `pending:${input.idempotencyKey}`

  const claim = await db.query(
    `insert into commerce_orders (chatbot_id, customer_id, woocommerce_order_id, idempotency_key, status, order_snapshot)
     values ($1, $2, $3, $4, 'DRAFT', $5)
     on conflict (chatbot_id, idempotency_key) do nothing
     returning *`,
    [input.chatbotId, input.customerId, placeholderOrderId, input.idempotencyKey, JSON.stringify(input.snapshot)],
  )

  if (!claim.rows[0]) {
    // CS-13 (B06-018): a previous attempt with this key failed before
    // WooCommerce returned an order; re-claim that DRAFT row atomically
    // (only one retry wins) instead of answering 409 forever.
    const reclaimed = await db.query(
      `update commerce_orders set operational_status = null
       where chatbot_id = $1 and idempotency_key = $2 and status = 'DRAFT'
         and woocommerce_order_id = $3 and operational_status = 'INTEGRATION_ERROR'
         and customer_id = $4
       returning *`,
      [input.chatbotId, input.idempotencyKey, placeholderOrderId, input.customerId],
    )
    if (reclaimed.rows[0]) {
      return createWooOrderForClaim(input, authReq, reclaimed.rows[0].id as string, placeholderOrderId)
    }

    const { rows: existing } = await db.query(
      "select * from commerce_orders where chatbot_id = $1 and idempotency_key = $2",
      [input.chatbotId, input.idempotencyKey],
    )
    const existingOrder = existing[0]
    if (!existingOrder || existingOrder.woocommerce_order_id === placeholderOrderId) {
      log().warn({ ...authReq, idempotencyKey: input.idempotencyKey }, "commit_order: another commit attempt for this idempotency key is already in progress")
      throw new AppError(409, "This order is already being created. Please wait a moment before retrying.")
    }
    log().info({ ...authReq, idempotencyKey: input.idempotencyKey, orderId: existingOrder.id }, "commit_order: idempotent replay, WooCommerce was not called again")
    const order = requireOwnedResult(existingOrder)
    
    const paymentUrl = (order.orderSnapshot as { paymentUrl?: string }).paymentUrl
    if (!paymentUrl) {
      throw new AppError(500, "This order was already created, but its payment URL wasn't recorded — this should never happen; treat as a data integrity issue, not a retry-safe condition.")
    }
    return { order, paymentUrl }
  }


  return createWooOrderForClaim(input, authReq, claim.rows[0].id as string, placeholderOrderId)
}

async function createWooOrderForClaim(
  input: CommitOrderInput,
  authReq: ToolAuthorizationRequest,
  claimId: string,
  placeholderOrderId: string,
): Promise<CommitOrderResult> {
  let wooOrder
  let paymentUrl: string
  try {
    wooOrder = await createOrder(input.creds, {
      lineItems: input.snapshot.lineItems.map((item) => ({ productId: item.productId, quantity: item.quantity })),
      customer: input.customer,
    })
    paymentUrl = buildOrderPayUrl(input.creds.storeUrl, wooOrder)
  } catch (err) {
    await markDraftCreateFailed(claimId, placeholderOrderId).catch((markErr) => {
      log().error(
        { ...authReq, orderId: claimId, err: markErr instanceof Error ? markErr.message : String(markErr) },
        "commit_order: could not mark the failed DRAFT claim retryable",
      )
    })
    log().warn(
      { ...authReq, idempotencyKey: input.idempotencyKey, orderId: claimId, err: err instanceof Error ? err.message : String(err) },
      "commit_order: WooCommerce order create failed, DRAFT claim left retryable",
    )
    throw err
  }

  let order: CommerceOrder
  try {
    order = await attachWooOrderAndMarkPending(
      {
        orderId: claimId,
        placeholderOrderId,
        woocommerceOrderId: String(wooOrder.id),
        paymentUrl,
        wooTotal: String(wooOrder.total ?? ""),
        wooCurrency: String(wooOrder.currency ?? ""),
      },
      { source: "commit_order", requestId: input.requestId, graphRunId: input.graphRunId, toolCallId: input.toolCallId },
    )
  } catch (err) {
    // A payable WooCommerce order exists but the local row could not be
    // linked. Log both ids loudly so an operator can reconcile.
    log().error(
      { ...authReq, idempotencyKey: input.idempotencyKey, orderId: claimId, woocommerceOrderId: wooOrder.id, err: err instanceof Error ? err.message : String(err) },
      "commit_order: WooCommerce order created but the local order could not be linked; manual reconciliation needed",
    )
    throw err
  }
  log().info(
    { ...authReq, idempotencyKey: input.idempotencyKey, orderId: claimId, woocommerceOrderId: wooOrder.id, total: input.snapshot.total },
    "order committed: real WooCommerce order created, PENDING_PAYMENT",
  )

  return { order, paymentUrl }
}

export async function getOrderForCustomer(chatbotId: string, customerId: string, orderId: string): Promise<CommerceOrder> {
  await authorizeToolCall({ chatbotId, customerId, operation: "get_order_status", resource: { type: "order", id: orderId } })
  const order = await getCommerceOrder(orderId)
  if (!order) throw new AppError(404, "Order not found.")
  return order
}
