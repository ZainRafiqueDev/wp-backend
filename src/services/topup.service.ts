import { env, requireCreditGrantingEnabled } from "../env.js"
import { verifyAccessToken } from "../lib/auth.js"
import { requireOwnedChatbotId } from "../lib/chatbotOwnership.js"
import { pool } from "../lib/db.js"
import { AppError } from "../lib/errors.js"
import { log } from "../lib/logger.js"
import { assertGrantLessThanCash, creditGrantMetricFields } from "../lib/planEconomics.js"
import { priceIdForTopupModel, stripeClient, type TopupModel } from "../lib/stripe.js"
import { getOrCreateStripeCustomer, stripeIdempotencyKey } from "./billing.service.js"
import { requireCrawlPlusCustomActions } from "./customActionsAccess.service.js"
import { currentBillingPeriod } from "./usage.service.js"
import type { CreateTopupSessionInput } from "../validators/billing.validator.js"

function requireDbPool() {
  if (!pool) {
    throw new AppError(503, "Database is not configured. Set DATABASE_URL and JWT_SECRET.")
  }
  return pool
}

function requireUserId(accessToken: string): string {
  const userId = verifyAccessToken(accessToken)
  if (!userId) throw new AppError(401, "Please sign in again.")
  return userId
}


export async function createTopupCheckoutSession(
  accessToken: string,
  chatbotId: string,
  input: CreateTopupSessionInput,
): Promise<{ url: string }> {
  requireCreditGrantingEnabled()
  const userId = requireUserId(accessToken)
  const ownedId = await requireOwnedChatbotId(userId, chatbotId)
  await requireCrawlPlusCustomActions(ownedId)
  const customerId = await getOrCreateStripeCustomer(userId)
  const priceId = priceIdForTopupModel(input.model)
  const billingPeriod = currentBillingPeriod()

  const session = await stripeClient().checkout.sessions.create({
    mode: "payment",
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${env.frontendUrl}/dashboard/billing?topup=success`,
    cancel_url: `${env.frontendUrl}/dashboard/billing?topup=cancelled`,
    metadata: {
      topupChatbotId: ownedId,
      topupModel: input.model,
      topupBillingPeriod: billingPeriod,
    },
  }, { idempotencyKey: stripeIdempotencyKey("topup", userId, ownedId, input.model, billingPeriod) })

  if (!session.url) throw new AppError(502, "Stripe did not return a checkout URL.")
  return { url: session.url }
}


export async function creditTopup(
  chatbotId: string,
  model: string,
  billingPeriod: string,
  creditedUsd: number,
  stripeCheckoutSessionId: string,
  amountTotalUsd: number,
): Promise<void> {
  requireCreditGrantingEnabled()
  assertGrantLessThanCash(creditedUsd, amountTotalUsd)
  const db = requireDbPool()
  const grantFields = creditGrantMetricFields(creditedUsd, amountTotalUsd)
  try {
    const { rowCount } = await db.query(
      `insert into chatbot_model_credits (chatbot_id, billing_period, model, credited_usd, stripe_checkout_session_id)
       values ($1, $2, $3, $4, $5)
       on conflict (stripe_checkout_session_id) do nothing`,
      [chatbotId, billingPeriod, model, creditedUsd, stripeCheckoutSessionId],
    )
    if (rowCount) {
      log().info(
        { chatbotId, model, billingPeriod, stripeCheckoutSessionId, ...grantFields },
        "top-up credited",
      )
    } else {
      log().info({ chatbotId, stripeCheckoutSessionId, ...grantFields }, "top-up webhook redelivery, already credited — no-op")
    }
  } catch (err) {
    log().error(
      { chatbotId, model, stripeCheckoutSessionId, ...grantFields, err: err instanceof Error ? err.message : String(err) },
      "failed to credit top-up",
    )
    throw err
  }
}

export type { TopupModel }
