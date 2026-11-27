import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

import bcrypt from "bcryptjs"
import jwt from "jsonwebtoken"

import { env } from "../env.js"

const BCRYPT_ROUNDS = 12

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS)
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash)
}

// CS-11: access tokens are short-lived (ACCESS_TOKEN_TTL_SECONDS, default 15
// minutes) and revocable server-side. Besides the standard `iat` (whole
// seconds, set by jsonwebtoken) each token carries:
//   - iat_ms: issue time in milliseconds taken from the DATABASE clock (the
//     refresh_tokens.created_at of the session row, or clock_timestamp() for
//     admin tokens). users.tokens_valid_after / admin_users.tokens_valid_after
//     are also written with the database clock, so the comparison never mixes
//     the clocks of different app instances.
//   - sid (dashboard users): the session the token belongs to
//     (refresh_tokens.session_id). requireAuth rejects a token without one,
//     and rejects it once that session has no live refresh token (logout,
//     revocation, refresh-token reuse).
interface AccessTokenPayload {
  sub: string
  typ: "access"
  iat_ms: number
  sid?: string
}

export function signAccessToken(userId: string, sessionId?: string, issuedAt: Date = new Date()): string {
  const payload: AccessTokenPayload = { sub: userId, typ: "access", iat_ms: issuedAt.getTime() }
  if (sessionId) payload.sid = sessionId
  return jwt.sign(payload, env.jwtSecret, { expiresIn: env.accessTokenTtlSeconds })
}

export type AccessTokenClaims = {
  userId: string
  /** refresh_tokens.session_id; null on tokens minted without a session, which requireAuth rejects. */
  sessionId: string | null
  issuedAtMs: number
}

function tokenIssuedAtMs(decoded: jwt.JwtPayload): number | null {
  if (typeof decoded.iat_ms === "number" && Number.isFinite(decoded.iat_ms)) return decoded.iat_ms
  if (typeof decoded.iat === "number") return decoded.iat * 1000
  return null
}

/** Signature, expiry and type only. Revocation needs the DB (see requireAuth). */
export function verifyAccessTokenClaims(token: string): AccessTokenClaims | null {
  if (!token) return null
  try {
    const decoded = jwt.verify(token, env.jwtSecret, { algorithms: ["HS256"] }) as jwt.JwtPayload
    if (decoded.typ !== "access" || typeof decoded.sub !== "string") return null
    const issuedAtMs = tokenIssuedAtMs(decoded)
    if (issuedAtMs === null) return null
    return { userId: decoded.sub, sessionId: typeof decoded.sid === "string" ? decoded.sid : null, issuedAtMs }
  } catch {
    return null
  }
}

export function verifyAccessToken(token: string): string | null {
  return verifyAccessTokenClaims(token)?.userId ?? null
}

export function accessTokenExpiresAt(): number {
  return Math.floor(Date.now() / 1000) + env.accessTokenTtlSeconds
}

/** True when a token issued at `issuedAtMs` predates the account's revocation watermark (null = never revoked). */
export function issuedBeforeWatermark(issuedAtMs: number, tokensValidAfter: Date | null | undefined): boolean {
  if (!tokensValidAfter) return false
  return issuedAtMs < tokensValidAfter.getTime()
}

interface AdminAccessTokenPayload {
  sub: string
  typ: "admin"
  iat_ms: number
}

/** `issuedAt` should come from the database clock (see adminLogin / revokeAllAdminSessions). */
export function signAdminAccessToken(adminUserId: string, issuedAt: Date = new Date()): string {
  const payload: AdminAccessTokenPayload = { sub: adminUserId, typ: "admin", iat_ms: issuedAt.getTime() }
  return jwt.sign(payload, env.jwtSecret, { expiresIn: env.adminAccessTokenTtlSeconds })
}

export type AdminAccessTokenClaims = { adminUserId: string; issuedAtMs: number }

