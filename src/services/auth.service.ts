import { createHash } from "node:crypto"

import type { PoolClient } from "pg"

import {
  accessTokenExpiresAt,
  generateOAuthNonce,
  generateRefreshToken,
  OAUTH_STATE_TTL_SECONDS,
  hashPassword,
  hashRefreshToken,
  refreshTokenExpiresAt,
  revokeAllUserSessions,
  revokeAllUserSessionsInTransaction,
  signAccessToken,
  signOAuthState,
  verifyAccessToken,
  verifyAccessTokenClaims,
  verifyOAuthState,
  verifyPassword,
} from "../lib/auth.js"
import { chatbotRowToChatbot, type Chatbot } from "../lib/chatbot.js"
import { pool } from "../lib/db.js"
import { cacheRedis } from "../lib/redis.js"
import { AppError } from "../lib/errors.js"
import { log } from "../lib/logger.js"
import { env, hasGoogleOAuth } from "../env.js"
import type { LoginInput, SignupInput } from "../validators/auth.validator.js"
import { createNotification, generateOpaqueToken, hashToken, issueEmailVerification } from "./notification.service.js"
import { sendEmail } from "../lib/email.js"
import { setTenantContext } from "../lib/tenantContext.js"
import { getActiveMembership } from "../lib/tenancy.js"
import { removeMembershipsOfUnverifiedAccount } from "./workspaceMembers.service.js"

type UserRow = {
  id: string
  email: string
  name: string
  password_hash: string | null
  is_active?: boolean
}


function assertAccountActive(isActive: boolean | undefined): void {
  if (isActive === false) {
    throw new AppError(403, "This account has been deactivated. Contact support if you believe this is a mistake.")
  }
}

type PublicUser = {
  id: string
  email: string
  name: string
  emailVerified: boolean
  autoPurchaseEnabled: boolean
  autoPurchaseModel: "anthropic" | "openai" | "gemini" | null
  chatbots: Chatbot[]
  // Phase 2 (2026-10-27). isOwner is `false` only for a workspace member
  // acting on someone else's account — the vast majority of users (no
  // membership row at all) are always the owner of their own workspace.
  workspace: { role: "owner" | "admin" | "viewer"; isOwner: boolean }
}

function requireDbPool() {
  if (!pool) {
    throw new AppError(503, "Database is not configured. Set DATABASE_URL and JWT_SECRET.")
  }
  return pool
}

async function loadPublicUser(db: ReturnType<typeof requireDbPool>, actorUserId: string): Promise<PublicUser> {
  // Identity (id/email/name/verification/auto-purchase) is always the
  // actor's own — never the resolved tenant. Only the chatbots list (what
  // the dashboard actually renders and switches between) comes from the
  // workspace the actor belongs to, so a member sees the owner's chatbots
  // instead of their own empty list.
  const { rows: userRows } = await db.query<{
    id: string
    email: string
    name: string
    password_hash: string | null
    email_verified: boolean
    auto_purchase_enabled: boolean
    auto_purchase_model: string | null
  }>(
    `select id, email, name, password_hash, email_verified, auto_purchase_enabled, auto_purchase_model
     from users where id = $1`,
    [actorUserId],
  )
  const user = userRows[0]
  if (!user) throw new AppError(401, "Please sign in again.")

  const membership = await getActiveMembership(actorUserId)
  const tenantUserId = membership ? membership.ownerUserId : actorUserId
  if (membership) setTenantContext({ scope: "user", userId: tenantUserId })

  const { rows: chatbotRows } = await db.query(
    "select id, name, sources, theme, allowed_domain, created_at, status, status_reason, fallback_message, preferred_model, website_url " +
      "from chatbots where user_id = $1 order by created_at asc",
    [tenantUserId],
  )

  const model = user.auto_purchase_model
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    emailVerified: Boolean(user.email_verified),
    workspace: membership ? { role: membership.role, isOwner: false } : { role: "owner", isOwner: true },
    autoPurchaseEnabled: Boolean(user.auto_purchase_enabled),
    autoPurchaseModel:
      model === "anthropic" || model === "openai" || model === "gemini" ? model : null,
    chatbots: chatbotRows.map(chatbotRowToChatbot),
  }
}

