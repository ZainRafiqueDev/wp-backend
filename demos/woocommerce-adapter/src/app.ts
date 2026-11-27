import express, { type Express } from "express"

import { contractOrderRequestToWooInput, orderToContract, productToAvailability, productToContract } from "./contractMapping.js"
import { createOrder, getProduct, listProducts, updateProductStock, WooApiError, type WooConfig } from "./wooClient.js"

// Optional shared-secret check on the INBOUND side (ChatMate360 calling
// this adapter) — separate from the OUTBOUND WooConfig auth this adapter
// uses to call the real WooCommerce store. Mirrors the same pattern as the
// booking-api demo.
function requireApiKey(apiKey: string | undefined) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!apiKey) return next()
    const header = req.header("authorization") || ""
    if (header === `Bearer ${apiKey}`) return next()
    res.status(401).json({ error: "Missing or invalid API key." })
  }
}

function wooErrorStatus(err: unknown): number {
  return err instanceof WooApiError && err.status >= 400 && err.status < 500 ? err.status : 502
}

export function createApp(options: { apiKey?: string; woo: WooConfig }): Express {
  const app = express()
  app.use(express.json())
  const auth = requireApiKey(options.apiKey)

  app.get("/health", (_req, res) => {
    res.status(200).json({ ok: true })
  })

  // Backend Integration Contract, Phase 1 (read) — GET {api_base_url}/products
  app.get("/products", auth, async (_req, res) => {
    try {
      const products = await listProducts(options.woo)
      res.status(200).json(products.map(productToContract))
    } catch (err) {
      res.status(wooErrorStatus(err)).json({ error: err instanceof Error ? err.message : "Couldn't reach the store." })
    }
  })

  // Backend Integration Contract, Phase 1 (read) —
  // GET {api_base_url}/products/{id}/availability
  app.get("/products/:id/availability", auth, async (req, res) => {
    try {
      const product = await getProduct(options.woo, String(req.params.id))
      res.status(200).json(productToAvailability(product))
    } catch (err) {
      if (err instanceof WooApiError && err.status === 404) {
        res.status(404).json({ error: "No such product." })
        return
      }
      res.status(wooErrorStatus(err)).json({ error: err instanceof Error ? err.message : "Couldn't reach the store." })
    }
  })

  // Backend Integration Contract, Phase 2 (write, e-commerce) —
  // POST {api_base_url}/orders — the write side implemented for the first
  // time in this pass (see docs/BACKEND_INTEGRATION_CONTRACT.md).
  app.post("/orders", auth, async (req, res) => {
    const input = contractOrderRequestToWooInput(req.body)
    if (!input) {
      res.status(400).json({ error: "productId, quantity, and customer.name/email are required." })
      return
    }
    try {
      const order = await createOrder(options.woo, input)
      res.status(201).json(orderToContract(order))
    } catch (err) {
      res.status(wooErrorStatus(err)).json({ error: err instanceof Error ? err.message : "Couldn't place that order." })
    }
  })

  // Backend Integration Contract, Phase 2 (write, e-commerce) —
  // PATCH {api_base_url}/products/{id}/inventory
  app.patch("/products/:id/inventory", auth, async (req, res) => {
    // Accepts a numeric string as well as a real number — see
    // contractMapping.ts's coerceQuantity for why (Custom Actions'
    // template engine always substitutes {{params}} as strings).
    const raw = req.body?.quantity
    const quantity = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN
    if (!Number.isFinite(quantity) || quantity < 0) {
      res.status(400).json({ error: "quantity must be a non-negative number." })
      return
    }
    try {
      const product = await updateProductStock(options.woo, String(req.params.id), quantity)
      res.status(200).json({ id: String(product.id), stock: product.stock_quantity })
    } catch (err) {
      if (err instanceof WooApiError && err.status === 404) {
        res.status(404).json({ error: "No such product." })
        return
      }
      res.status(wooErrorStatus(err)).json({ error: err instanceof Error ? err.message : "Couldn't update stock." })
    }
  })

  return app
}
