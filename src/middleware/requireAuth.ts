import type { NextFunction, Request, Response } from "express"

import { issuedBeforeWatermark, verifyAccessTokenClaims, type AccessTokenClaims } from "../lib/auth.js"
import { accessTokenFromCookie } from "../lib/authCookies.js"
import { pool } from "../lib/db.js"
import { setTenantContext } from "../lib/tenantContext.js"

// Cookie first (what the frontend now relies on — see lib/authCookies.ts),
// falling back to a bearer header for anything still sending one (a
// non-browser API client, a script, or a request mid-migration). Every
// controller/service downstream just receives a token string either way —
// nothing else needed to change when auth moved off localStorage.
export function getBearerToken(req: Request): string {
  const fromCookie = accessTokenFromCookie(req)
  if (fromCookie) return fromCookie

  const header = req.headers.authorization || ""
  const [scheme, token] = header.split(" ")
  if (scheme !== "Bearer" || !token) return ""
  return token
}

const SIGN_IN_AGAIN = { ok: false, error: "Please sign in again." }

/**
 * CS-11 server-side session check. A signature-valid access token is only
 * accepted while:
 *   - the user still exists and is_active,
 *   - it was issued after users.tokens_valid_after (logout-all, password
 *     reset, Google link of an unverified account, deactivation), and
 *   - it names a session (sid) that still has a live, unrotated refresh
 *     token (logout, revocation and refresh-token reuse delete it). A token
 *     without a sid is rejected: every token issued since CS-11 has one, and
 *     a sid-less token (from an old instance during a rolling deploy, or from
 *     before the deploy) would otherwise survive logout.
 *
 * Deliberately cache-free: one primary-key lookup plus an indexed exists()
 * per authenticated request. A Redis cache would need invalidation on every
 * revocation path and would leave a window (the cache TTL) in which a
 * deactivated user or a logged-out session still works, which is exactly
 * what this check removes. Dashboard traffic is far below the point where a
 * PK lookup matters to Postgres.
 */
export async function isAccessTokenLive(claims: AccessTokenClaims): Promise<boolean> {
  if (!pool || !claims.sessionId) return false
  setTenantContext({ scope: "user", userId: claims.userId })
  const { rows } = await pool.query<{ is_active: boolean; tokens_valid_after: Date | null; session_live: boolean }>(
    `select u.is_active, u.tokens_valid_after,
            exists (
              select 1 from refresh_tokens r
               where r.user_id = u.id and r.session_id = $2::uuid
                 and r.rotated_at is null and r.expires_at > now()
            ) as session_live
       from users u
      where u.id = $1`,
    [claims.userId, claims.sessionId],
  )
  const row = rows[0]
  if (!row || row.is_active === false || !row.session_live) return false
  return !issuedBeforeWatermark(claims.issuedAtMs, row.tokens_valid_after)
}

/**
 * For routes where signing in is optional (POST /leads): the user id when the
 * token is valid AND live (same check as requireAuth), otherwise null.
 */
export async function resolveLiveAccessToken(token: string): Promise<string | null> {
  const claims = verifyAccessTokenClaims(token)
  if (!claims) return null
  return (await isAccessTokenLive(claims)) ? claims.userId : null
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const claims = verifyAccessTokenClaims(getBearerToken(req))
  if (!claims) {
    return res.status(401).json(SIGN_IN_AGAIN)
  }
  // No database configured: requireDb (next in every route chain) answers 503.
  if (!pool) return next()

  try {
    if (!(await isAccessTokenLive(claims))) {
      return res.status(401).json(SIGN_IN_AGAIN)
    }
  } catch (err) {
    return next(err)
  }
  next()
}
