import { randomUUID } from "node:crypto"

import type { NextFunction, Request, Response } from "express"

import { runWithRequestId } from "../lib/requestContext.js"
import { runWithTenantContext } from "../lib/tenantContext.js"

// A client's X-Request-Id is kept only for log correlation, and only when it
// is short and made of safe characters (no log/header injection).
const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/

export function sanitizeClientRequestId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return CLIENT_REQUEST_ID_PATTERN.test(trimmed) ? trimmed : undefined
}

// req.id / currentRequestId() is ALWAYS server-generated. It is used as the
// idempotency key for AI cost reservations (usage.service.ts), so it must
// never be something a caller can choose or replay (finding VER-01).
export function requestId(req: Request, res: Response, next: NextFunction) {
  const id = randomUUID()
  const clientRequestId = sanitizeClientRequestId(req.headers["x-request-id"])
  req.id = id
  res.set("X-Request-Id", id)
  if (clientRequestId) res.set("X-Client-Request-Id", clientRequestId)
  runWithRequestId(id, () => runWithTenantContext({}, next), clientRequestId)
}
