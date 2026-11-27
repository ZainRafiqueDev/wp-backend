// A thin real client for WooCommerce's REST API v3
// (https://woocommerce.github.io/woocommerce-rest-api-docs/), authenticated
// with a store's REST API consumer key/secret over HTTP Basic Auth (the
// documented approach over HTTPS — the alternative, putting them in the
// query string, is only for plain HTTP stores and deliberately not used
// here). Every function here does exactly one real WooCommerce call; the
// route handlers in app.ts translate between this shape and ChatMate360's
// generic Backend Integration Contract shape.

export interface WooConfig {
  storeUrl: string // e.g. "https://my-shop.example.com", no trailing slash
  consumerKey: string
  consumerSecret: string
}

export interface WooProduct {
  id: number
  name: string
  price: string
  regular_price: string
  sku: string
  stock_status: "instock" | "outofstock" | "onbackorder"
  stock_quantity: number | null
  manage_stock: boolean
  short_description?: string
}

export interface WooOrder {
  id: number
  number: string
  status: string
  currency: string
  total: string
}

class WooApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

export { WooApiError }

function authHeader(config: WooConfig): string {
  return `Basic ${Buffer.from(`${config.consumerKey}:${config.consumerSecret}`).toString("base64")}`
}

async function wooFetch<T>(config: WooConfig, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${config.storeUrl}/wp-json/wc/v3${path}`, {
    ...init,
    headers: {
      Authorization: authHeader(config),
      "Content-Type": "application/json",
      ...(init?.headers as Record<string, string> | undefined),
    },
    signal: AbortSignal.timeout(8000),
  })

  const text = await res.text().catch(() => "")
  const json = text ? JSON.parse(text) : null

  if (!res.ok) {
    const message = json && typeof json === "object" && "message" in json ? String((json as { message: unknown }).message) : `WooCommerce request failed (${res.status})`
    throw new WooApiError(res.status, message)
  }
  return json as T
}

export function listProducts(config: WooConfig, perPage = 50): Promise<WooProduct[]> {
  return wooFetch<WooProduct[]>(config, `/products?per_page=${perPage}`)
}

export function getProduct(config: WooConfig, id: string): Promise<WooProduct> {
  return wooFetch<WooProduct>(config, `/products/${encodeURIComponent(id)}`)
}

export function updateProductStock(config: WooConfig, id: string, stockQuantity: number): Promise<WooProduct> {
  return wooFetch<WooProduct>(config, `/products/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify({ manage_stock: true, stock_quantity: stockQuantity }),
  })
}

export interface CreateOrderInput {
  productId: string
  quantity: number
  customerName: string
  customerEmail: string
  customerPhone?: string | null
}

export function createOrder(config: WooConfig, input: CreateOrderInput): Promise<WooOrder> {
  const [firstName, ...rest] = input.customerName.trim().split(/\s+/)
  const lastName = rest.join(" ") || "-"

  return wooFetch<WooOrder>(config, "/orders", {
    method: "POST",
    body: JSON.stringify({
      payment_method: "chatmate360",
      payment_method_title: "ChatMate360 chat purchase",
      set_paid: false,
      billing: {
        first_name: firstName || "-",
        last_name: lastName,
        email: input.customerEmail,
        phone: input.customerPhone || "",
      },
      line_items: [{ product_id: Number(input.productId), quantity: input.quantity }],
    }),
  })
}
