
import { AppError } from "../lib/errors.js"
import { log } from "../lib/logger.js"
import { verifyAdminSession, type BooklyAdminIdentity } from "../lib/bookly/adminConnector.js"
import { getBooklyBaseUrl } from "./booklyCredentials.service.js"

export interface VerifiedBooklyAdmin {
  id: string
  email: string
  name: string
}


export async function requireBooklyAdminSession(chatbotId: string, presentedToken: string | undefined): Promise<VerifiedBooklyAdmin> {
  if (!presentedToken || !presentedToken.trim()) {
    throw new AppError(401, "A Bookly admin session token is required.")
  }

  const baseUrl = await getBooklyBaseUrl(chatbotId)
  if (!baseUrl) {
    throw new AppError(503, "This chatbot's Bookly connection is not configured.")
  }

  let identity: BooklyAdminIdentity | null
  try {
    identity = await verifyAdminSession(baseUrl, presentedToken)
  } catch (err) {
    log().error({ chatbotId, err: err instanceof Error ? err.message : String(err) }, "bookly admin session verification failed (Bookly unreachable)")
    throw new AppError(502, "Could not verify your Bookly session right now. Please try again.")
  }

  if (!identity) {
    log().warn({ chatbotId }, "bookly admin session rejected: invalid, expired, or revoked token")
    throw new AppError(401, "Your Bookly session is no longer valid. Please sign in again.")
  }
  if (identity.role !== "ADMIN") {
    log().warn({ chatbotId, adminId: identity.id, role: identity.role }, "bookly admin session rejected: not an ADMIN")
    throw new AppError(403, "Only a Bookly ADMIN can use this assistant.")
  }
  if (!identity.is_active) {
    log().warn({ chatbotId, adminId: identity.id }, "bookly admin session rejected: account deactivated")
    throw new AppError(403, "This account has been deactivated.")
  }

  return { id: identity.id, email: identity.email, name: identity.name }
}
