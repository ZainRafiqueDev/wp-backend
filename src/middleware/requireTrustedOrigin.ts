import type { NextFunction, Request, Response } from "express"

import { env } from "../env.js"
import { accessTokenFromCookie, refreshTokenFromCookie } from "../lib/authCookies.js"
import { adminTokenFromCookie } from "./requireAdminAuth.js"

// CSRF defense for cookie-authenticated requests.
//
// In production the auth cookies are SameSite=None (the frontend and API live
// on unrelated domains, see src/lib/authCookies.ts), so a browser attaches them
// to cross-site requests too. CORS keeps an attacker's page from *reading*
// responses, but "simple" requests (form posts, multipart uploads, body-less
// POSTs like logout) are still *sent* with the cookies and take effect. So any
// state-changing request that carries an auth cookie must come from the
// frontend's own origin.
//
// Requests without an auth cookie (Bearer-token API clients, the public widget,
// signed webhooks) are not CSRF-able and pass through untouched.

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

function trustedOrigin(): string {
  return new URL(env.frontendUrl).origin
}

function requestOrigin(req: Request): string | null {
  const origin = req.headers.origin
  if (typeof origin === "string" && origin !== "null") return origin
  // Fall back to Referer for the rare browser/privacy setting that omits
  // Origin; with neither present the request is refused.
  const referer = req.headers.referer
  if (typeof referer === "string") {
    try {
      return new URL(referer).origin
    } catch {
      return null
    }
  }
  return null
}

export function requireTrustedOrigin(req: Request, res: Response, next: NextFunction) {
  if (SAFE_METHODS.has(req.method)) return next()
  // CS-11: the admin session cookie (requireAdminAuth.ts) is SameSite=None in
  // production too, so it gets the same origin check.
  if (!accessTokenFromCookie(req) && !refreshTokenFromCookie(req) && !adminTokenFromCookie(req)) return next()

  if (requestOrigin(req) === trustedOrigin()) return next()

  return res.status(403).json({ ok: false, error: "Request origin not allowed." })
}
