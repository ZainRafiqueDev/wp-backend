import { env } from "../env.js"
import { log, shortRef } from "./logger.js"

export type SendEmailInput = {
  to: string
  subject: string
  text: string
  html?: string
}

// Never wait on Resend forever: a hung request would hold a socket and a
// request slot (B05-003).
const RESEND_TIMEOUT_MS = 10_000

const LINK_PATTERN = /\bhttps?:\/\/[^\s"'<>]+/gi
// OTP-style codes and long opaque tokens that might appear outside a link.
const CODE_PATTERN = /\b\d{4,10}\b/g
const OPAQUE_TOKEN_PATTERN = /\b[A-Za-z0-9_-]{24,}\b/g

/**
 * The e-mail body with every link, numeric code and opaque token replaced —
 * these are exactly what makes an OTP / password-reset / invite / verify
 * e-mail an account-takeover credential.
 */
export function redactEmailBody(text: string): string {
  return text
    .replace(LINK_PATTERN, "[link redacted]")
    .replace(OPAQUE_TOKEN_PATTERN, "[token redacted]")
    .replace(CODE_PATTERN, "[code redacted]")
}

function logUndeliveredEmail(input: SendEmailInput): void {
  // Production (only reachable with ALLOW_EMAIL_LOG_ONLY_IN_PRODUCTION=true —
  // assertProductionGuards refuses to boot otherwise): metadata only, never
  // the recipient address or any part of the body.
  if (env.nodeEnv === "production") {
    log().warn(
      { toRef: shortRef(input.to.toLowerCase()), subject: input.subject },
      "email not sent — RESEND_API_KEY unset (ALLOW_EMAIL_LOG_ONLY_IN_PRODUCTION)",
    )
    return
  }

  // Local/dev: keep the body visible for debugging, with codes/links masked
  // unless the developer explicitly opts in with EMAIL_LOG_SHOW_SECRETS=true.
  // `emailPreview`, not `text`: `text` is a redacted log key.
  const showSecrets = env.emailLogShowSecrets
  log().info(
    {
      to: input.to,
      subject: input.subject,
      emailPreview: showSecrets ? input.text : redactEmailBody(input.text),
      secretsShown: showSecrets,
    },
    showSecrets
      ? "email not sent — RESEND_API_KEY unset; body logged (EMAIL_LOG_SHOW_SECRETS=true)"
      : "email not sent — RESEND_API_KEY unset; body logged with codes/links redacted (set EMAIL_LOG_SHOW_SECRETS=true locally to see them)",
  )
}

export async function sendEmail(input: SendEmailInput): Promise<{ delivered: boolean }> {
  if (!env.resendApiKey) {
    logUndeliveredEmail(input)
    return { delivered: false }
  }

  const toRef = shortRef(input.to.toLowerCase())

  // A non-OK response from Resend is handled below without throwing — but
  // fetch() itself rejects on a network-level failure (DNS, no outbound
  // route, TLS, timeout), which is exactly the kind of thing a fresh
  // server environment can hit before its egress/DNS is fully set up.
  // Without this catch, that rejection propagates out of sendOtp/etc. as an
  // unhandled 500, taking down the whole request instead of just the
  // (already best-effort, already-logged) email send.
  let res: Response
  try {
    res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: env.emailFrom,
        to: [input.to],
        subject: input.subject,
        text: input.text,
        html: input.html || undefined,
      }),
      signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
    })
  } catch (err) {
    log().error(
      { toRef, errorType: err instanceof Error ? err.name : typeof err, err: err instanceof Error ? err.message : String(err) },
      "resend email request failed (network error or timeout)",
    )
    return { delivered: false }
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "")
    log().error({ status: res.status, resendError: body.slice(0, 500), toRef }, "resend email failed")
    return { delivered: false }
  }

  return { delivered: true }
}