type Queryable = { query: ReturnType<typeof requireDbPool>["query"] }
type DbClient = PoolClient

function clientFingerprint(userAgent: string | undefined): string | null {
  return userAgent ? createHash("sha256").update(userAgent).digest("hex") : null
}

/**
 * CS-11: runs `fn` in a transaction holding the users row lock, the lock that
 * refresh and every revocation path take, so session-creating and
 * session-ending work on one account never interleave.
 */
async function withUserLock<T>(
  db: ReturnType<typeof requireDbPool>,
  userId: string,
  fn: (client: DbClient, user: { password_hash: string | null; is_active: boolean } | undefined) => Promise<T>,
): Promise<T> {
  const client = await db.connect()
  try {
    await client.query("begin")
    const { rows } = await client.query<{ password_hash: string | null; is_active: boolean }>(
      "select password_hash, is_active from users where id = $1 for update",
      [userId],
    )
    const result = await fn(client, rows[0])
    await client.query("commit")
    return result
  } catch (err) {
    await client.query("rollback").catch(() => undefined)
    throw err
  } finally {
    client.release()
  }
}

// CS-11: every sign-in gets a session id (refresh_tokens.session_id) that
// survives refresh rotation and is embedded in the access token as `sid`, so
// deleting the session's refresh token (logout) also kills its access tokens.
async function issueSession(db: Queryable, userId: string, sessionId?: string, userAgent?: string) {
  const refreshToken = generateRefreshToken()

  // created_at uses the database clock and doubles as the access token's
  // iat_ms, so it is compared with tokens_valid_after on one clock.
  // client_fingerprint (sha256 of the User-Agent, never the raw value) lets
  // refresh tell a second tab of the same browser from a different client.
  const { rows } = await db.query<{ session_id: string; created_at: Date }>(
    `insert into refresh_tokens (user_id, token_hash, expires_at, session_id, created_at, client_fingerprint)
     values ($1, $2, $3, coalesce($4::uuid, gen_random_uuid()), clock_timestamp(), $5)
     returning session_id, created_at`,
    [userId, hashRefreshToken(refreshToken), refreshTokenExpiresAt(), sessionId ?? null, clientFingerprint(userAgent)],
  )
  const accessToken = signAccessToken(userId, rows[0].session_id, rows[0].created_at)

  return {
    session: {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: accessTokenExpiresAt(),
    },
  }
}

export async function signup(input: SignupInput, userAgent?: string) {
  const db = requireDbPool()
  setTenantContext({ scope: "auth", userEmail: input.email.toLowerCase() })

  const passwordHash = await hashPassword(input.password)

  let userId: string
  try {
    const { rows } = await db.query<{ id: string }>(
      "insert into users (email, password_hash, name, email_verified) values ($1, $2, $3, false) returning id",
      [input.email.toLowerCase(), passwordHash, input.name],
    )
    userId = rows[0].id
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AppError(409, "An account with this email already exists.")
    }
    throw err
  }

  setTenantContext({ scope: "user", userId })
  await issueEmailVerification(userId, input.email.toLowerCase())

  const user = await loadPublicUser(db, userId)
  const { session } = await issueSession(db, userId, undefined, userAgent)
  return { user, session, verificationEmailSent: true }
}

