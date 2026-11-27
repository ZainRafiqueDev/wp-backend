import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
export type IsolationKind = "owner-404" | "public-scoped" | "webhook-secret" | "bookly-admin-token"

export type ChatbotScopedRoute = {
  method: HttpMethod
  path: string
  isolation: IsolationKind
  coveringMarker: string
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..")

const ROUTE_CALL = /\b(?:chatbotRouter|billingRouter|publicRouter|app)\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g

export function extractChatbotScopedPaths(source: string, mountPrefix: string): Array<{ method: HttpMethod; path: string }> {
  const found: Array<{ method: HttpMethod; path: string }> = []
  for (const match of source.matchAll(ROUTE_CALL)) {
    const method = match[1].toUpperCase() as HttpMethod
    const rawPath = match[2]
    if (!rawPath.includes(":chatbotId")) continue
    const path = `${mountPrefix}${rawPath.startsWith("/") ? rawPath : `/${rawPath}`}`
    found.push({ method, path })
  }
  return found
}

export function readRouteSource(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8")
}

export function discoveredChatbotScopedRoutes(): Array<{ method: HttpMethod; path: string }> {
  return [
    ...extractChatbotScopedPaths(readRouteSource("src/routes/chatbot.routes.ts"), "/chatbots"),
    ...extractChatbotScopedPaths(readRouteSource("src/routes/billing.routes.ts"), "/billing"),
    ...extractChatbotScopedPaths(readRouteSource("src/routes/public.routes.ts"), "/public"),
    ...extractChatbotScopedPaths(readRouteSource("src/app.ts"), ""),
  ]
}

function route(method: HttpMethod, path: string, isolation: IsolationKind): ChatbotScopedRoute {
  return {
    method,
    path,
    isolation,
    coveringMarker: `CROSS_TENANT: ${method} ${path}`,
  }
}

// Every :chatbotId route in the process. Adding a new chatbot-scoped route
// without an entry here fails tests/unit/crossTenantRoutePack.test.ts.
export const CHATBOT_SCOPED_ROUTES: ChatbotScopedRoute[] = [
  route("GET", "/chatbots/:chatbotId", "owner-404"),
  route("POST", "/chatbots/:chatbotId/retry", "owner-404"),
  route("PATCH", "/chatbots/:chatbotId/theme", "owner-404"),
  route("PATCH", "/chatbots/:chatbotId/domain", "owner-404"),
  route("PATCH", "/chatbots/:chatbotId/fallback-message", "owner-404"),
  route("PATCH", "/chatbots/:chatbotId/preferred-model", "owner-404"),
  route("GET", "/chatbots/:chatbotId/usage", "owner-404"),
  route("GET", "/chatbots/:chatbotId/analytics", "owner-404"),
  route("POST", "/chatbots/:chatbotId/chat", "owner-404"),
  route("GET", "/chatbots/:chatbotId/live-data", "owner-404"),
  route("POST", "/chatbots/:chatbotId/live-data", "owner-404"),
  route("PATCH", "/chatbots/:chatbotId/live-data/:id", "owner-404"),
  route("DELETE", "/chatbots/:chatbotId/live-data/:id", "owner-404"),
  route("GET", "/chatbots/:chatbotId/integration", "owner-404"),
  route("PUT", "/chatbots/:chatbotId/integration", "owner-404"),
  route("DELETE", "/chatbots/:chatbotId/integration", "owner-404"),
  route("GET", "/chatbots/:chatbotId/actions", "owner-404"),
  route("POST", "/chatbots/:chatbotId/actions", "owner-404"),
  route("PUT", "/chatbots/:chatbotId/actions/:id", "owner-404"),
  route("DELETE", "/chatbots/:chatbotId/actions/:id", "owner-404"),
  route("GET", "/chatbots/:chatbotId/documents", "owner-404"),
  route("GET", "/chatbots/:chatbotId/documents/:id/status", "owner-404"),
  route("POST", "/chatbots/:chatbotId/documents", "owner-404"),
  route("DELETE", "/chatbots/:chatbotId/documents/:id", "owner-404"),
  route("POST", "/chatbots/:chatbotId/documents/:id/retry", "owner-404"),
  route("GET", "/chatbots/:chatbotId/okf/overview", "owner-404"),
  route("GET", "/chatbots/:chatbotId/okf/index", "owner-404"),
  route("GET", "/chatbots/:chatbotId/okf/export", "owner-404"),
  route("GET", "/chatbots/:chatbotId/okf/concepts", "owner-404"),
  route("POST", "/chatbots/:chatbotId/okf/concepts", "owner-404"),
  route("GET", "/chatbots/:chatbotId/okf/concepts/:id", "owner-404"),
  route("PUT", "/chatbots/:chatbotId/okf/concepts/:id", "owner-404"),
  route("POST", "/chatbots/:chatbotId/okf/concepts/:id/approve", "owner-404"),
  route("DELETE", "/chatbots/:chatbotId/okf/concepts/:id", "owner-404"),
  route("GET", "/chatbots/:chatbotId/okf/concepts/:id/audit", "owner-404"),
  route("POST", "/chatbots/:chatbotId/okf/concepts/:id/restore", "owner-404"),
  route("GET", "/chatbots/:chatbotId/woocommerce", "owner-404"),
  route("POST", "/chatbots/:chatbotId/woocommerce", "owner-404"),
  route("DELETE", "/chatbots/:chatbotId/woocommerce", "owner-404"),
  route("POST", "/chatbots/:chatbotId/woocommerce/sync", "owner-404"),
  route("GET", "/chatbots/:chatbotId/bookly", "owner-404"),
  route("POST", "/chatbots/:chatbotId/bookly", "owner-404"),
  route("DELETE", "/chatbots/:chatbotId/bookly", "owner-404"),
  route("GET", "/chatbots/:chatbotId/bookly/meeting-history", "owner-404"),
  route("POST", "/chatbots/:chatbotId/bookly-admin-chat", "bookly-admin-token"),
  route("GET", "/chatbots/:chatbotId/bookly-admin-audit-log", "owner-404"),
  route("POST", "/billing/chatbots/:chatbotId/topup", "owner-404"),
  route("GET", "/chatbots/:chatbotId/attachments", "owner-404"),
  route("GET", "/chatbots/:chatbotId/attachments/:attachmentId", "owner-404"),
  route("GET", "/public/chatbots/:chatbotId", "public-scoped"),
  route("POST", "/public/chatbots/:chatbotId/chat", "public-scoped"),
  route("POST", "/public/chatbots/:chatbotId/memory/export", "public-scoped"),
  route("POST", "/public/chatbots/:chatbotId/memory/delete", "public-scoped"),
  route("POST", "/public/chatbots/:chatbotId/attachments", "public-scoped"),
  route("POST", "/webhooks/woocommerce/:chatbotId", "webhook-secret"),
]

export function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`
}
