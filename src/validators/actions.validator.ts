import { z } from "zod"


const ACTION_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/
const PARAMETER_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/
const SECRET_HEADER_NAMES = new Set(["authorization", "proxy-authorization", "x-api-key", "api-key"])

export const actionParameterSchema = z.object({
  name: z.string().trim().regex(PARAMETER_NAME_PATTERN, "Use a valid identifier: letters, numbers, underscores, not starting with a number"),
  type: z.enum(["string", "number", "boolean"]),
  description: z.string().trim().min(1).max(500),
  required: z.boolean().default(true),
})

export const createActionSchema = z.object({
  name: z
    .string()
    .trim()
    .toLowerCase()
    .regex(ACTION_NAME_PATTERN, "Use lowercase letters, numbers, and underscores only, starting with a letter"),
  description: z.string().trim().min(1).max(1000),
  httpMethod: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  // Placeholders may fill the host or path, but the scheme is fixed here so a
  // template can never produce javascript:, file:, gopher: and the like.
  // Filled values are percent-encoded, and the chatbot's API key is only sent
  // when the host has no placeholder (lib/actionExecutor.ts).
  urlTemplate: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .regex(/^https?:\/\/\S/i, "The URL must start with http:// or https://"),
  headersTemplate: z.record(z.string(), z.string()).default({}),
  bodyTemplate: z.record(z.string(), z.unknown()).nullable().default(null),
  parameters: z.array(actionParameterSchema).max(20).default([]),
}).superRefine((action, ctx) => {
  for (const name of Object.keys(action.headersTemplate)) {
    if (SECRET_HEADER_NAMES.has(name.toLowerCase())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["headersTemplate", name],
        message: "Store API credentials in this chatbot's encrypted Backend connection, not in an action header.",
      })
    }
  }
})

export const updateActionSchema = createActionSchema


export const actionIdParamSchema = z.object({
  chatbotId: z.string().guid(),
  id: z.string().guid(),
})

export type CreateActionInput = z.infer<typeof createActionSchema>
export type UpdateActionInput = z.infer<typeof updateActionSchema>
