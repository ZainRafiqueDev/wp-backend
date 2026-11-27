import { createHash } from "node:crypto"

import pino, { type DestinationStream } from "pino"

import { env } from "../env.js"
import { currentClientRequestId, currentRequestId } from "./requestContext.js"

// Centralized log redaction (CS-10). Three layers, applied to every line
// that goes through baseLogger / log():
//
//  1. Allowlist serializers for the objects most likely to carry secrets:
//     `req`, `res` and `err`/`error` are reduced to an explicit set of safe
//     fields (method, route without query string, status, an allowlist of
//     headers, error type/message/stack/code). Cookies, Authorization,
//     request bodies and axios/fetch `config`/`headers`/`response` never pass.
//  2. Key-based redaction (pino `redact`) for secret-named keys at the top
//     level and up to two levels deep, plus header paths.
//  3. A value-pattern scrubber on the final serialized line, so secret-shaped
//     strings (API keys, webhook secrets, Bearer tokens, JWTs, credentialed
//     connection strings, `password=` / `token=` pairs) are masked even when
//     they arrive inside a message, an error stack or an unexpected key.

export const REDACTED = "[redacted]"

const SECRET_KEYS = [
  "password",
  "password_hash",
  "passwordHash",
  "newPassword",
  "currentPassword",
  "token",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "idToken",
  "id_token",
  "proofToken",
  "otp",
  "otpCode",
  "otp_code",
  "secret",
  "clientSecret",
  "client_secret",
  "webhookSecret",
  "apiKey",
  "api_key",
  "consumerKey",
  "consumerSecret",
  "authorization",
  "Authorization",
  "cookie",
  "cookies",
  "Cookie",
  "set-cookie",
  "jwt",
  "databaseUrl",
  "DATABASE_URL",
  "redisUrl",
  "REDIS_URL",
  "connectionString",
  // Chat / document / e-mail content — never logged verbatim.
  "content",
  "message",
  "bodyPreview",
  "text",
  "html",
]

function keyPath(prefix: string, key: string): string {
  if (/^[A-Za-z_$][\w$]*$/.test(key)) return prefix ? `${prefix}.${key}` : key
  return `${prefix}["${key}"]`
}

const REDACT_PATHS = [
  ...SECRET_KEYS.flatMap((key) => (/^[A-Za-z_$][\w$]*$/.test(key) ? [keyPath("", key)] : []).concat([
    keyPath("*", key),
    keyPath("*.*", key),
  ])),
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  '*.headers["x-api-key"]',
  '*.headers["set-cookie"]',
]

