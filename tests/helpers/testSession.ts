import { generateRefreshToken, hashRefreshToken, refreshTokenExpiresAt, signAccessToken } from "../../src/lib/auth.js"
import { pool } from "../../src/lib/db.js"

/**
 * CS-11: requireAuth only accepts access tokens bound to a live session
 * (refresh_tokens.session_id), so tests that seed a user straight into the
 * database get a real session row and a token for it, the same as a sign-in.
 */
export async function testAccessToken(userId: string): Promise<string> {
  if (!pool) throw new Error("testAccessToken requires a database pool")
  const { rows } = await pool.query<{ session_id: string; created_at: Date }>(
    `insert into refresh_tokens (user_id, token_hash, expires_at, created_at)
     values ($1, $2, $3, clock_timestamp()) returning session_id, created_at`,
    [userId, hashRefreshToken(generateRefreshToken()), refreshTokenExpiresAt()],
  )
  return signAccessToken(userId, rows[0].session_id, rows[0].created_at)
}
