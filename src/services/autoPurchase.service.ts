import { env, requireCreditGrantingEnabled } from "../env.js"
import { pool } from "../lib/db.js"
import { log } from "../lib/logger.js"
import { cashUsdFromStripeAmount } from "../lib/planEconomics.js"
import { priceIdForTopupModel, stripeClient, type TopupModel } from "../lib/stripe.js"
import { createNotification } from "./notification.service.js"
import { creditTopup } from "./topup.service.js"
import { currentBillingPeriod } from "./usage.service.js"

function isTopupModel(value: string | null): value is TopupModel {
  return value === "anthropic" || value === "openai" || value === "gemini"
}

/**
 * When a chatbot hits its usage cap and the owner opted into auto-purchase,
 * charge their default Stripe payment method for one top-up and credit the
 * chatbot. Failures are recorded + notified; they never throw into the chat path.
 */
export async function tryAutoPurchaseTopup(chatbotId: string): Promise<boolean> {
  if (!pool || !env.stripeSecretKey) return false
  try {
    requireCreditGrantingEnabled()
  } catch {
    return false
  }

  // Set once this call owns today's claim row; every outcome after that
  // updates the same row (status + detail) instead of adding new rows.
  let claimId: string | null = null
  let intentId: string | null = null
  // True once the claim row holds its final state. Nothing after that
  // (e.g. a notification error) may change the recorded payment outcome.
  let claimSettled = false
  try {
    const { rows } = await pool.query<{
      user_id: string
      email: string
      auto_purchase_enabled: boolean
      auto_purchase_model: string | null
      stripe_customer_id: string | null
    }>(
      `select u.id as user_id, u.email, u.auto_purchase_enabled, u.auto_purchase_model, s.stripe_customer_id
       from chatbots c
       join users u on u.id = c.user_id
       left join subscriptions s on s.user_id = u.id
       where c.id = $1`,
      [chatbotId],
    )
    const row = rows[0]
    if (!row?.auto_purchase_enabled || !isTopupModel(row.auto_purchase_model)) return false
    if (!row.stripe_customer_id) {
      await recordEvent(row.user_id, chatbotId, row.auto_purchase_model, "skipped", "No Stripe customer yet")
      await createNotification({
        userId: row.user_id,
        type: "auto_purchase",
        title: "Auto-purchase needs a payment method",
        body: "Your usage limit was hit, but no card is on file. Upgrade or buy a top-up once, then auto-purchase can retry.",
        emailTo: row.email,
        metadata: { chatbotId },
      })
      return false
    }

    // At most one attempt per chatbot per UTC day, claimed atomically: the
    // claim row is inserted first and the partial unique index
    // uq_auto_purchase_events_daily_claim (chatbot_id, claim_day) makes every
    // concurrent caller but one get no row back. Only the winner reaches
    // Stripe. See db/migrations/20261114_auto_purchase_daily_claim.sql.
    const claim = await claimDailyAttempt(row.user_id, chatbotId, row.auto_purchase_model)
    if (!claim) return false
    claimId = claim.id

    const stripe = stripeClient()
    const priceId = priceIdForTopupModel(row.auto_purchase_model)
    const price = await stripe.prices.retrieve(priceId)
    if (!price.unit_amount || !price.currency) {
      await finishClaim(claimId, "failed", "Top-up price missing amount")
      claimSettled = true
      return false
    }

    const methods = await stripe.paymentMethods.list({ customer: row.stripe_customer_id, type: "card", limit: 1 })
    const paymentMethod = methods.data[0]
    if (!paymentMethod) {
      await finishClaim(claimId, "failed", "No saved card")
      claimSettled = true
      await notifySafely(chatbotId, {
        userId: row.user_id,
        type: "auto_purchase",
        title: "Auto-purchase failed — no card on file",
        body: "Add a payment method via Billing → Payment method & invoices, then try again.",
        emailTo: row.email,
        metadata: { chatbotId },
      })
      return false
    }

    // Stripe-side guard on top of the DB claim: the same chatbot/day/model
    // always maps to the same key, so even a duplicate request that somehow
    // got past the claim returns the first PaymentIntent instead of a second
    // charge (Stripe keeps idempotency keys for at least 24 hours).
    const idempotencyKey = autoPurchaseIdempotencyKey(chatbotId, claim.claimDay, row.auto_purchase_model)
    const intent = await stripe.paymentIntents.create({
      amount: price.unit_amount,
      currency: price.currency,
      customer: row.stripe_customer_id,
      payment_method: paymentMethod.id,
      off_session: true,
      confirm: true,
      metadata: {
        topupChatbotId: chatbotId,
        topupModel: row.auto_purchase_model,
        topupBillingPeriod: currentBillingPeriod(),
        autoPurchase: "true",
      },
    }, { idempotencyKey })
    intentId = intent.id

    if (intent.status !== "succeeded") {
      await finishClaim(claimId, "failed", `PaymentIntent ${intent.id} status ${intent.status}`)
      claimSettled = true
      await notifySafely(chatbotId, {
        userId: row.user_id,
        type: "auto_purchase",
        title: "Auto-purchase needs attention",
        body: `Stripe returned status "${intent.status}". Buy a top-up manually from Billing, or update your card.`,
        emailTo: row.email,
        metadata: { chatbotId, status: intent.status },
      })
      return false
    }

    try {
      await creditTopup(
        chatbotId,
        row.auto_purchase_model,
        currentBillingPeriod(),
        env.topupCreditUsd,
        `auto_${intent.id}`,
        cashUsdFromStripeAmount(intent.amount, intent.currency),
      )
    } catch (err) {
      // The card WAS charged but no credit was granted. Record a distinct
      // state (not 'failed', which means no successful charge) and log an
      // alertable error so the PaymentIntent can be credited or refunded.
      const message = err instanceof Error ? err.message : String(err)
      log().error(
        { event: "auto_purchase.charged_not_credited", chatbotId, paymentIntentId: intent.id, err: message },
        "auto_purchase.charged_not_credited: card charged but top-up credit failed; reconcile manually",
      )
      await finishClaim(claimId, "charged_not_credited", `PaymentIntent ${intent.id}: ${message}`.slice(0, 500))
      claimSettled = true
      return false
    }
    await finishClaim(claimId, "succeeded", intent.id)
    claimSettled = true
    await notifySafely(chatbotId, {
      userId: row.user_id,
      type: "auto_purchase",
      title: "Usage top-up purchased automatically",
      body: `A ${row.auto_purchase_model} top-up was charged to your saved card and credited to this chatbot.`,
      emailTo: row.email,
      metadata: { chatbotId, paymentIntentId: intent.id },
    })
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log().warn({ chatbotId, paymentIntentId: intentId, err: message }, "auto-purchase attempt failed")
    // Never leave a claim stuck in 'attempted' with no explanation. The claim
    // keeps blocking further automatic attempts for the rest of this UTC day
    // (a thrown Stripe error can be ambiguous: the charge may have gone
    // through), so record what happened, including the PaymentIntent id if
    // one was created, for reconciliation.
    if (claimId && !claimSettled) {
      const detail = intentId ? `Error after PaymentIntent ${intentId}: ${message}` : `Error: ${message}`
      await finishClaim(claimId, "failed", detail.slice(0, 500)).catch(() => undefined)
    }
    return false
  }
}

