import { z } from "zod"

import { httpUrl } from "./httpUrl.js"

export const chatbotSourceSchema = z.object({
  type: z.enum(["website", "pdf", "word"]),
  label: z.string().trim().min(1).max(240),
  url: httpUrl().optional(),
  size: z.number().int().nonnegative().optional(),
  characters: z.number().int().nonnegative(),
  content: z.string().max(20000).optional(),
})

const hexColor = z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, "Use a 6-digit hex color like #769656.")

export const themeSchema = z.object({
  primaryColor: hexColor,
  bgColor: hexColor,
  textColor: hexColor,
})


export const createChatbotSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    sources: z.array(chatbotSourceSchema).max(50).default([]),
    websiteUrl: httpUrl().optional(),
    theme: themeSchema.optional(),
  })
  .refine((input) => input.sources.length > 0 || Boolean(input.websiteUrl), {
    message: "Add a website URL, or at least one file source.",
    path: ["sources"],
  })

export const updateThemeSchema = z.object({
  theme: themeSchema,
})

export const updateDomainSchema = z.object({
  
  domain: z.string().trim().min(1).max(255),
})

export const updateFallbackMessageSchema = z.object({
  fallbackMessage: z.string().trim().min(1).max(500),
})


export const updatePreferredModelSchema = z.object({
  preferredModel: z.enum(["anthropic", "openai", "gemini", "auto"]),
})

const chatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(4000),
})

export const chatSchema = z.object({
  question: z.string().trim().min(1).max(2000),
  history: z.array(chatMessageSchema).max(20).default([]),

  sessionId: z.string().trim().min(1).max(200).optional(),
})


export const chatbotIdParamSchema = z.object({ chatbotId: z.string().guid() })


export const retryChatbotSchema = z.object({
  websiteUrl: httpUrl(),
})

export type CreateChatbotInput = z.infer<typeof createChatbotSchema>
export type UpdateThemeInput = z.infer<typeof updateThemeSchema>
export type UpdateDomainInput = z.infer<typeof updateDomainSchema>
export type UpdateFallbackMessageInput = z.infer<typeof updateFallbackMessageSchema>
export type UpdatePreferredModelInput = z.infer<typeof updatePreferredModelSchema>
export type ChatInput = z.infer<typeof chatSchema>
export type RetryChatbotInput = z.infer<typeof retryChatbotSchema>
