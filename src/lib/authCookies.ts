import type { Request, Response } from "express"

import { env } from "../env.js"

// Auth moved from "frontend stores the token in localStorage and sends it
// as an Authorization: Bearer header" to httpOnly cookies the browser
// attaches automatically — localStorage is readable by any script on the
// page, so a successful XSS anywhere in the frontend could exfiltrate a
// live session; an httpOnly cookie can't be read by JavaScript at all.
//
// This only changes how the token gets from the browser to Express — every
// existing controller/service still receives a plain access-token string
// from getBearerToken() (src/middleware/requireAuth.ts) exactly as before,
// now sourced from a cookie instead of a header. Nothing downstream of that
// function needed to change.
const ACCESS_COOKIE = "chatmate360_access_token"
const REFRESH_COOKIE = "chatmate360_refresh_token"

// Cross-site by default: the deployed frontend (Vercel) and backend
// (Railway) are on unrelated domains (see DEPLOYMENT.md), not subdomains of
// one shared parent domain — a cookie only reaches the backend on a
// cross-site fetch if it's SameSite=None, which itself requires Secure
// (browsers reject None without it). Local dev runs over plain HTTP, where
// Secure cookies are dropped entirely, so it falls back to Lax — that's
// still same-site in local dev (both on localhost) and works without HTTPS.
const isProduction = env.nodeEnv === "production"

function cookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: (isProduction ? "none" : "lax") as "none" | "lax",
    path: "/",
    maxAge: maxAgeSeconds * 1000,
  }
}

export function setAuthCookies(res: Response, session: { access_token: string; refresh_token: string }): void {
  res.cookie(ACCESS_COOKIE, session.access_token, cookieOptions(env.accessTokenTtlSeconds))
  res.cookie(REFRESH_COOKIE, session.refresh_token, cookieOptions(env.refreshTokenTtlSeconds))
}

export function clearAuthCookies(res: Response): void {
  // Options (other than maxAge) must match what the cookie was set with, or
  // browsers won't recognize it as the same cookie to clear.
  res.clearCookie(ACCESS_COOKIE, cookieOptions(0))
  res.clearCookie(REFRESH_COOKIE, cookieOptions(0))
}

export function accessTokenFromCookie(req: Request): string {
  const value = (req as Request & { cookies?: Record<string, string> }).cookies?.[ACCESS_COOKIE]
  return typeof value === "string" ? value : ""
}

export function refreshTokenFromCookie(req: Request): string {
  const value = (req as Request & { cookies?: Record<string, string> }).cookies?.[REFRESH_COOKIE]
  return typeof value === "string" ? value : ""
}