// Value-shape patterns. Every negated character class excludes `"` and `\`
// so a replacement can never break the JSON string it sits in.
const VALUE_PATTERNS: Array<[RegExp, string]> = [
  // Credentialed connection strings: scheme://user:pass@ or scheme://:pass@
  [/\b((?:postgres(?:ql)?|rediss?|mysql|mongodb(?:\+srv)?|amqps?):\/\/)[^\s"\\/@]*:[^\s"\\/@]*@/gi, `$1${REDACTED}@`],
  [/\bBearer\s+(?!\[redacted\])[A-Za-z0-9._~+/=-]+/g, `Bearer ${REDACTED}`],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+/g, REDACTED],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/g, REDACTED],
  [/\bwhsec_[A-Za-z0-9+/=]{8,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, REDACTED],
  [/\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{8,}/g, REDACTED],
  // key=value pairs (query strings, DSNs, free text) — `code=` covers OAuth
  // authorization codes in callback URLs.
  [
    /\b(password|passwd|pwd|secret|token|access_token|refresh_token|api_?key|otp|code)=(?!\[redacted\])[^\s"\\&,;]+/gi,
    `$1=${REDACTED}`,
  ],
  // "password: x" / "token: x" in free text (not `code:`, which is mostly error codes).
  [/\b(password|passwd|secret|token|api_?key|otp):\s?(?!\[redacted\])[^\s"\\&,;]+/gi, `$1: ${REDACTED}`],
]

export function scrubSecrets(value: string): string {
  let out = value
  for (const [pattern, replacement] of VALUE_PATTERNS) out = out.replace(pattern, replacement)
  return out
}

const SAFE_REQUEST_HEADERS = ["user-agent", "content-type", "content-length", "origin", "referer", "x-client-request-id"]
const SAFE_RESPONSE_HEADERS = ["content-type", "content-length"]

function pickHeaders(headers: unknown, allow: string[]): Record<string, unknown> | undefined {
  if (!headers || typeof headers !== "object") return undefined
  const out: Record<string, unknown> = {}
  for (const name of allow) {
    const value = (headers as Record<string, unknown>)[name]
    if (value !== undefined) out[name] = value
  }
  return out
}

/** Path only — the query string can carry tokens/codes. */
export function routeOf(url: unknown): string | undefined {
  return typeof url === "string" ? url.split("?")[0] : undefined
}

/** Allowlisted request fields — never body, query string, cookies or auth headers. */
export function safeRequestFields(req: unknown): Record<string, unknown> {
  if (!req || typeof req !== "object") return {}
  const r = req as Record<string, unknown>
  return {
    method: r.method,
    route: routeOf(r.originalUrl ?? r.url),
    requestId: r.id,
    headers: pickHeaders(r.headers, SAFE_REQUEST_HEADERS),
  }
}

function safeResponseFields(res: unknown): Record<string, unknown> {
  if (!res || typeof res !== "object") return {}
  const r = res as Record<string, unknown> & { getHeaders?: () => Record<string, unknown> }
  const headers = typeof r.getHeaders === "function" ? r.getHeaders() : r.headers
  return { statusCode: r.statusCode, headers: pickHeaders(headers, SAFE_RESPONSE_HEADERS) }
}

/** Allowlisted error fields — drops `config`, `headers`, `request`, `response`, bodies. */
export function safeErrorFields(err: unknown): unknown {
  if (!err || typeof err !== "object") return err
  const e = err as Record<string, unknown>
  const type = err instanceof Error ? err.name : typeof e.name === "string" ? e.name : typeof e.type === "string" ? e.type : "Object"
  const out: Record<string, unknown> = { type }
  for (const key of ["message", "stack", "code", "status", "statusCode"]) {
    if (e[key] !== undefined) out[key] = e[key]
  }
  return out
}

/** Host/port/db only — never userinfo, query string or the raw URL. */
export function describeConnectionUrl(raw: string | undefined | null): Record<string, unknown> {
  if (!raw) return { configured: false }
  try {
    const url = new URL(raw)
    const db = url.pathname.replace(/^\//, "")
    return {
      configured: true,
      scheme: url.protocol.replace(/:$/, ""),
      host: url.hostname,
      ...(url.port ? { port: url.port } : {}),
      ...(db ? { db } : {}),
      credentials: url.username || url.password ? "set" : "none",
    }
  } catch {
    return { configured: true, parseable: false }
  }
}

// Every line passes through the scrubbing stream before reaching stdout.
const stdoutSink: DestinationStream = pino.destination({ dest: 1, sync: true })

const scrubbingStream: DestinationStream = {
  write(line: string) {
    stdoutSink.write(scrubSecrets(line))
  },
}

export const baseLogger = pino(
  {
    level: env.logLevel,
    serializers: {
      req: safeRequestFields,
      res: safeResponseFields,
      err: safeErrorFields,
      error: safeErrorFields,
    },
    redact: { paths: REDACT_PATHS, censor: REDACTED },
  },
  scrubbingStream,
)


export function log() {
  const requestId = currentRequestId()
  if (!requestId) return baseLogger
  const clientRequestId = currentClientRequestId()
  return baseLogger.child(clientRequestId ? { requestId, clientRequestId } : { requestId })
}


export function shortRef(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12)
}


export function chatMessageSummary(message: string): Record<string, unknown> {
  return { messageRef: shortRef(message), messageLength: message.length }
}

export function chatMessageDebugField(message: string): Record<string, unknown> {
  return env.nodeEnv === "production" ? {} : { messageDebug: message }
}
