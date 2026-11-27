
import { pool } from "../lib/db.js"
import { AppError } from "../lib/errors.js"
import { log } from "../lib/logger.js"
import { env } from "../env.js"
import { transitionOrderState } from "./orderState.service.js"

function requireDbPool() {
  if (!pool) throw new AppError(503, "Database is not configured. Set DATABASE_URL and JWT_SECRET.")
  return pool
}

export interface ReconciliationOutcome {
  checked: number
  transitionedToPaid: number
  stillPending: number
  errors: number
}

export async function runPaymentReconciliation(): Promise<ReconciliationOutcome> {
  const db = requireDbPool()
  const thresholdMs = env.paymentReconciliationThresholdMs

  const { rows } = await db.query(
    `select id, chatbot_id from commerce_orders
     where status = 'PENDING_PAYMENT' and created_at < now() - ($1 || ' milliseconds')::interval`,
    [thresholdMs],
  )

  let transitionedToPaid = 0
  let stillPending = 0
  let errors = 0

  for (const row of rows) {
    try {
      const result = await transitionOrderState(row.id, "PAID", { source: "reconciliation-job" })
      if (result.changed) transitionedToPaid++
      else stillPending++
    } catch (err) {
      errors++
      log().error({ orderId: row.id, chatbotId: row.chatbot_id, err: err instanceof Error ? err.message : String(err) }, "payment reconciliation: transition attempt failed")
    }
  }

  const outcome = { checked: rows.length, transitionedToPaid, stillPending, errors }
  log().info(outcome, "payment reconciliation tick finished")
  return outcome
}
