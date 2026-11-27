import type { NextFunction, Request, Response } from "express"
import { ZodError, type ZodType } from "zod"

export function validateBody<T>(schema: ZodType<T>) {
  return (req: Request, res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({
        ok: false,
        error: "Invalid request",
        details: formatZodError(parsed.error),
      })
    }

    req.body = parsed.data
    next()
  }
}

export function validateParams<T>(schema: ZodType<T>) {
  return (req: Request, res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req.params)
    if (!parsed.success) {
      return res.status(400).json({
        ok: false,
        error: "Invalid request",
        details: formatZodError(parsed.error),
      })
    }

    next()
  }
}

function formatZodError(error: ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }))
}
