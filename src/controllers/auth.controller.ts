import type { Request, Response } from "express"

import { env } from "../env.js"
import { GOOGLE_OAUTH_STATE_COOKIE, googleOAuthStateCookieOptions } from "../lib/auth.js"
import { clearAuthCookies, refreshTokenFromCookie, setAuthCookies } from "../lib/authCookies.js"
import { AppError } from "../lib/errors.js"
import { asyncHandler } from "../middleware/asyncHandler.js"
import { getBearerToken } from "../middleware/requireAuth.js"
import {
  beginGoogleOAuth,
  completeGoogleOAuthCallback,
  getMe,
  login,
  logout,
  logoutAll,
  refreshSession,
  requestPasswordReset,
  resendVerification,
  resetPassword,
  setAutoPurchase,
  signup,
  startGoogleOAuth,
  verifyEmail,
} from "../services/auth.service.js"
import { sendOtp, verifyOtp } from "../services/otp.service.js"
import type {
  ForgotPasswordInput,
  LoginInput,
  RefreshInput,
  ResetPasswordInput,
  SendOtpInput,
  SignupInput,
  VerifyOtpInput,
} from "../validators/auth.validator.js"

export const signupUser = asyncHandler(async (req: Request, res: Response) => {
  const { session, ...rest } = await signup(req.body as SignupInput, req.get("user-agent"))
  setAuthCookies(res, session)
  // session is deliberately NOT included in the response body — it's only
  // ever conveyed via the httpOnly cookie now (see lib/authCookies.ts). If
  // the raw tokens were also in this JSON body, any XSS able to read the
  // fetch response would still be able to steal them, defeating the entire
  // point of httpOnly (which only stops script-based reads of the cookie
  // itself, not of a response the page's own JS already has in hand).
  res.status(201).json({ ok: true, ...rest })
})

export const loginUser = asyncHandler(async (req: Request, res: Response) => {
  const { session, ...rest } = await login(req.body as LoginInput, req.get("user-agent"))
  setAuthCookies(res, session)
  res.status(200).json({ ok: true, ...rest })
})

export const startGoogle = asyncHandler(async (_req: Request, res: Response) => {
  const url = await startGoogleOAuth()
  res.status(200).json({ ok: true, url })
})

function googleErrorRedirect(res: Response, message: string) {
  res.redirect(`${env.frontendUrl.replace(/\/$/, "")}/auth/callback?error_description=${encodeURIComponent(message)}`)
}

function clearGoogleStateCookie(res: Response) {
  const { httpOnly, secure, sameSite, path } = googleOAuthStateCookieOptions(0)
  res.clearCookie(GOOGLE_OAUTH_STATE_COOKIE, { httpOnly, secure, sameSite, path })
}

// Top-level navigation target returned by POST /auth/google: binds the flow
// to this browser with a nonce cookie, then sends it on to Google.
export const beginGoogle = asyncHandler(async (_req: Request, res: Response) => {
  try {
    const { nonce, authorizationUrl } = beginGoogleOAuth()
    res.cookie(GOOGLE_OAUTH_STATE_COOKIE, nonce, googleOAuthStateCookieOptions())
    res.redirect(authorizationUrl)
  } catch (err) {
    googleErrorRedirect(res, err instanceof AppError ? err.message : "Google sign-in failed. Try again.")
  }
})

export const completeGoogle = asyncHandler(async (req: Request, res: Response) => {
  const code = typeof req.query.code === "string" ? req.query.code : ""
  const state = typeof req.query.state === "string" ? req.query.state : ""
  const cookieNonce = (req as Request & { cookies?: Record<string, unknown> }).cookies?.[GOOGLE_OAUTH_STATE_COOKIE]
  const stateNonce = typeof cookieNonce === "string" ? cookieNonce : ""

  // Single use: the nonce cookie is dropped on every callback attempt,
  // successful or not.
  clearGoogleStateCookie(res)

  if (!code || !state) {
    return res.redirect(`${env.frontendUrl.replace(/\/$/, "")}/auth/callback?error_description=Missing+sign-in+parameters`)
  }

  try {
    const { redirectUrl, session } = await completeGoogleOAuthCallback(code, state, stateNonce, req.get("user-agent"))
    setAuthCookies(res, session)
    res.redirect(redirectUrl)
  } catch (err) {
    googleErrorRedirect(res, err instanceof AppError ? err.message : "Google sign-in failed. Try again.")
  }
})

export const currentUser = asyncHandler(async (req: Request, res: Response) => {
  const user = await getMe(getBearerToken(req))
  res.status(200).json({ ok: true, user })
})

export const refreshUserSession = asyncHandler(async (req: Request, res: Response) => {
  const { refresh_token: bodyToken } = req.body as RefreshInput
  const refreshToken = refreshTokenFromCookie(req) || bodyToken
  if (!refreshToken) throw new AppError(401, "Please sign in again.")

  const { session } = await refreshSession(refreshToken, req.get("user-agent"))
  setAuthCookies(res, session)
  res.status(200).json({ ok: true })
})

export const logoutUser = asyncHandler(async (req: Request, res: Response) => {
  const { refresh_token: bodyToken } = req.body as RefreshInput
  const refreshToken = refreshTokenFromCookie(req) || bodyToken
  // CS-11: revokes the session server-side (refresh token and, via sid, the
  // access token too), so replaying either old cookie afterwards gets a 401.
  await logout(refreshToken || "", getBearerToken(req))
  clearAuthCookies(res)
  res.status(200).json({ ok: true })
})

// CS-11: sign out of every device.
export const logoutAllUser = asyncHandler(async (req: Request, res: Response) => {
  await logoutAll(getBearerToken(req))
  clearAuthCookies(res)
  res.status(200).json({ ok: true })
})

export const verifyEmailUser = asyncHandler(async (req: Request, res: Response) => {
  const token = typeof req.body?.token === "string" ? req.body.token : ""
  const user = await verifyEmail(token)
  res.status(200).json({ ok: true, user })
})

export const resendVerificationEmail = asyncHandler(async (req: Request, res: Response) => {
  const result = await resendVerification(getBearerToken(req))
  res.status(200).json({ ok: true, ...result })
})

export const updateAutoPurchase = asyncHandler(async (req: Request, res: Response) => {
  const user = await setAutoPurchase(getBearerToken(req), req.body as { enabled: boolean; model?: "anthropic" | "openai" | "gemini" })
  res.status(200).json({ ok: true, user })
})

export const forgotPasswordUser = asyncHandler(async (req: Request, res: Response) => {
  const { email } = req.body as ForgotPasswordInput
  await requestPasswordReset(email)
  // Same response whether or not the account exists — avoids email enumeration.
  res.status(200).json({
    ok: true,
    message: "If an account exists for that email, a reset link has been sent.",
  })
})

export const resetPasswordUser = asyncHandler(async (req: Request, res: Response) => {
  const { token, password } = req.body as ResetPasswordInput
  await resetPassword(token, password)
  res.status(200).json({ ok: true, message: "Password updated. You can sign in with your new password." })
})

export const sendOtpCode = asyncHandler(async (req: Request, res: Response) => {
  const body = req.body as SendOtpInput
  const result = await sendOtp(body)
  res.status(200).json(result)
})

export const verifyOtpCode = asyncHandler(async (req: Request, res: Response) => {
  const body = req.body as VerifyOtpInput
  const result = await verifyOtp(body)
  res.status(200).json(result)
})
