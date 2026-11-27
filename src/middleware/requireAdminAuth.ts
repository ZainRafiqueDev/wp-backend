import type { NextFunction, Request, Response } from "express"

import { env } from "../env.js"
import { issuedBeforeWatermark, verifyAdminAccessTokenClaims } from "../lib/auth.js"
import { pool } from "../lib/db.js"
import { setTenantContext } from "../lib/tenantContext.js"

// CS-11: the admin session travels in its own httpOnly cookie instead of a
// bearer JWT the admin UI kept in sessionStorage (readable by any script on
// the page). Same cross-site reasoning as the dashboard cookies in
// lib/authCookies.ts: in production the admin UI (Vercel) and the API
// (Railway) are different sites, so the cookie must be SameSite=None, which
// browsers only accept with Secure. Local dev is plain-HTTP localhost
// (same-site), so it is Lax without Secure.
//
// Production name uses the `__Host-` prefix: browsers then only accept the
// cookie if it is Secure, Path=/ and has no Domain attribute, so a sibling
// subdomain can never plant or overwrite it. That matches how we set it
// (host-only on the API origin, Path=/), and SameSite=None is compatible with
// the prefix. Dev cannot use it because dev cookies are not Secure.
//
// CSRF: SameSite=None means the browser also attaches the cookie to
// cross-site requests, so requireTrustedOrigin treats this cookie like the
// dashboard ones and refuses state-changing requests from any origin but
// FRONTEND_URL.
const isProduction = env.nodeEnv === "production"

export const ADMIN_ACCESS_COOKIE = isProduction ? "__Host-chatmate360_admin_token" : "chatmate360_admin_token"

function adminCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: (isProduction ? "none" : "lax") as "none" | "lax",
    path: "/",
    maxAge: maxAgeSeconds * 1000,
  }
}

export function setAdminAuthCookie(res: Response, token: string): void {
  res.cookie(ADMIN_ACCESS_COOKIE, token, adminCookieOptions(env.adminAccessTokenTtlSeconds))
}

export function clearAdminAuthCookie(res: Response): void {
  res.clearCookie(ADMIN_ACCESS_COOKIE, adminCookieOptions(0))
}

export function adminTokenFromCookie(req: Request): string {
  const value = (req as Request & { cookies?: Record<string, string> }).cookies?.[ADMIN_ACCESS_COOKIE]
  return typeof value === "string" ? value : ""
}

/**
 * CS-11: the admin session is read from the httpOnly admin cookie only. The
 * old Authorization: Bearer path is gone: /admin/login no longer returns a
 * token, the migration retired every admin token issued before the deploy,
 * and nothing else (scripts, other services) sends admin bearer tokens. The
 * dashboard's own access cookie is never read here.
 */
export function getAdminToken(req: Request): string {
  return adminTokenFromCookie(req)
}

const ADMIN_SIGN_IN_REQUIRED = { ok: false, error: "Admin sign-in required." }

// Cache-free for the same reason as requireAuth: admin logout and credential
// changes must take effect on the very next request.
export async function requireAdminAuth(req: Request, res: Response, next: NextFunction) {
  const claims = verifyAdminAccessTokenClaims(getAdminToken(req))
  if (!claims) {
    return res.status(401).json(ADMIN_SIGN_IN_REQUIRED)
  }
  const { adminUserId } = claims
  setTenantContext({ scope: "admin", adminUserId })

  if (!pool) {
    // requireDb answers 503 further down the chain; there is no role to read.
    req.adminUserId = adminUserId
    return next()
  }

  try {
    // SA-01: role and is_active are read here on every request (never taken
    // from the token), so a demotion or deactivation applies to the very
    // next request of every existing session.
    const { rows } = await pool.query<{ tokens_valid_after: Date | null; role: string; is_active: boolean }>(
      "select tokens_valid_after, role, is_active from admin_users where id = $1",
      [adminUserId],
    )
    const row = rows[0]
    if (!row || !row.is_active || issuedBeforeWatermark(claims.issuedAtMs, row.tokens_valid_after)) {
      return res.status(401).json(ADMIN_SIGN_IN_REQUIRED)
    }
    req.adminUserId = adminUserId
    req.adminRole = row.role === "super_admin" ? "super_admin" : "admin"
  } catch (err) {
    return next(err)
  }
  next()
}

/**
 * SA-01: must run after requireAdminAuth. Super-admin-only routes answer 403
 * to a signed-in plain admin. The role was read from the database by
 * requireAdminAuth on this same request.
 */
export function requireSuperAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.adminRole !== "super_admin") {
    return res.status(403).json({ ok: false, error: "Super admin access required." })
  }
  next()
}
