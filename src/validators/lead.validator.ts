import { z } from "zod"

// The real bots ChatMate360 offers on the Full Custom plan — a closed list,
// not free text, so a lead always names something the sales team can act
// on. Frontend mirrors this exact tuple (lib/data.ts) to render the
// selectable cards; keep both in sync if this list ever changes.
export const BOT_OPTIONS = [
  "Leads Agent",
  "Customer Support Agent",
  "Inventory Management Bot",
  "Email Automation Agent",
  "Booking Agent",
] as const

export type BotOption = (typeof BOT_OPTIONS)[number]

const leadFieldsSchema = {
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email(),
  phone: z.string().trim().min(5).max(30),
  // Capped at BOT_OPTIONS.length — there are only 5 real options, so no
  // legitimate submission can ever need more. Without this, an anonymous
  // visitor (this route is public — see lead.routes.ts) could submit a
  // huge array of invalid values and trigger zod's unbounded issue
  // collection for unconstrained array schemas (GHSA-mrhx-c7xc-m3w5).
  selectedBots: z.array(z.enum(BOT_OPTIONS)).min(1, "Select at least one bot.").max(BOT_OPTIONS.length),
}

export const createLeadSchema = z.object(leadFieldsSchema)
export type CreateLeadInput = z.infer<typeof createLeadSchema>

export const updateLeadSchema = z.object(leadFieldsSchema)
export type UpdateLeadInput = z.infer<typeof updateLeadSchema>