export async function verifyEmail(token: string): Promise<PublicUser> {
  const db = requireDbPool()
  const tokenHash = hashToken(token)
  setTenantContext({ scope: "auth", lookupHash: tokenHash })
  const { rows } = await db.query<{ user_id: string; expires_at: Date }>(
    "select user_id, expires_at from email_verification_tokens where token_hash = $1",
    [tokenHash],
  )
  const row = rows[0]
  if (!row || row.expires_at.getTime() < Date.now()) {
    throw new AppError(400, "That verification link is invalid or has expired. Request a new one.")
  }

  setTenantContext({ scope: "user", userId: row.user_id })
  await db.query("update users set email_verified = true where id = $1", [row.user_id])
  await db.query("delete from email_verification_tokens where user_id = $1", [row.user_id])
  await createNotification({
    userId: row.user_id,
    type: "system",
    title: "Email verified",
    body: "Your email is verified. You can create chatbots and use the full dashboard.",
  })
  return loadPublicUser(db, row.user_id)
}

export async function resendVerification(accessToken: string): Promise<{ sent: boolean }> {
  const db = requireDbPool()
  const userId = verifyAccessToken(accessToken)
  if (!userId) throw new AppError(401, "Please sign in again.")
  setTenantContext({ scope: "user", userId })

  const { rows } = await db.query<{ email: string; email_verified: boolean }>(
    "select email, email_verified from users where id = $1",
    [userId],
  )
  const row = rows[0]
  if (!row) throw new AppError(404, "Account not found.")
  if (row.email_verified) return { sent: false }

  await issueEmailVerification(userId, row.email)
  return { sent: true }
}

/** Always returns ok — does not reveal whether the email exists. */
export async function requestPasswordReset(email: string): Promise<{ ok: true }> {
  const db = requireDbPool()
  const normalized = email.toLowerCase().trim()
  setTenantContext({ scope: "auth", userEmail: normalized })
  const { rows } = await db.query<{ id: string; email: string; password_hash: string | null; is_active: boolean }>(
    "select id, email, password_hash, is_active from users where email = $1",
    [normalized],
  )
  const row = rows[0]
  // Only password accounts get a reset mail. Google-only accounts have no password_hash.
  if (row?.password_hash && row.is_active !== false) {
    const token = generateOpaqueToken()
    const expires = new Date(Date.now() + env.passwordResetTtlMinutes * 60 * 1000)
    setTenantContext({ scope: "user", userId: row.id })
    await db.query("delete from password_reset_tokens where user_id = $1", [row.id])
    await db.query(
      `insert into password_reset_tokens (user_id, token_hash, expires_at) values ($1, $2, $3)`,
      [row.id, hashToken(token), expires],
    )
    const link = `${env.frontendUrl.replace(/\/$/, "")}/auth/reset-password?token=${token}`
    const minutes = env.passwordResetTtlMinutes
    await sendEmail({
      to: row.email,
      subject: "Reset your ChatMate360 password",
      text: `Reset your password using this link (expires in ${minutes} minutes):\n\n${link}\n\nIf you didn't request this, you can ignore this email.`,
      html: `<p>Reset your password (link expires in ${minutes} minutes):</p><p><a href="${link}">Reset password</a></p><p>If you didn't request this, you can ignore this email.</p>`,
    })
  }
  return { ok: true }
}

export async function resetPassword(token: string, newPassword: string): Promise<{ ok: true }> {
  const db = requireDbPool()
  const tokenHash = hashToken(token)
  setTenantContext({ scope: "auth", lookupHash: tokenHash })
  const { rows } = await db.query<{ id: string; user_id: string; expires_at: Date; used_at: Date | null }>(
    "select id, user_id, expires_at, used_at from password_reset_tokens where token_hash = $1",
    [tokenHash],
  )
  const row = rows[0]
  if (!row || row.used_at || row.expires_at.getTime() < Date.now()) {
    throw new AppError(400, "That reset link is invalid or has expired. Request a new one.")
  }

  setTenantContext({ scope: "user", userId: row.user_id })
  // Audit 2026-11-27: claim the token atomically before changing anything, so
  // two concurrent requests with the same link can't both reset the password.
  const claimed = await db.query(
    "update password_reset_tokens set used_at = now() where id = $1 and used_at is null and expires_at > now() returning id",
    [row.id],
  )
  if (claimed.rowCount !== 1) {
    throw new AppError(400, "That reset link is invalid or has expired. Request a new one.")
  }
  const passwordHash = await hashPassword(newPassword)
  await db.query("update users set password_hash = $1 where id = $2", [passwordHash, row.user_id])
  await db.query("delete from password_reset_tokens where user_id = $1 and id <> $2", [row.user_id, row.id])
  // Invalidate existing sessions so a stolen old password session can't
  // linger: refresh tokens and (CS-11) every access token issued before now.
  await revokeAllUserSessions(db, row.user_id)
  await createNotification({
    userId: row.user_id,
    type: "system",
    title: "Password updated",
    body: "Your password was changed. If you didn't do this, contact support immediately.",
  })
  return { ok: true }
}

