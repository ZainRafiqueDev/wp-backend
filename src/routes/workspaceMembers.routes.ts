import { Router } from "express"

import {
  getMembers,
  patchMemberRole,
  postAcceptInvitation,
  postInviteMember,
  postResendInvitation,
  removeInvitation,
  removeMemberRoute,
} from "../controllers/workspaceMembers.controller.js"
import { requireAuth } from "../middleware/requireAuth.js"
import { requireDb } from "../middleware/requireDb.js"
import { validateBody, validateParams } from "../middleware/validate.js"
import {
  acceptInvitationSchema,
  changeMemberRoleSchema,
  invitationIdParamSchema,
  inviteMemberSchema,
  memberUserIdParamSchema,
} from "../validators/workspaceMembers.validator.js"

export const workspaceMembersRouter = Router()

// List members = Admin+. Invite, remove, change role = Owner only
// (resolved inside the service — see src/lib/tenancy.ts).
workspaceMembersRouter.get("/", requireAuth, requireDb, getMembers)
workspaceMembersRouter.post("/invite", requireAuth, requireDb, validateBody(inviteMemberSchema), postInviteMember)
workspaceMembersRouter.post(
  "/invitations/:id/resend",
  requireAuth,
  requireDb,
  validateParams(invitationIdParamSchema),
  postResendInvitation,
)
workspaceMembersRouter.delete(
  "/invitations/:id",
  requireAuth,
  requireDb,
  validateParams(invitationIdParamSchema),
  removeInvitation,
)
workspaceMembersRouter.delete(
  "/:memberUserId",
  requireAuth,
  requireDb,
  validateParams(memberUserIdParamSchema),
  removeMemberRoute,
)
workspaceMembersRouter.patch(
  "/:memberUserId/role",
  requireAuth,
  requireDb,
  validateParams(memberUserIdParamSchema),
  validateBody(changeMemberRoleSchema),
  patchMemberRole,
)

// Called by the invitee themselves, already signed in as a brand-new
// account (see acceptInvitation's condition-5 checks).
workspaceMembersRouter.post("/accept", requireAuth, requireDb, validateBody(acceptInvitationSchema), postAcceptInvitation)
