import type { Express } from "express"

import { adminRouter } from "./admin.routes.js"
import { authRouter } from "./auth.routes.js"
import { billingRouter } from "./billing.routes.js"
import { chatbotRouter } from "./chatbot.routes.js"
import { contactRouter } from "./contact.routes.js"
import { demoRouter } from "./demo.routes.js"
import { healthRouter } from "./health.routes.js"
import { leadRouter } from "./lead.routes.js"
import { publicRouter } from "./public.routes.js"
import { trialRouter } from "./trial.routes.js"
import { waitlistRouter } from "./waitlist.routes.js"
import { notificationsRouter } from "./notifications.routes.js"
import { workspaceMembersRouter } from "./workspaceMembers.routes.js"

export function registerRoutes(app: Express) {
  app.use("/health", healthRouter)
  app.use("/auth", authRouter)
  app.use("/chatbots", chatbotRouter)
  app.use("/billing", billingRouter)
  app.use("/notifications", notificationsRouter)
  app.use("/account/members", workspaceMembersRouter)
  app.use("/waitlist", waitlistRouter)
  app.use("/trial", trialRouter)
  app.use("/contact", contactRouter)
  app.use("/leads", leadRouter)
  app.use("/demo", demoRouter)
  app.use("/public", publicRouter)
  
  app.use("/admin", adminRouter)
}