export async function setAutoPurchase(
  accessToken: string,
  input: { enabled: boolean; model?: "anthropic" | "openai" | "gemini" },
): Promise<PublicUser> {
  const db = requireDbPool()
  const userId = verifyAccessToken(accessToken)
  if (!userId) throw new AppError(401, "Please sign in again.")
  setTenantContext({ scope: "user", userId })

  const model = input.enabled ? input.model || "openai" : null
  await db.query(
    `update users set auto_purchase_enabled = $1, auto_purchase_model = $2 where id = $3`,
    [input.enabled, model, userId],
  )
  await createNotification({
    userId,
    type: "auto_purchase",
    title: input.enabled ? "Auto-purchase enabled" : "Auto-purchase disabled",
    body: input.enabled
      ? `When this account hits a usage limit, ChatMate360 will try to buy a ${model} top-up using your saved card.`
      : "Usage top-ups will only happen when you buy them manually.",
    metadata: { enabled: input.enabled, model },
  })
  return loadPublicUser(db, userId)
}

export async function login(input: LoginInput, userAgent?: string) {
  const db = requireDbPool()
  setTenantContext({ scope: "auth", userEmail: input.email.toLowerCase() })

  const { rows } = await db.query<UserRow>(
    "select id, email, name, password_hash, is_active from users where email = $1",
    [input.email.toLowerCase()],
  )
  const row = rows[0]
  if (!row || !row.password_hash) {
    throw new AppError(401, "Invalid email or password.")
  }

  const valid = await verifyPassword(input.password, row.password_hash)
  if (!valid) {
    throw new AppError(401, "Invalid email or password.")
  }

  assertAccountActive(row.is_active)

  setTenantContext({ scope: "user", userId: row.id })
  // CS-11: bcrypt takes long enough for a password reset, Google takeover or
  // deactivation to land between reading the hash and issuing the session.
  // Issue it under the users row lock, and only if the hash we verified is
  // still the current one and the account is still active; any revocation
  // that commits afterwards deletes this session like any other.
  const { session } = await withUserLock(db, row.id, async (client, current) => {
    if (!current || current.password_hash !== row.password_hash) {
      throw new AppError(401, "Invalid email or password.")
    }
    assertAccountActive(current.is_active)
    return issueSession(client, row.id, undefined, userAgent)
  })
  const user = await loadPublicUser(db, row.id)
  return { user, session }
}

export async function getMe(accessToken: string) {
  const db = requireDbPool()
  const userId = verifyAccessToken(accessToken)
  if (!userId) throw new AppError(401, "Please sign in again.")
  setTenantContext({ scope: "user", userId })
  return loadPublicUser(db, userId)
}

// CS-11: a rotated refresh token presented again within this window is
// treated as a benign race (two tabs refreshing at once) and just refused;
// after it, as reuse of a stolen token, which ends the whole session.
const REFRESH_REUSE_GRACE_SECONDS = 30
// Rotated rows are kept this long for reuse detection, then pruned.
const ROTATED_REFRESH_RETENTION_DAYS = 7

