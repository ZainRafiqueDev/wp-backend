import jwt from "jsonwebtoken"
import { describe, expect, it } from "vitest"

import { env } from "../../src/env.js"
import {
  generateOAuthNonce,
  generateRefreshToken,
  hashPassword,
  hashRefreshToken,
  signAccessToken,
  signOAuthState,
  verifyAccessToken,
  verifyOAuthState,
  verifyPassword,
} from "../../src/lib/auth.js"

describe("password hashing", () => {
  it("verifies a matching password and rejects a wrong one", async () => {
    const hash = await hashPassword("correct horse battery staple")
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true)
    expect(await verifyPassword("wrong password", hash)).toBe(false)
  })

  it("never stores the password in plain text", async () => {
    const hash = await hashPassword("correct horse battery staple")
    expect(hash).not.toContain("correct horse battery staple")
  })
})

describe("access tokens", () => {
  it("signs and verifies a roundtrip", () => {
    const token = signAccessToken("user-123")
    expect(verifyAccessToken(token)).toBe("user-123")
  })

  it("rejects a token signed with the wrong secret", () => {
    const forged = jwt.sign({ sub: "user-123", typ: "access" }, "wrong-secret")
    expect(verifyAccessToken(forged)).toBeNull()
  })

  it("rejects a tampered signature", () => {
    const token = signAccessToken("user-123")
    const tampered = token.slice(0, -4) + (token.at(-4) === "a" ? "b" : "a") + token.slice(-3)
    expect(verifyAccessToken(tampered)).toBeNull()
  })

  it("rejects an expired token", () => {
    const expired = jwt.sign({ sub: "user-123", typ: "access" }, env.jwtSecret, { expiresIn: -10 })
    expect(verifyAccessToken(expired)).toBeNull()
  })

  // The `typ` claim is what stops a refresh token from being replayed as an
  // access token even though both are signed with the same secret — this is
  // a real security property, not incidental.
  it("rejects a token that isn't actually typed 'access'", () => {
    const wrongType = jwt.sign({ sub: "user-123", typ: "google_state" }, env.jwtSecret)
    expect(verifyAccessToken(wrongType)).toBeNull()
  })

  it("rejects garbage input without throwing", () => {
    expect(verifyAccessToken("not-a-jwt-at-all")).toBeNull()
    expect(verifyAccessToken("")).toBeNull()
  })
})

describe("refresh tokens", () => {
  it("generates a random opaque token, not a JWT", () => {
    const token = generateRefreshToken()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
  })

  it("hashes deterministically so a stored hash can be looked up again", () => {
    const token = generateRefreshToken()
    expect(hashRefreshToken(token)).toBe(hashRefreshToken(token))
  })

  it("produces different hashes for different tokens", () => {
    expect(hashRefreshToken(generateRefreshToken())).not.toBe(hashRefreshToken(generateRefreshToken()))
  })
})

describe("OAuth CSRF state", () => {
  const nonce = generateOAuthNonce()

  it("signs and verifies a roundtrip bound to the browser nonce", () => {
    expect(verifyOAuthState(signOAuthState(nonce), nonce)).toEqual({ jti: expect.any(String) })
  })

  it("rejects a state presented without the nonce cookie", () => {
    expect(verifyOAuthState(signOAuthState(nonce), "")).toBeNull()
  })

  it("rejects a state minted for a different browser's nonce", () => {
    expect(verifyOAuthState(signOAuthState(generateOAuthNonce()), nonce)).toBeNull()
  })

  it("rejects garbage state", () => {
    expect(verifyOAuthState("not-a-real-state-token", nonce)).toBeNull()
  })

  it("rejects an expired state token", () => {
    const expired = jwt.sign({ typ: "google_state" }, env.jwtSecret, { expiresIn: -10 })
    expect(verifyOAuthState(expired, nonce)).toBeNull()
  })

  it("rejects a state token of the wrong type", () => {
    const wrongType = jwt.sign({ typ: "access" }, env.jwtSecret)
    expect(verifyOAuthState(wrongType, nonce)).toBeNull()
  })

  it("rejects a legacy unbound state token (no nonce hash)", () => {
    const legacy = jwt.sign({ typ: "google_state" }, env.jwtSecret, { expiresIn: 600 })
    expect(verifyOAuthState(legacy, nonce)).toBeNull()
  })
})
