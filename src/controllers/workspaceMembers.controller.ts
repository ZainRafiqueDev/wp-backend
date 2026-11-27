import type { Request, Response } from "express"

import { asyncHandler } from "../middleware/asyncHandler.js"
import { getBearerToken } from "../middleware/requireAuth.js"
import {
  acceptInvitation,
  changeMemberRole,
  inviteMember,
  listMembers,
  removeMember,
  resendInvitation,
  revokeInvitation,
} from "../services/workspaceMembers.service.js"
import type { AcceptInvitationInput, ChangeMemberRoleInput, InviteMemberInput } from "../validators/workspaceMembers.validator.js"

function param(req: Request, name: string): string {
  const value = req.params[name]
  return Array.isArray(value) ? value[0] : value
}

export const getMembers = asyncHandler(async (req: Request, res: Response) => {
  const result = await listMembers(getBearerToken(req))
  res.status(200).json({ ok: true, ...result })
})

export const postInviteMember = asyncHandler(async (req: Request, res: Response) => {
  const invitation = await inviteMember(getBearerToken(req), req.body as InviteMemberInput)
  res.status(201).json({ ok: true, invitation })
})

export const postResendInvitation = asyncHandler(async (req: Request, res: Response) => {
  const invitation = await resendInvitation(getBearerToken(req), param(req, "id"))
  res.status(200).json({ ok: true, invitation })
})

export const removeInvitation = asyncHandler(async (req: Request, res: Response) => {
  await revokeInvitation(getBearerToken(req), param(req, "id"))
  res.status(204).send()
})

export const removeMemberRoute = asyncHandler(async (req: Request, res: Response) => {
  await removeMember(getBearerToken(req), param(req, "memberUserId"))
  res.status(204).send()
})

export const patchMemberRole = asyncHandler(async (req: Request, res: Response) => {
  const { role } = req.body as ChangeMemberRoleInput
  const member = await changeMemberRole(getBearerToken(req), param(req, "memberUserId"), role)
  res.status(200).json({ ok: true, member })
})

export const postAcceptInvitation = asyncHandler(async (req: Request, res: Response) => {
  const { token } = req.body as AcceptInvitationInput
  const result = await acceptInvitation(getBearerToken(req), token)
  res.status(200).json({ ok: true, ...result })
})