export async function refreshSession(refreshToken: string, userAgent?: string) {
  const db = requireDbPool()
  const tokenHash = hashRefreshToken(refreshToken)
  setTenantContext({ scope: "auth", lookupHash: tokenHash })

  const { rows } = await db.query<{ user_id: string }>(
    "select user_id from refresh_tokens where token_hash = $1",
    [tokenHash],
  )
  const found = rows[0]
  if (!found) throw new AppError(401, "Please sign in again.")
  const userId = found.user_id
  setTenantContext({ scope: "user", userId })

  // Rotate: mark the used token rotated and issue a new one, so a
  // leaked-and-reused refresh token doesn't stay valid indefinitely. CS-11:
  // everything below runs in one transaction that first locks the users row,
  // the same lock revokeAllUserSessions takes, so a refresh and a revocation
  // (password reset, logout-all, deactivation, account link) are serialized:
  // either this commits first and the revocation deletes the new token, or
  // the revocation commits first and the presented token is gone (or older
  // than tokens_valid_after) when re-read under the lock. Requests carrying
  // this session's current access token never see the session missing
  // mid-rotation.
  const client = await db.connect()
  let session: Awaited<ReturnType<typeof issueSession>>["session"] | null = null
  let refusal: "revoked" | "reuse" | "reuse_in_grace" | null = null
  try {
    await client.query("begin")
    const { rows: userRows } = await client.query<{ is_active: boolean; tokens_valid_after: Date | null }>(
      "select is_active, tokens_valid_after from users where id = $1 for update",
      [userId],
    )
    const { rows: tokenRows } = await client.query<{
      session_id: string
      expires_at: Date
      created_at: Date
      rotated_at: Date | null
      in_grace: boolean
      client_fingerprint: string | null
    }>(
      `select session_id, expires_at, created_at, rotated_at, client_fingerprint,
              (rotated_at is not null and rotated_at > clock_timestamp() - make_interval(secs => $2)) as in_grace
         from refresh_tokens where token_hash = $1 for update`,
      [tokenHash, REFRESH_REUSE_GRACE_SECONDS],
    )
    const user = userRows[0]
    const token = tokenRows[0]

    if (!user || !token) {
      refusal = "revoked"
    } else if (token.rotated_at) {
      // Within the grace window a reuse is normally two tabs of one browser
      // refreshing together: the tab that lost the race presents the token
      // its sibling just exchanged. Compare the presenting client with the
      // client that RECEIVED the replacement token at rotation (the earliest
      // row of the session issued at or after this token's rotation). If they
      // differ, someone else exchanged it first (a thief racing the real
      // client, or the reverse), so treat it as theft. IP is not compared: it
      // changes legitimately (mobile, VPN, dual-stack) far more often than
      // the User-Agent does.
      const { rows: successorRows } = await client.query<{ client_fingerprint: string | null }>(
        `select client_fingerprint from refresh_tokens
          where user_id = $1 and session_id = $2 and created_at >= $3
          order by created_at asc limit 1`,
        [userId, token.session_id, token.rotated_at],
      )
      const successorFingerprint = successorRows[0]?.client_fingerprint ?? null
      const presented = clientFingerprint(userAgent)
      const differentClient = Boolean(successorFingerprint && presented !== successorFingerprint)
      if (!token.in_grace || differentClient) {
        // Reuse of an already-exchanged token: whoever holds it is not the
        // legitimate client (or the legitimate client lost a race to a thief).
        // End the session for everyone holding it.
        await client.query("delete from refresh_tokens where user_id = $1 and session_id = $2", [userId, token.session_id])
        refusal = "reuse"
      } else {
        refusal = "reuse_in_grace"
      }
    } else if (
      user.is_active === false ||
      token.expires_at.getTime() < Date.now() ||
      (user.tokens_valid_after && token.created_at.getTime() < user.tokens_valid_after.getTime())
    ) {
      // Deactivated account, expired token, or a token from before the last
      // revocation: end this session.
      await client.query("delete from refresh_tokens where user_id = $1 and session_id = $2", [userId, token.session_id])
      refusal = "revoked"
    } else {
      await client.query("update refresh_tokens set rotated_at = clock_timestamp() where token_hash = $1", [tokenHash])
      await client.query(
        `delete from refresh_tokens
          where user_id = $1 and session_id = $2
            and rotated_at < clock_timestamp() - make_interval(days => $3)`,
        [userId, token.session_id, ROTATED_REFRESH_RETENTION_DAYS],
      )
      ;({ session } = await issueSession(client, userId, token.session_id, userAgent))
    }
    await client.query("commit")
  } catch (err) {
    await client.query("rollback").catch(() => undefined)
    throw err
  } finally {
    client.release()
  }

  // Security events; no token values are logged.
  if (refusal === "reuse") {
    log().warn({ event: "auth.refresh_token_reuse", userId, sessionRevoked: true }, "Rotated refresh token presented again; session revoked")
  } else if (refusal === "reuse_in_grace") {
    log().warn(
      { event: "auth.refresh_token_reuse", userId, sessionRevoked: false, withinGraceSeconds: REFRESH_REUSE_GRACE_SECONDS },
      "Rotated refresh token presented again by the same client within the grace window; refused",
    )
  }
  if (!session) throw new AppError(401, "Please sign in again.")

  const user = await loadPublicUser(db, userId)
  return { user, session }
}

