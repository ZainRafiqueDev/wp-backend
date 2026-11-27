import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import compression from "compression"
import cookieParser from "cookie-parser"
import cors from "cors"
import express from "express"
import helmet from "helmet"

import { postStripeWebhook } from "./controllers/billing.controller.js"
import { postCalendlyWebhook } from "./controllers/calendlyWebhook.controller.js"
import { postWooCommerceWebhook } from "./controllers/commerceWebhook.controller.js"
import { env } from "./env.js"
import { log } from "./lib/logger.js"
import { errorHandler } from "./middleware/errorHandler.js"
import { requestId } from "./middleware/requestId.js"
import { bindTenantContext } from "./middleware/tenantContext.js"
import { registerRoutes } from "./routes/index.js"
import { initSentry, installSentryErrorHandler } from "./lib/sentry.js"
import { requireTrustedOrigin } from "./middleware/requireTrustedOrigin.js"

initSentry()

export const app = express()
const publicDir = join(dirname(fileURLToPath(import.meta.url)), "public")


app.use(requestId)


// This server only returns JSON and a static embed.js, never HTML, so the
// strictest CSP costs nothing here. It stops any response (an error page, a
// mis-typed upload served back) from running script or being framed if a
// browser ever renders it. embed.js runs in the customer's page under that
// page's own CSP, which this header does not affect.
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
  }),
)

// gzip/brotli-compresses JSON responses — admin listings, usage summaries,
// notifications, and document lists can all be sizeable payloads now that
// the API surface has grown well past the original chat-only endpoints.
// Default threshold (1KB) means small responses (webhook acks, health
// checks) skip compression entirely rather than paying its overhead for
// nothing.
app.use(compression())

// req.ip feeds every rate limiter. TRUST_PROXY_HOPS must equal the number
// of reverse proxies in front of this process (production: 1 — the ALB /
// Caddy / Railway edge, see DEPLOYMENT.md and docs/deploy-aws-ec2.md), so
// req.ip is the address that proxy saw rather than the client-controlled
// left end of X-Forwarded-For. 0 (local dev default) means X-Forwarded-For
// is ignored entirely and req.ip is the socket peer.
export function resolveTrustProxy(hops: number): number | false {
  if (!Number.isInteger(hops) || hops < 0) {
    throw new Error(`TRUST_PROXY_HOPS must be a non-negative integer (got ${String(hops)})`)
  }
  return hops > 0 ? hops : false
}

const trustProxy = resolveTrustProxy(env.trustProxyHops)
app.set("trust proxy", trustProxy)
if (trustProxy === false && env.nodeEnv === "production") {
  log().warn(
    { event: "trust-proxy-disabled" },
    "TRUST_PROXY_HOPS=0 in production: if a proxy/load balancer fronts this app, every client shares one rate-limit bucket — set it to the proxy hop count (normally 1)",
  )
}


app.use(
  cors({
    origin: env.frontendUrl,
    exposedHeaders: ["Retry-After", "X-Request-Id", "X-Total-Count"],
    // Required for the browser to both send the httpOnly auth cookies on
    // cross-origin requests and accept the Set-Cookie response that sets
    // them — without this, credentials:"include" on the frontend's fetch
    // calls has no effect. Safe alongside a specific (non-wildcard) origin
    // above; the two together are exactly what CORS requires for
    // credentialed cross-origin requests (a wildcard origin can't be
    // combined with credentials at all).
    credentials: true,
  }),
)

app.use(cookieParser())

// CSRF: cookie-authenticated, state-changing requests must come from FRONTEND_URL.
// See src/middleware/requireTrustedOrigin.ts.
app.use(requireTrustedOrigin)

app.post("/webhooks/stripe", express.raw({ type: "application/json" }), postStripeWebhook)

app.post("/webhooks/woocommerce/:chatbotId", express.raw({ type: "*/*" }), postWooCommerceWebhook)

app.post("/webhooks/calendly", express.raw({ type: "application/json" }), postCalendlyWebhook)

app.use(express.json({ limit: "256kb" }))

app.use(bindTenantContext)


app.get("/embed/v1/embed.js", (_req, res) => {
  res.set("Cache-Control", "public, max-age=86400, immutable")
  res.set("Cross-Origin-Resource-Policy", "cross-origin")
  res.type("application/javascript")
  res.sendFile(join(publicDir, "embed.js"))
})
app.get("/embed.js", (_req, res) => {
  res.set("Cache-Control", "public, max-age=300")
  res.set("Cross-Origin-Resource-Policy", "cross-origin")
  res.type("application/javascript")
  res.sendFile(join(publicDir, "embed.js"))
})

registerRoutes(app)

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: "Not found" })
})

installSentryErrorHandler(app)

app.use(errorHandler)