export function verifyAdminAccessTokenClaims(token: string): AdminAccessTokenClaims | null {
  if (!token) return null
  try {
    const decoded = jwt.verify(token, env.jwtSecret, { algorithms: ["HS256"] }) as jwt.JwtPayload
    if (decoded.typ !== "admin" || typeof decoded.sub !== "string") return null
    const issuedAtMs = tokenIssuedAtMs(decoded)
    if (issuedAtMs === null) return null
    return { adminUserId: decoded.sub, issuedAtMs }
  } catch {
    return null
  }
}

export function verifyAdminAccessToken(token: string): string | null {
  return verifyAdminAccessTokenClaims(token)?.adminUserId ?? null
}

type Queryable = { query: (text: string, values?: unknown[]) => Promise<unknown> }
type Connectable = { connect: () => Promise<Queryable & { release: () => void }> }

/**
 * Revokes every session of a dashboard user, inside the caller's open
 * transaction: locks the users row (refreshSession takes the same lock, so a
 * refresh either commits before this and its new token is deleted here, or
 * runs after and finds its token gone), moves the watermark to the database
 * clock, and deletes every refresh token.
 */
export async function revokeAllUserSessionsInTransaction(client: Queryable, userId: string): Promise<void> {
  await client.query("select 1 from users where id = $1 for update", [userId])
  await client.query("update users set tokens_valid_after = clock_timestamp() where id = $1", [userId])
  await client.query("delete from refresh_tokens where user_id = $1", [userId])
}

/** Same as revokeAllUserSessionsInTransaction, in a transaction of its own. */
export async function revokeAllUserSessions(db: Connectable, userId: string): Promise<void> {
  const client = await db.connect()
  try {
    await client.query("begin")
    await revokeAllUserSessionsInTransaction(client, userId)
    await client.query("commit")
  } catch (err) {
    await client.query("rollback").catch(() => undefined)
    throw err
  } finally {
    client.release()
  }
}

/**
 * Revokes every admin session of one admin account (logout, credential
 * change). Admins have no refresh tokens, so one statement is atomic.
 * Returns the new watermark so a caller can issue a fresh token not older than it.
 */
export async function revokeAllAdminSessions(db: Queryable, adminUserId: string): Promise<Date> {
  const result = (await db.query(
    "update admin_users set tokens_valid_after = clock_timestamp() where id = $1 returning tokens_valid_after",
    [adminUserId],
  )) as { rows: { tokens_valid_after: Date }[] }
  return result.rows[0]?.tokens_valid_after ?? new Date()
}


export function generateRefreshToken(): string {
  return randomBytes(32).toString("hex")
}

export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

export function refreshTokenExpiresAt(): Date {
  return new Date(Date.now() + env.refreshTokenTtlSeconds * 1000)
}

export const OAUTH_STATE_TTL_SECONDS = 600 // 10 minutes — the whole Google redirect round trip

// The OAuth `state` is bound to the browser that started the flow: GET
// /auth/google/start sets a random nonce in a short-lived httpOnly cookie and
// puts sha256(nonce) inside the signed state. The callback only accepts a
// state whose hash matches the cookie the *same* browser carries, so an
// attacker can't hand a victim a callback URL minted in the attacker's own
// browser (login CSRF) — the victim has no matching cookie.
//
// SameSite=Lax (not the None used for the auth cookies): the cookie is set on
// a top-level navigation to the API and read back on Google's top-level
// redirect to the callback, both of which Lax allows, and it never needs to
// ride a cross-site fetch.
export const GOOGLE_OAUTH_STATE_COOKIE = "chatmate360_google_oauth_state"

export function googleOAuthStateCookieOptions(maxAgeSeconds: number = OAUTH_STATE_TTL_SECONDS) {
  return {
    httpOnly: true,
    secure: env.nodeEnv === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: maxAgeSeconds * 1000,
  }
}

export function generateOAuthNonce(): string {
  return randomBytes(32).toString("hex")
}

function hashOAuthNonce(nonce: string): string {
  return createHash("sha256").update(nonce).digest("hex")
}

