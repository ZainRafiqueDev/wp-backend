import { z } from "zod"

export const memberRoleSchema = z.enum(["admin", "viewer"])

export const inviteMemberSchema = z.object({
  email: z.string().trim().email(),
  role: memberRoleSchema,
})
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>

export const changeMemberRoleSchema = z.object({
  role: memberRoleSchema,
})
export type ChangeMemberRoleInput = z.infer<typeof changeMemberRoleSchema>

export const memberUserIdParamSchema = z.object({
  memberUserId: z.string().guid(),
})

export const invitationIdParamSchema = z.object({
  id: z.string().guid(),
})

export const acceptInvitationSchema = z.object({
  token: z.string().min(1),
})
export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>
