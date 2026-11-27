// Translates between WooCommerce's real REST API v3 shapes and
// ChatMate360's Backend Integration Contract shapes
// (docs/BACKEND_INTEGRATION_CONTRACT.md in the main repo). Kept separate
// from wooClient.ts (which only knows how to talk to WooCommerce) and
// app.ts (which only knows HTTP routing) so each piece can be tested and
// read on its own.
import type { CreateOrderInput, WooOrder, WooProduct } from "./wooClient.js"

// Contract's read-side product shape:
// { id, name, price, stock, ...whatever else is useful as free-form context }
export function productToContract(product: WooProduct): Record<string, unknown> {
  return {
    id: String(product.id),
    name: product.name,
    price: product.price || product.regular_price,
    sku: product.sku || undefined,
    stock: product.manage_stock ? product.stock_quantity : null,
    stockStatus: product.stock_status,
    description: product.short_description || undefined,
  }
}

// Contract's read-side availability shape: { available, quantity, ... }.
// WooCommerce only reports a quantity when the product has stock
// management turned on (`manage_stock`) — otherwise stock_quantity is
// always null even though the product may well be in stock, so
// `available` is derived from stock_status (always present) rather than
// from quantity > 0, and `quantity` is left null rather than fabricated.
export function productToAvailability(product: WooProduct): Record<string, unknown> {
  return {
    available: product.stock_status === "instock" || product.stock_status === "onbackorder",
    quantity: product.manage_stock ? product.stock_quantity : null,
    stockStatus: product.stock_status,
  }
}

const ORDER_STATUS_MAP: Record<string, "confirmed" | "pending" | "failed"> = {
  completed: "confirmed",
  processing: "confirmed",
  pending: "pending",
  "on-hold": "pending",
  cancelled: "failed",
  refunded: "failed",
  failed: "failed",
}

// Contract's Phase 2 write shape: { orderId, status, confirmationDetails }.
export function orderToContract(order: WooOrder): { orderId: string; status: "confirmed" | "pending" | "failed"; confirmationDetails: string } {
  return {
    orderId: String(order.id),
    status: ORDER_STATUS_MAP[order.status] ?? "pending",
    confirmationDetails: `Order #${order.number || order.id} (${order.status}). Total: ${order.currency}${order.total}.`,
  }
}

// The contract's generic write-order request body ({productId, quantity,
// customer: {name, email, phone}, notes}) mapped to what wooClient.createOrder
// actually needs — WooCommerce has no single "notes" field on order
// creation the way the generic contract does; a real integration would
// post it as a follow-up order note via a second call, which is out of
// scope for this demo (flagged rather than silently dropped).
// Accepts `quantity` as either a real JSON number or a numeric string.
// ChatMate360's Custom Actions engine (src/lib/actionExecutor.ts's
// fillBody/fillTemplate in the main repo) fills every {{placeholder}} by
// string substitution, so a bodyTemplate field written as
// `"quantity": "{{quantity}}"` always arrives here as a JSON string even
// though the action's own parameter is declared `type: "number"` — a
// general property of that engine, not specific to this adapter. Rejecting
// "2" as invalid here would make every quantity-bearing Custom Action call
// fail in practice, so this coerces rather than rejects.
function coerceQuantity(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value)
  return 0
}

export function contractOrderRequestToWooInput(body: {
  productId?: unknown
  quantity?: unknown
  customer?: { name?: unknown; email?: unknown; phone?: unknown }
}): CreateOrderInput | null {
  const productId = typeof body.productId === "string" || typeof body.productId === "number" ? String(body.productId) : ""
  const quantity = coerceQuantity(body.quantity)
  const customerName = typeof body.customer?.name === "string" ? body.customer.name.trim() : ""
  const customerEmail = typeof body.customer?.email === "string" ? body.customer.email.trim() : ""
  const customerPhone = typeof body.customer?.phone === "string" ? body.customer.phone : null

  if (!productId || !quantity || !customerName || !customerEmail) return null
  return { productId, quantity, customerName, customerEmail, customerPhone }
}
