
import { assertSafeUrl } from "../crawler/ssrf.js"
import { outboundFetch } from "../outboundFetch.js"
import { AppError } from "../errors.js"
import { log } from "../logger.js"
import type { CreateOrderInput, WooCommerceOrder, WooCommerceProduct } from "./types.js"

const REQUEST_TIMEOUT_MS = 8000

export class WooCommerceApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = "WooCommerceApiError"
  }
}

export interface WooCommerceCredentials {
  storeUrl: string // no trailing slash — normalized at write time, see commerceCredentials.service.ts
  consumerKey: string
  consumerSecret: string
}

function authHeader(creds: WooCommerceCredentials): string {
  return `Basic ${Buffer.from(`${creds.consumerKey}:${creds.consumerSecret}`).toString("base64")}`
}

async function wooFetch<T>(creds: WooCommerceCredentials, path: string, init?: RequestInit): Promise<T> {
  const url = new URL(`${creds.storeUrl}/wp-json/wc/v3${path}`)
  await assertSafeUrl(url)

  let res: Response
  try {
    res = await outboundFetch(url, {
      ...init,
      headers: {
        Authorization: authHeader(creds),
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(init?.headers as Record<string, string> | undefined),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    log().warn({ err: err instanceof Error ? err.message : String(err), path }, "woocommerce request failed or timed out")
    throw new WooCommerceApiError(0, "Could not reach the WooCommerce store.")
  }

  const text = await res.text().catch(() => "")
  const json = text ? JSON.parse(text) : null

  if (!res.ok) {
    const message =
      json && typeof json === "object" && "message" in json ? String((json as { message: unknown }).message) : `WooCommerce request failed (${res.status})`
    throw new WooCommerceApiError(res.status, message)
  }
  return json as T
}

export async function getProduct(creds: WooCommerceCredentials, productId: number): Promise<WooCommerceProduct> {
  return wooFetch<WooCommerceProduct>(creds, `/products/${productId}`)
}

export async function listProducts(creds: WooCommerceCredentials, perPage = 100): Promise<WooCommerceProduct[]> {
  return wooFetch<WooCommerceProduct[]>(creds, `/products?per_page=${perPage}`)
}


export async function checkStock(
  creds: WooCommerceCredentials,
  productId: number,
): Promise<{ inStock: boolean; quantity: number | null }> {
  const product = await getProduct(creds, productId)
  return { inStock: product.stock_status === "instock" || product.stock_status === "onbackorder", quantity: product.manage_stock ? product.stock_quantity : null }
}

export async function createOrder(creds: WooCommerceCredentials, input: CreateOrderInput): Promise<WooCommerceOrder> {
  return wooFetch<WooCommerceOrder>(creds, "/orders", {
    method: "POST",
    body: JSON.stringify({
      status: "pending",
      payment_method: "chatmate360",
      payment_method_title: "ChatMate360 chat checkout",
      set_paid: false,
      billing: {
        first_name: input.customer.firstName,
        last_name: input.customer.lastName,
        email: input.customer.email,
        phone: input.customer.phone || "",
      },
      line_items: input.lineItems.map((item) => ({ product_id: item.productId, quantity: item.quantity })),
    }),
  })
}

export async function getOrderStatus(creds: WooCommerceCredentials, orderId: number): Promise<WooCommerceOrder> {
  return wooFetch<WooCommerceOrder>(creds, `/orders/${orderId}`)
}


export function buildOrderPayUrl(storeUrl: string, order: WooCommerceOrder): string {
  if (!order.order_key) {
    throw new AppError(502, "This store's WooCommerce integration did not return an order_key — cannot build a real payment URL. This is a store configuration issue, not something to work around.")
  }
  const url = new URL(`${storeUrl}/checkout/order-pay/${order.id}/`)
  url.searchParams.set("pay_for_order", "true")
  url.searchParams.set("key", order.order_key)
  return url.toString()
}
