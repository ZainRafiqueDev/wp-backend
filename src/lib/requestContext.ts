import { AsyncLocalStorage } from "node:async_hooks"

interface RequestContext {
  // Always server-generated (see middleware/requestId.ts). Safe to use as an
  // idempotency key — e.g. usage.service.ts's cost reservations.
  requestId: string
  // The caller's own X-Request-Id, sanitized. Client-controlled: use it ONLY
  // for log correlation, never as a key for billing, caching or dedupe.
  clientRequestId?: string
}


const storage = new AsyncLocalStorage<RequestContext>()

export function runWithRequestId<T>(requestId: string, fn: () => T, clientRequestId?: string): T {
  return storage.run(clientRequestId ? { requestId, clientRequestId } : { requestId }, fn)
}

export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId
}

export function currentClientRequestId(): string | undefined {
  return storage.getStore()?.clientRequestId
}
