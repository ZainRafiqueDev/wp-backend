import type { NextFunction, Request, Response } from "express"

import { AppError } from "../lib/errors.js"
import { log, routeOf, safeErrorFields } from "../lib/logger.js"
import { recordSecurityEvent } from "../services/securityAudit.service.js"

function requestMeta(req: Request) {
  const chatbotMatch = req.originalUrl?.match(/chatbots\/([0-9a-f-]{36})/i)
  return {
    requestPath: routeOf(req.originalUrl || req.path) ?? null,
    ipAddress: req.ip,
    userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null,
    chatbotId: chatbotMatch?.[1] ?? null,
    userId: (req as Request & { userId?: string }).userId ?? null,
  }
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    if (err.status === 403 || err.status === 401) {
      void recordSecurityEvent({
        eventType: "unauthorized_access",
        ...requestMeta(req),
        details: { status: err.status },
      })
    }
    return res.status(err.status).json({
      ok: false,
      error: err.message,
      ...(err.cap ? { cap: err.cap } : {}),
      ...(err.code ? { code: err.code } : {}),
      ...(err.data ? { data: err.data } : {}),
    })
  }

  const parseFailed =
    typeof err === "object" && err !== null && "type" in err && (err as { type?: string }).type === "entity.parse.failed"

  if (parseFailed) {
    return res.status(400).json({ ok: false, error: "Invalid JSON" })
  }

  // body-parser's own limit (express.json({ limit: "256kb" }) in app.ts)
  // throws this when a request body exceeds it, before any route handler
  // or validator ever runs. Previously fell through to the generic 500
  // below — a client sending too much data is a client error (413), not a
  // server fault, and shouldn't be logged as an unhandled server error.
  const payloadTooLarge =
    typeof err === "object" && err !== null && "type" in err && (err as { type?: string }).type === "entity.too.large"

  if (payloadTooLarge) {
    return res.status(413).json({ ok: false, error: "Request body is too large." })
  }


  // Allowlisted fields only (the logger's err serializer also drops
  // config/headers/response); message and stack still pass through the
  // logger's secret scrubber. The client never sees either.
  log().error(
    {
      err: err instanceof Error ? { type: err.name, message: err.message, stack: err.stack } : safeErrorFields(err),
      errorCategory: "unhandled",
      method: req.method,
      route: routeOf(req.originalUrl || req.path),
    },
    "unhandled error",
  )
  res.status(500).json({ ok: false, error: "Something went wrong" })
}
