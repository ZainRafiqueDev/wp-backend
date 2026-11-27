import type { Request, Response } from "express"

import { asyncHandler } from "../middleware/asyncHandler.js"
import { getBearerToken } from "../middleware/requireAuth.js"
import { verifyAccessToken } from "../lib/auth.js"
import { AppError } from "../lib/errors.js"
import {
  listNotificationsForUser,
  markAllNotificationsRead,
  markNotificationRead,
} from "../services/notification.service.js"

export const getNotifications = asyncHandler(async (req: Request, res: Response) => {
  const userId = verifyAccessToken(getBearerToken(req))
  if (!userId) throw new AppError(401, "Please sign in again.")
  const notifications = await listNotificationsForUser(userId)
  res.status(200).json({ ok: true, notifications })
})

export const readNotification = asyncHandler(async (req: Request, res: Response) => {
  const userId = verifyAccessToken(getBearerToken(req))
  if (!userId) throw new AppError(401, "Please sign in again.")
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id
  const updated = await markNotificationRead(userId, id)
  res.status(200).json({ ok: true, updated })
})

export const readAllNotifications = asyncHandler(async (req: Request, res: Response) => {
  const userId = verifyAccessToken(getBearerToken(req))
  if (!userId) throw new AppError(401, "Please sign in again.")
  const updated = await markAllNotificationsRead(userId)
  res.status(200).json({ ok: true, updated })
})
