import type { NextFunction, Request, Response } from "express"

import { hasDatabase } from "../env.js"

export function requireDb(_req: Request, res: Response, next: NextFunction) {
  if (!hasDatabase) {
    return res.status(503).json({
      ok: false,
      error: "Database is not configured. Set DATABASE_URL and JWT_SECRET.",
    })
  }

  next()
}
