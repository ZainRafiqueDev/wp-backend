import type { NextFunction, Request, Response } from "express"

import { verifyAccessToken, verifyAdminAccessToken } from "../lib/auth.js"
import { isUuid, setTenantContext } from "../lib/tenantContext.js"
import { getBearerToken } from "./requireAuth.js"

function pathOnly(req: Request): string {
  return (req.originalUrl || req.url || "").split("?")[0]
}

function bodyEmail(req: Request): string {
  const email = (req.body as { email?: unknown } | undefined)?.email
  return typeof email === "string" ? email : ""
}

/**
 * Fills the request's tenant ALS from JWT / route identity.
 * Does not 401 — invalid tokens leave context empty so RLS returns 0 rows.
 * Chatbot id is taken from public widget URLs only. Owner routes wait for
 * `requireOwnedChatbotId` so a guessed UUID cannot become app.chatbot_id.
 */
export function bindTenantContext(req: Request, _res: Response, next: NextFunction) {
  const url = pathOnly(req)

  const adminUserId = verifyAdminAccessToken(getBearerToken(req))
  if (adminUserId && (url === "/admin" || url.startsWith("/admin/"))) {
    setTenantContext({ scope: "admin", adminUserId })
    return next()
  }

  const userId = verifyAccessToken(getBearerToken(req))
  if (userId) {
    setTenantContext({ scope: "user", userId })
  }

  if ((url === "/auth" || url.startsWith("/auth/")) && !userId) {
    setTenantContext({ scope: "auth", userEmail: bodyEmail(req) })
  }

  const publicChatbot = url.match(/^\/public\/chatbots\/([^/]+)/)
  if (publicChatbot && isUuid(publicChatbot[1])) {
    setTenantContext({ scope: "public", chatbotId: publicChatbot[1] })
  }

  if (url === "/leads" || url.startsWith("/leads/")) {
    if (!userId) {
      setTenantContext({ scope: "public", userEmail: bodyEmail(req) })
    }
  }

  next()
}
