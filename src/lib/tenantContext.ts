import { AsyncLocalStorage } from "node:async_hooks"

import { env } from "../env.js"
import { log } from "./logger.js"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type TenantScope = "user" | "auth" | "public" | "admin" | "system" | "worker"

export type TenantContext = {
  scope?: TenantScope | ""
  chatbotId?: string
  userId?: string
  adminUserId?: string
  userEmail?: string
  lookupHash?: string
  googleId?: string
}

type TenantStore = TenantContext & {
  client?: import("pg").PoolClient
  clientDepth: number
  missingContextLogged: boolean
}

const storage = new AsyncLocalStorage<TenantStore>()

export function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}

function sanitizeUuid(value: string | undefined): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  return isUuid(trimmed) ? trimmed : undefined
}

function sanitizeEmail(value: string | undefined): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim().toLowerCase()
  return trimmed ? trimmed.slice(0, 320) : undefined
}

function sanitizeHash(value: string | undefined): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, 128) : undefined
}

export function runWithTenantContext<T>(context: TenantContext, fn: () => T): T {
  const store: TenantStore = {
    ...normalize(context),
    clientDepth: 0,
    missingContextLogged: false,
  }
  return storage.run(store, fn)
}

export async function runWithSystemContext<T>(fn: () => Promise<T> | T): Promise<T> {
  return runWithTenantContext({ scope: "system" }, () => Promise.resolve(fn()))
}

export function getTenantStore(): TenantStore | undefined {
  return storage.getStore()
}

export function currentTenantContext(): TenantContext {
  const store = storage.getStore()
  if (!store) return {}
  return {
    scope: store.scope,
    chatbotId: store.chatbotId,
    userId: store.userId,
    adminUserId: store.adminUserId,
    userEmail: store.userEmail,
    lookupHash: store.lookupHash,
    googleId: store.googleId,
  }
}

export function setTenantContext(patch: TenantContext): void {
  const store = storage.getStore()
  if (!store) return
  Object.assign(store, normalize({ ...store, ...patch }))
}

function normalize(context: TenantContext): TenantContext {
  return {
    scope: context.scope || "",
    chatbotId: sanitizeUuid(context.chatbotId),
    userId: sanitizeUuid(context.userId),
    adminUserId: sanitizeUuid(context.adminUserId),
    userEmail: sanitizeEmail(context.userEmail),
    lookupHash: sanitizeHash(context.lookupHash),
    googleId: sanitizeHash(context.googleId),
  }
}

export type TenantGucValues = {
  chatbotId: string
  userId: string
  scope: string
  adminUserId: string
  userEmail: string
  lookupHash: string
  googleId: string
}

// B09-017: "no ALS at all" used to mean system scope whenever
// NODE_ENV=test, so a process that merely had NODE_ENV mis-set ran every
// context-less query privileged. The test default is now an explicit
// opt-in made by the vitest setup file (tests/setup/implicitSystemContext.ts,
// which sets the flag directly) or allowImplicitSystemContextForTests(),
// kept on globalThis so vi.resetModules() does not drop it. Production code
// never calls it, and it refuses to turn on outside NODE_ENV=test.
const IMPLICIT_SYSTEM_KEY = "__cm360ImplicitSystemContextForTests"

/** Test harness only: treat a query with no ALS context as system scope. */
export function allowImplicitSystemContextForTests(enabled = true): void {
  if (enabled && env.nodeEnv !== "test") {
    throw new Error("allowImplicitSystemContextForTests() is only available under NODE_ENV=test.")
  }
  ;(globalThis as Record<string, unknown>)[IMPLICIT_SYSTEM_KEY] = enabled
}

function implicitSystemContextAllowed(): boolean {
  return env.nodeEnv === "test" && (globalThis as Record<string, unknown>)[IMPLICIT_SYSTEM_KEY] === true
}

/**
 * GUCs applied with SET LOCAL. An empty ALS is a real empty tenant (0 rows),
 * and so is no ALS at all: missing context fails closed. The only exception
 * is the explicit test-harness opt-in above, so fixtures can seed without
 * wrapping every helper.
 */
export function resolveTenantGucs(): TenantGucValues {
  const store = storage.getStore()
  if (!store) {
    if (implicitSystemContextAllowed()) {
      return {
        chatbotId: "",
        userId: "",
        scope: "system",
        adminUserId: "",
        userEmail: "",
        lookupHash: "",
        googleId: "",
      }
    }
    return {
      chatbotId: "",
      userId: "",
      scope: "",
      adminUserId: "",
      userEmail: "",
      lookupHash: "",
      googleId: "",
    }
  }
  const ctx = normalize(store)
  return {
    chatbotId: ctx.chatbotId || "",
    userId: ctx.userId || "",
    scope: ctx.scope || "",
    adminUserId: ctx.adminUserId || "",
    userEmail: ctx.userEmail || "",
    lookupHash: ctx.lookupHash || "",
    googleId: ctx.googleId || "",
  }
}

export function tenantContextIsEmpty(gucs: TenantGucValues): boolean {
  return !gucs.scope && !gucs.chatbotId && !gucs.userId && !gucs.adminUserId && !gucs.userEmail && !gucs.lookupHash && !gucs.googleId
}

export function logMissingTenantContext(): void {
  const store = storage.getStore()
  if (store?.missingContextLogged) return
  if (store) store.missingContextLogged = true
  log().warn(
    { event: "rls.missing_tenant_context", metric: "rls.missing_tenant_context" },
    "rls.missing_tenant_context",
  )
}