/**
 * Ends one session server-side: every refresh token of the session named by
 * the refresh token (cookie or body) and/or by the access token's sid, which
 * covers a client that only still holds the access cookie. Either way the
 * session's access tokens stop working immediately (requireAuth checks the
 * session).
 */
export async function logout(refreshToken: string, accessToken = "") {
  const db = requireDbPool()
  const sessions: { userId: string; sessionId: string }[] = []
  if (refreshToken) {
    const tokenHash = hashRefreshToken(refreshToken)
    setTenantContext({ scope: "auth", lookupHash: tokenHash })
    const { rows } = await db.query<{ user_id: string; session_id: string }>(
      "select user_id, session_id from refresh_tokens where token_hash = $1",
      [tokenHash],
    )
    if (rows[0]) sessions.push({ userId: rows[0].user_id, sessionId: rows[0].session_id })
  }
  const claims = verifyAccessTokenClaims(accessToken)
  if (claims?.sessionId) sessions.push({ userId: claims.userId, sessionId: claims.sessionId })

  // CS-11: under the users row lock, like every revocation, so a refresh of
  // this session that is in flight either commits first (and its new token
  // is deleted here) or runs after and finds the session gone.
  for (const { userId, sessionId } of sessions) {
    setTenantContext({ scope: "user", userId })
    await withUserLock(db, userId, async (client) => {
      await client.query("delete from refresh_tokens where user_id = $1 and session_id = $2", [userId, sessionId])
    })
  }
}

/** CS-11: sign out everywhere: every refresh token and every access token issued so far. */
export async function logoutAll(accessToken: string): Promise<void> {
  const db = requireDbPool()
  const userId = verifyAccessToken(accessToken)
  if (!userId) throw new AppError(401, "Please sign in again.")
  setTenantContext({ scope: "user", userId })
  await revokeAllUserSessions(db, userId)
}

function requireGoogleConfigured() {
  if (!hasGoogleOAuth) {
    throw new AppError(
      503,
      "Google sign-in isn't set up yet. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI, or use email instead.",
    )
  }
}


// The backend URL the browser is sent to (top-level navigation) to begin the
// Google flow. It has to be the API's own origin, not Google's: that request
// is where the browser-binding state cookie gets set (first-party, so
// SameSite=Lax applies and third-party cookie blocking doesn't). Derived from
// GOOGLE_REDIRECT_URI (".../auth/google/callback" -> ".../auth/google/start")
// so no new setting is needed and any proxy prefix is preserved.
function googleStartUrl(): string {
  const url = new URL(env.googleRedirectUri)
  if (!/\/callback\/?$/.test(url.pathname)) {
    throw new AppError(503, "Google sign-in is misconfigured: GOOGLE_REDIRECT_URI must end in /auth/google/callback.")
  }
  url.pathname = url.pathname.replace(/\/callback\/?$/, "/start")
  url.search = ""
  url.hash = ""
  return url.toString()
}

