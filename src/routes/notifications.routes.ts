import { Router } from "express"

import { getNotifications, readAllNotifications, readNotification } from "../controllers/notifications.controller.js"
import { requireAuth } from "../middleware/requireAuth.js"
import { requireDb } from "../middleware/requireDb.js"

export const notificationsRouter = Router()

notificationsRouter.get("/", requireAuth, requireDb, getNotifications)
notificationsRouter.post("/read-all", requireAuth, requireDb, readAllNotifications)
notificationsRouter.post("/:id/read", requireAuth, requireDb, readNotification)