/**
 * Owner notifications are best-effort: a failure here is logged and never
 * changes the recorded payment state or the caller's result.
 */
async function notifySafely(chatbotId: string, input: Parameters<typeof createNotification>[0]): Promise<void> {
  try {
    await createNotification(input)
  } catch (err) {
    log().warn(
      { chatbotId, err: err instanceof Error ? err.message : String(err) },
      "auto-purchase notification failed",
    )
  }
}

/** Stripe idempotency key for one chatbot's auto-purchase on one UTC day. */
export function autoPurchaseIdempotencyKey(chatbotId: string, claimDay: string, model: string): string {
  return `auto-topup:${chatbotId}:${claimDay}:${model}`
}

/**
 * Inserts today's claim row for this chatbot. Returns null when a claim for
 * the current UTC day already exists (another request won, or an earlier
 * attempt today succeeded or failed).
 */
async function claimDailyAttempt(
  userId: string,
  chatbotId: string,
  model: string,
): Promise<{ id: string; claimDay: string } | null> {
  if (!pool) return null
  const { rows } = await pool.query<{ id: string; claim_day: string }>(
    `insert into auto_purchase_events (user_id, chatbot_id, model, status, detail, claim_day)
     values ($1, $2, $3, 'attempted', null, (now() at time zone 'utc')::date)
     on conflict (chatbot_id, claim_day) where claim_day is not null do nothing
     returning id, claim_day::text as claim_day`,
    [userId, chatbotId, model],
  )
  return rows[0] ? { id: rows[0].id, claimDay: rows[0].claim_day } : null
}

/** Records the outcome on the claim row; claim_day is kept so the day stays claimed. */
async function finishClaim(
  claimId: string | null,
  status: "succeeded" | "failed" | "charged_not_credited",
  detail: string | null) {
  if (!pool || !claimId) return
  await pool.query(`update auto_purchase_events set status = $2, detail = $3 where id = $1`, [claimId, status, detail])
}

async function recordEvent(
  userId: string,
  chatbotId: string,
  model: string,
  status: "attempted" | "succeeded" | "failed" | "skipped",
  detail: string | null,
) {
  if (!pool) return
  await pool.query(
    `insert into auto_purchase_events (user_id, chatbot_id, model, status, detail)
     values ($1, $2, $3, $4, $5)`,
    [userId, chatbotId, model, status, detail],
  )
}
