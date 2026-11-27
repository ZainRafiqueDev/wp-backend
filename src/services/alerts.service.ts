import { env } from "../env.js"
import { pool } from "../lib/db.js"
import { sendEmail } from "../lib/email.js"
import { log } from "../lib/logger.js"
import { runWithSystemContext } from "../lib/tenantContext.js"

export type AlertType =
  | "grounding_failure_rate"
  | "circuit_breaker_open"
  | "ingest_queue_depth"
  | "tenant_spend_90"
  | "okf_stale"

async function isEnabled(alertType: AlertType): Promise<{ enabled: boolean; threshold: number | null }> {
  if (!pool) return { enabled: false, threshold: null }
  try {
    return await runWithSystemContext(async () => {
      const { rows } = await pool!.query<{ enabled: boolean; threshold: string | null }>(
        `select enabled, threshold::text from alert_configs where alert_type = $1`,
        [alertType],
      )
      if (!rows[0]) return { enabled: true, threshold: null }
      return { enabled: rows[0].enabled, threshold: rows[0].threshold == null ? null : Number(rows[0].threshold) }
    })
  } catch {
    return { enabled: false, threshold: null }
  }
}

export async function listAlertConfigs() {
  if (!pool) return []
  return runWithSystemContext(async () => {
    const { rows } = await pool!.query(`select alert_type, enabled, threshold from alert_configs order by alert_type`)
    return rows.map((row) => ({
      alertType: row.alert_type as AlertType,
      enabled: Boolean(row.enabled),
      threshold: row.threshold == null ? null : Number(row.threshold),
    }))
  })
}

export async function setAlertEnabled(alertType: AlertType, enabled: boolean): Promise<void> {
  if (!pool) return
  await runWithSystemContext(async () => {
    await pool!.query(`update alert_configs set enabled = $2, updated_at = now() where alert_type = $1`, [
      alertType,
      enabled,
    ])
  })
}

/**
 * Records the alert and emails only when ALERT_EMAIL_ENABLED is on.
 * Default is off so this never talks to Resend unless an operator opts in.
 */
export async function fireAlert(alertType: AlertType, payload: Record<string, unknown>, chatbotId?: string): Promise<void> {
  const config = await isEnabled(alertType)
  if (!config.enabled) return
  if (!pool) return

  await runWithSystemContext(async () => {
    await pool!.query(
      `insert into alert_events (alert_type, chatbot_id, payload, delivered) values ($1, $2, $3::jsonb, false)`,
      [alertType, chatbotId ?? null, JSON.stringify(payload)],
    )
  })

  log().warn({ event: "alert.fired", alertType, chatbotId, ...payload }, "observability alert")

  if (!env.alertEmailEnabled) return
  const to = env.alertEmailTo || env.adminNotificationEmail
  if (!to) return
  const result = await sendEmail({
    to,
    subject: `[ChatMate360] ${alertType}`,
    text: `${alertType}\n${JSON.stringify(payload)}`,
  })
  if (result.delivered) {
    await runWithSystemContext(async () => {
      await pool!.query(
        `update alert_events set delivered = true
          where id = (select id from alert_events where alert_type = $1 order by created_at desc limit 1)`,
        [alertType],
      )
    })
  }
}

export async function maybeAlertCircuitOpen(provider: string): Promise<void> {
  await fireAlert("circuit_breaker_open", { provider })
}

export async function maybeAlertQueueDepth(depth: number): Promise<void> {
  const config = await isEnabled("ingest_queue_depth")
  const threshold = config.threshold ?? 500
  if (depth > threshold) await fireAlert("ingest_queue_depth", { depth, threshold })
}

export async function maybeAlertOkfStale(): Promise<void> {
  if (!pool) return
  const config = await isEnabled("okf_stale")
  if (!config.enabled) return
  const days = config.threshold ?? env.okfStaleDays
  const stale = await runWithSystemContext(async () => {
    const { rows } = await pool!.query<{ id: string; chatbot_id: string; title: string; served_count: number }>(
      `select id, chatbot_id, title, served_count
         from okf_concepts
        where is_active and approved_at is not null
          and updated_at < now() - ($1::text || ' days')::interval
          and served_count > $2`,
      [String(days), env.okfStaleServeCount],
    )
    return rows
  })
  for (const row of stale) {
    const recent = await runWithSystemContext(async () => {
      const { rows } = await pool!.query<{ n: string }>(
        `select count(*)::text as n from alert_events
          where alert_type = 'okf_stale'
            and chatbot_id = $1
            and payload->>'conceptId' = $2
            and created_at > now() - interval '7 days'`,
        [row.chatbot_id, row.id],
      )
      return Number(rows[0]?.n ?? 0)
    })
    if (recent > 0) continue
    await fireAlert(
      "okf_stale",
      {
        conceptId: row.id,
        title: row.title,
        servedCount: Number(row.served_count),
        staleDays: days,
      },
      row.chatbot_id,
    )
  }
}
