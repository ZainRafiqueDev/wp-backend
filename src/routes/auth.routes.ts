import { Router } from "express"

import {
  beginGoogle,
  completeGoogle,
  currentUser,
  forgotPasswordUser,
  loginUser,
  logoutAllUser,
  logoutUser,
  refreshUserSession,
  resendVerificationEmail,
  resetPasswordUser,
  sendOtpCode,
  signupUser,
  startGoogle,
  updateAutoPurchase,
  verifyEmailUser,
  verifyOtpCode,
} from "../controllers/auth.controller.js"
import { requireAuth } from "../middleware/requireAuth.js"
import { requireDb } from "../middleware/requireDb.js"
import {
  rateLimitLogin,
  rateLimitOtpSend,
  rateLimitOtpVerify,
  rateLimitPasswordForgot,
  rateLimitPasswordReset,
  rateLimitResendVerification,
  rateLimitSignup,
  rateLimitVerifyEmail,
} from "../middleware/rateLimitAuthFlows.js"
import { validateBody } from "../middleware/validate.js"
import {
  autoPurchaseSchema,
  forgotPasswordSchema,
  loginSchema,
  refreshSchema,
  resetPasswordSchema,
  sendOtpSchema,
  signupSchema,
  verifyEmailSchema,
  verifyOtpSchema,
} from "../validators/auth.validator.js"

export const authRouter = Router()

authRouter.post("/signup", requireDb, rateLimitSignup, validateBody(signupSchema), signupUser)
authRouter.post("/login", requireDb, rateLimitLogin, validateBody(loginSchema), loginUser)
authRouter.post("/google", requireDb, startGoogle)

authRouter.get("/google/start", beginGoogle)
authRouter.get("/google/callback", requireDb, completeGoogle)
authRouter.get("/me", requireDb, requireAuth, currentUser)
authRouter.post("/refresh", requireDb, validateBody(refreshSchema), refreshUserSession)
authRouter.post("/logout", requireDb, validateBody(refreshSchema), logoutUser)
authRouter.post("/logout-all", requireAuth, requireDb, logoutAllUser)

authRouter.post("/verify-email", requireDb, rateLimitVerifyEmail, validateBody(verifyEmailSchema), verifyEmailUser)
authRouter.post("/resend-verification", requireDb, requireAuth, rateLimitResendVerification, resendVerificationEmail)
authRouter.patch("/auto-purchase", requireDb, requireAuth, validateBody(autoPurchaseSchema), updateAutoPurchase)

// Link-token verify remains; OTP is the preferred chatbot / alternate dashboard path.
authRouter.post("/otp/send", requireDb, rateLimitOtpSend, validateBody(sendOtpSchema), sendOtpCode)
authRouter.post("/otp/verify", requireDb, rateLimitOtpVerify, validateBody(verifyOtpSchema), verifyOtpCode)

// Canonical password-reset paths + legacy aliases (same handlers).
authRouter.post(
  "/password/forgot",
  requireDb,
  rateLimitPasswordForgot,
  validateBody(forgotPasswordSchema),
  forgotPasswordUser,
)
authRouter.post("/password/reset", requireDb, rateLimitPasswordReset, validateBody(resetPasswordSchema), resetPasswordUser)
authRouter.post(
  "/forgot-password",
  requireDb,
  rateLimitPasswordForgot,
  validateBody(forgotPasswordSchema),
  forgotPasswordUser,
)
authRouter.post("/reset-password", requireDb, rateLimitPasswordReset, validateBody(resetPasswordSchema), resetPasswordUser)