interface OAuthStatePayload {
  typ: "google_state"
  nh: string
  jti: string
}

export function signOAuthState(nonce: string): string {
  const payload: OAuthStatePayload = {
    typ: "google_state",
    nh: hashOAuthNonce(nonce),
    jti: randomBytes(16).toString("hex"),
  }
  return jwt.sign(payload, env.jwtSecret, { expiresIn: OAUTH_STATE_TTL_SECONDS })
}

/**
 * Returns the state's unique id (for single-use bookkeeping) when the state is
 * genuine, unexpired and bound to `nonce`; null otherwise. A missing nonce
 * (no cookie) never verifies.
 */
export function verifyOAuthState(state: string, nonce: string): { jti: string } | null {
  if (!state || !nonce) return null
  try {
    const decoded = jwt.verify(state, env.jwtSecret, { algorithms: ["HS256"] }) as jwt.JwtPayload
    if (decoded.typ !== "google_state" || typeof decoded.nh !== "string" || typeof decoded.jti !== "string") {
      return null
    }
    const expected = Buffer.from(decoded.nh, "hex")
    const actual = Buffer.from(hashOAuthNonce(nonce), "hex")
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null
    return { jti: decoded.jti }
  } catch {
    return null
  }
}

/** Short-lived proof that Express verified an OTP — not mintable by FastAPI/AI. */
export type OtpProofPurpose = "EMAIL_VERIFY" | "ORDER_ACCESS" | "SENSITIVE_ACTION"

export type OtpProofClaims = {
  purpose: OtpProofPurpose
  email: string
  userId?: string
  chatbotId?: string
  customerId?: string
}

interface OtpProofPayload extends OtpProofClaims {
  typ: "otp_proof"
}

export function signOtpProofToken(claims: OtpProofClaims): string {
  const payload: OtpProofPayload = { typ: "otp_proof", ...claims }
  return jwt.sign(payload, env.jwtSecret, { expiresIn: env.otpProofTtlSeconds })
}

export function verifyOtpProofToken(token: string): OtpProofClaims | null {
  try {
    const decoded = jwt.verify(token, env.jwtSecret, { algorithms: ["HS256"] }) as jwt.JwtPayload
    if (decoded.typ !== "otp_proof" || typeof decoded.email !== "string" || typeof decoded.purpose !== "string") {
      return null
    }
    return {
      purpose: decoded.purpose as OtpProofPurpose,
      email: decoded.email,
      userId: typeof decoded.userId === "string" ? decoded.userId : undefined,
      chatbotId: typeof decoded.chatbotId === "string" ? decoded.chatbotId : undefined,
      customerId: typeof decoded.customerId === "string" ? decoded.customerId : undefined,
    }
  } catch {
    return null
  }
}

/**
 * Widget-side customer session: issued by Express after an OTP proves the
 * visitor controls the customer's email, and bound to one chatbot. The chat
 * endpoint uses it to unlock cross-session memory. A bare customerId is not a
 * credential: it can leak through logs, screenshots or a shared device, and
 * whoever holds it could read that customer's memory through the bot.
 */
export type CustomerSessionClaims = {
  customerId: string
  chatbotId: string
}

interface CustomerSessionPayload extends CustomerSessionClaims {
  typ: "customer_session"
}

export function signCustomerSessionToken(claims: CustomerSessionClaims): string {
  const payload: CustomerSessionPayload = { typ: "customer_session", ...claims }
  return jwt.sign(payload, env.jwtSecret, { expiresIn: env.customerSessionTtlSeconds })
}

export function verifyCustomerSessionToken(token: string): CustomerSessionClaims | null {
  try {
    const decoded = jwt.verify(token, env.jwtSecret, { algorithms: ["HS256"] }) as jwt.JwtPayload
    if (decoded.typ !== "customer_session" || typeof decoded.customerId !== "string" || typeof decoded.chatbotId !== "string") {
      return null
    }
    return { customerId: decoded.customerId, chatbotId: decoded.chatbotId }
  } catch {
    return null
  }
}
