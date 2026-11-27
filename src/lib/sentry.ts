import * as Sentry from "@sentry/node"
import type { Express } from "express"

import { env } from "../env.js"
import { baseLogger } from "./logger.js"

const SECRET_LIKE = /\b(sk_[a-zA-Z0-9_]+|whsec_[a-zA-Z0-9_]+|Bearer\s+[\w.\-]+|AKIA[0-9A-Z]{16})\b/g

function redactString(value: string): string {
  return value.replace(SECRET_LIKE, "[redacted]")
}

// Sentry events otherwise carry whatever the request/response actually
// contained — chat messages, emails, tokens — straight to a third party.
// This is a deny-by-default scrub, not an allowlist of "known safe" fields:
// request bodies and query strings are dropped entirely (a customer's
// message content is exactly the kind of thing that would otherwise end up
// here), auth-shaped headers are stripped, and any residual secret-looking
// substring in whatever text remains (breadcrumb messages, exception
// values) is redacted as a second layer.
export function scrubEvent(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  if (event.request) {
    delete event.request.data
    delete event.request.query_string
    delete event.request.cookies
    if (event.request.headers) {
      const headers = { ...event.request.headers }
      delete headers.authorization
      delete headers.Authorization
      delete headers.cookie
      delete headers.Cookie
      event.request.headers = headers
    }
  }

  // Keep the account identifiable for triage without shipping email/IP.
  if (event.user) {
    event.user = event.user.id ? { id: event.user.id } : undefined
  }

  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map((crumb) => {
      if (typeof crumb.message === "string") crumb.message = redactString(crumb.message)
      if (crumb.data) delete crumb.data
      return crumb
    })
  }

  for (const exception of event.exception?.values ?? []) {
    if (typeof exception.value === "string") exception.value = redactString(exception.value)
  }

  return event
}

export function initSentry(): void {
  if (!env.sentryDsn) {
    baseLogger.warn(
      "SENTRY_DSN not set — errors are only visible in stdout logs. Set SENTRY_DSN to enable error tracking.",
    )
    return
  }

  Sentry.init({
    dsn: env.sentryDsn,
    environment: env.nodeEnv,
    // Traces are a separate, much higher-volume cost than error capture;
    // this integration is scoped to "know when something breaks in
    // production," not APM — leave tracing to a dedicated OpenTelemetry
    // pass rather than quietly turning it on here.
    tracesSampleRate: 0,
    beforeSend: (event) => scrubEvent(event),
  })

  baseLogger.info({ environment: env.nodeEnv }, "sentry error tracking initialized")
}

// Registered after every route but before this app's own JSON error
// handler, so Sentry sees the same errors errorHandler.ts reports on, then
// hands off to it unchanged — callers still get identical responses.
export function installSentryErrorHandler(app: Express): void {
  if (!env.sentryDsn) return
  Sentry.setupExpressErrorHandler(app)
}