/** POST /auth/google — returns the URL the frontend navigates to (contract unchanged: `{ ok, url }`). */
export async function startGoogleOAuth(): Promise<string> {
  requireGoogleConfigured()
  return googleStartUrl()
}

/**
 * GET /auth/google/start — mints a fresh nonce (the controller stores it in a
 * short-lived httpOnly cookie) and returns Google's authorization URL whose
 * `state` is bound to that nonce.
 */
export function beginGoogleOAuth(): { nonce: string; authorizationUrl: string } {
  requireGoogleConfigured()
  const nonce = generateOAuthNonce()
  const params = new URLSearchParams({
    client_id: env.googleClientId,
    redirect_uri: env.googleRedirectUri,
    response_type: "code",
    scope: "openid email profile",
    access_type: "online",
    prompt: "select_account",
    state: signOAuthState(nonce),
  })
  return { nonce, authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` }
}

// Each state is accepted once. The controller also clears the nonce cookie on
// every callback attempt; this server-side marker covers a replay that still
// carries the cookie. Fails closed if Redis is unreachable.
async function consumeOAuthState(jti: string): Promise<void> {
  let result: string | null
  try {
    result = await cacheRedis.set(`oauth:google:state:${jti}`, "1", "EX", OAUTH_STATE_TTL_SECONDS, "NX")
  } catch {
    throw new AppError(503, "Google sign-in is temporarily unavailable. Try again in a moment.")
  }
  if (result !== "OK") {
    throw new AppError(401, "That sign-in link expired or is invalid. Try again.")
  }
}

interface GoogleTokenResponse {
  access_token?: string
  id_token?: string
  error?: string
  error_description?: string
}

interface GoogleUserInfo {
  sub: string
  email?: string
  email_verified?: boolean
  name?: string
}

async function exchangeGoogleCode(code: string): Promise<GoogleTokenResponse> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.googleClientId,
      client_secret: env.googleClientSecret,
      redirect_uri: env.googleRedirectUri,
      grant_type: "authorization_code",
    }),
  })
  const data = (await res.json()) as GoogleTokenResponse
  if (!res.ok || data.error) {
    throw new AppError(401, data.error_description || "Google sign-in failed. Try again.")
  }
  return data
}

async function fetchGoogleUserInfo(accessToken: string): Promise<GoogleUserInfo> {
  const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new AppError(401, "Google sign-in failed. Try again.")
  return (await res.json()) as GoogleUserInfo
}


// Linking Google to an account found by email.
//
// Verified account: the password holder already proved they own the address,
// so just attach google_id (existing behaviour; password and sessions kept).
//
// Unverified account: nobody has proved they own the address — it may have
// been pre-registered by an attacker who now knows its password. Google has
// just proved the *current* user owns it, so they win: link, mark verified,
// and in the same transaction wipe the password hash and revoke every refresh
// token and outstanding reset/verification token, so whatever credentials and
// sessions the pre-registrant held stop working. Chosen over refusing the
// link because refusing leaves the real owner unable to use Google at all and
// still facing an account whose password someone else may know.
async function linkGoogleToExistingAccount(
  db: ReturnType<typeof requireDbPool>,
  userId: string,
  googleId: string,
): Promise<void> {
  const client = await db.connect()
  try {
    await client.query("begin")
    const { rows } = await client.query<{ email_verified: boolean }>(
      "select email_verified from users where id = $1 for update",
      [userId],
    )
    if (rows[0]?.email_verified) {
      await client.query("update users set google_id = $1 where id = $2", [googleId, userId])
    } else {
      await client.query(
        "update users set google_id = $1, email_verified = true, password_hash = null where id = $2",
        [googleId, userId],
      )
      // CS-11: revokeAllUserSessions also retires every access token issued so
      // far (the pre-registrant's included), not just the refresh tokens; and
      // workspace access the unverified account handed out or obtained is
      // removed so it can't outlive the takeover.
      await revokeAllUserSessionsInTransaction(client, userId)
      await removeMembershipsOfUnverifiedAccount(client, userId)
      await client.query("delete from password_reset_tokens where user_id = $1", [userId])
      await client.query("delete from email_verification_tokens where user_id = $1", [userId])
    }
    await client.query("commit")
  } catch (err) {
    await client.query("rollback").catch(() => undefined)
    throw err
  } finally {
    client.release()
  }
}

async function findOrCreateGoogleUser(
  db: ReturnType<typeof requireDbPool>,
  profile: GoogleUserInfo,
): Promise<string> {
  if (!profile.email || !profile.email_verified) {
    throw new AppError(401, "Your Google account needs a verified email to sign in.")
  }
  const email = profile.email.toLowerCase()
  const name = profile.name || email.split("@")[0]
  setTenantContext({ scope: "auth", userEmail: email, googleId: profile.sub })

  const { rows: byGoogleId } = await db.query<{ id: string; is_active: boolean }>(
    "select id, is_active from users where google_id = $1",
    [profile.sub],
  )
  if (byGoogleId[0]) {
    assertAccountActive(byGoogleId[0].is_active)
    setTenantContext({ scope: "user", userId: byGoogleId[0].id })
    await db.query("update users set email_verified = true where id = $1 and email_verified = false", [byGoogleId[0].id])
    return byGoogleId[0].id
  }

  const { rows: byEmail } = await db.query<{ id: string; is_active: boolean }>(
    "select id, is_active from users where email = $1",
    [email],
  )
  if (byEmail[0]) {
    assertAccountActive(byEmail[0].is_active)
    setTenantContext({ scope: "user", userId: byEmail[0].id })
    await linkGoogleToExistingAccount(db, byEmail[0].id, profile.sub)
    return byEmail[0].id
  }

  const { rows: created } = await db.query<{ id: string }>(
    "insert into users (email, google_id, name, email_verified) values ($1, $2, $3, true) returning id",
    [email, profile.sub, name],
  )
  setTenantContext({ scope: "user", userId: created[0].id })
  return created[0].id
}

export async function completeGoogleOAuthCallback(
  code: string,
  state: string,
  stateNonce: string,
  userAgent?: string,
): Promise<{ redirectUrl: string; session: { access_token: string; refresh_token: string; expires_at: number } }> {
  requireGoogleConfigured()

  // stateNonce comes from the httpOnly cookie set by GET /auth/google/start in
  // this same browser; a missing or mismatched cookie means the flow was not
  // started here (login CSRF) and is refused before the code is exchanged.
  const verified = verifyOAuthState(state, stateNonce)
  if (!verified) {
    throw new AppError(401, "That sign-in link expired or is invalid. Try again.")
  }
  await consumeOAuthState(verified.jti)

  const db = requireDbPool()
  const tokens = await exchangeGoogleCode(code)
  if (!tokens.access_token) throw new AppError(401, "Google sign-in failed. Try again.")

  const profile = await fetchGoogleUserInfo(tokens.access_token)
  const userId = await findOrCreateGoogleUser(db, profile)
  const { session } = await issueSession(db, userId, undefined, userAgent)

  // No longer puts tokens in the redirect URL's hash fragment — the
  // controller sets them as httpOnly cookies before redirecting instead
  // (see setAuthCookies in src/lib/authCookies.ts). A URL fragment is
  // readable by any script on the page and can linger in browser history;
  // an httpOnly cookie is neither.
  return {
    redirectUrl: `${env.frontendUrl.replace(/\/$/, "")}/auth/callback`,
    session,
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === "23505"
}
