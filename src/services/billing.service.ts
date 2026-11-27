import type Stripe from "stripe"

import { env, isCreditGrantingEnabled, requireCreditGrantingEnabled } from "../env.js"
import { verifyAccessToken } from "../lib/auth.js"
import { incrementBillingMetric } from "../lib/billingMetrics.js"
import {
  addOneBillingPeriod,
  invoiceSubscriptionId,
  paidPlanLabel,
  periodEndFromStripeSubscription,
} from "../lib/billingPeriod.js"
import { pool } from "../lib/db.js"
import { AppError } from "../lib/errors.js"
import { log } from "../lib/logger.js"
import { runWithSystemContext } from "../lib/tenantContext.js"
import {
  assertGrantLessThanCash,
  cashUsdFromStripeAmount,
  cashUsdFromSubscriptionItem,
  creditGrantMetricFields,
  isPaidCheckoutStatus,
} from "../lib/planEconomics.js"
import { planDefinitionFor, type ModelKey, type PlanDefinition } from "../lib/plans.js"
import { planForPriceId, priceIdForPlan, stripeClient, type PlanTier } from "../lib/stripe.js"
import { crawlPlusGrantUsd, grantedCreditsForConfig } from "./pricing.service.js"
import { creditTopup } from "./topup.service.js"
import type { CreateCheckoutSessionInput } from "../validators/billing.validator.js"
import { createNotification } from "./notification.service.js"

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

async function requireUser(userId: string): Promise<{ id: string; email: string; name: string }> {
  const db = requireDbPool()
  const { rows } = await db.query<{ id: string; email: string; name: string }>(
    "select id, email, name from users where id = $1",
    [userId],
  )
  const row = rows[0]
  if (!row) throw new AppError(404, "Account not found.")
  return row
}


/**
 * Stripe idempotency keys for user-initiated create calls. Stripe keeps a
 * key for 24 hours and replays the original response for a repeated key, so
 * a double click / concurrent request inside the same window gets the same
 * object instead of a second one. The window is part of the key so a user
 * who comes back later still gets a fresh Checkout/Portal session.
 */
export const STRIPE_SESSION_IDEMPOTENCY_WINDOW_MS = 60_000

export function stripeIdempotencyKey(kind: string, ...parts: string[]): string {
  const window = Math.floor(Date.now() / STRIPE_SESSION_IDEMPOTENCY_WINDOW_MS)
  return ["cm360", kind, ...parts, String(window)].join(":")
}

export async function getOrCreateStripeCustomer(userId: string): Promise<string> {
  const db = requireDbPool()
  const { rows } = await db.query<{ stripe_customer_id: string }>(
    "select stripe_customer_id from subscriptions where user_id = $1",
    [userId],
  )
  if (rows[0]) return rows[0].stripe_customer_id

  const user = await requireUser(userId)
  // CS-13 (B06-007): one key per user, so concurrent checkout/portal calls
  // get the same Stripe customer back instead of creating two.
  const customer = await stripeClient().customers.create(
    { email: user.email, name: user.name, metadata: { userId } },
    { ...CHECKOUT_STRIPE_REQUEST_OPTIONS, idempotencyKey: `cm360:customer:${userId}` },
  )

  // Never overwrite a customer id another request already stored: the
  // first writer wins and every caller returns that id.
  await db.query(
    `insert into subscriptions (user_id, stripe_customer_id, plan, status)
     values ($1, $2, 'free', 'inactive')
     on conflict (user_id) do nothing`,
    [userId, customer.id],
  )
  const { rows: stored } = await db.query<{ stripe_customer_id: string }>(
    "select stripe_customer_id from subscriptions where user_id = $1",
    [userId],
  )
  return stored[0]?.stripe_customer_id ?? customer.id
}


export async function createCheckoutSession(
  accessToken: string,
  input: CreateCheckoutSessionInput,
): Promise<{ url: string }> {
  requireCreditGrantingEnabled()
  const userId = requireUserId(accessToken)
  return withUserCheckoutLock(userId, async () => {
    // CS-13 (B06-005): a user who already holds an entitled paid
    // subscription must change it in the Billing Portal; a second Checkout
    // would create a second Stripe subscription billed in parallel.
    const { rows: current } = await requireDbPool().query<{ status: string; plan: string }>(
      "select status, plan from subscriptions where user_id = $1",
      [userId],
    )
    if (current[0] && isEntitledStatus(current[0].status) && current[0].plan !== "free") {
      throw new AppError(409, "You already have an active subscription. Use Manage billing to change or cancel it.")
    }
    const customerId = await getOrCreateStripeCustomer(userId)
    const priceId = priceIdForPlan(input.plan)
    const stripe = stripeClient()

    // At most one open subscription Checkout per customer: reuse it for the
    // same plan, expire it before opening one for a different plan. Done
    // under the per-user lock, so concurrent requests (double click across
    // an idempotency window, or two plans racing) cannot both open one.
    const open = await stripe.checkout.sessions.list({ customer: customerId, status: "open", limit: 20 }, CHECKOUT_STRIPE_REQUEST_OPTIONS)
    for (const existing of open.data ?? []) {
      if (existing.mode !== "subscription" || existing.metadata?.topupChatbotId) continue
      if (existing.metadata?.plan === input.plan && existing.url) {
        return { url: existing.url }
      }
      await stripe.checkout.sessions.expire(existing.id, {}, CHECKOUT_STRIPE_REQUEST_OPTIONS)
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${env.frontendUrl}/dashboard/billing?checkout=success`,
      cancel_url: `${env.frontendUrl}/dashboard/billing?checkout=cancelled`,
      metadata: { userId, plan: input.plan },
      subscription_data: { metadata: { userId, plan: input.plan } },
    }, { ...CHECKOUT_STRIPE_REQUEST_OPTIONS, idempotencyKey: stripeIdempotencyKey("checkout", userId, input.plan) })

    if (!session.url) throw new AppError(502, "Stripe did not return a checkout URL.")
    await incrementBillingMetric("billing.checkout_started", { userId, plan: input.plan, sessionId: session.id })
    return { url: session.url }
  })
}

/**
 * Stripe calls made while the per-user checkout lock (and its pool
 * connection) is held get a short timeout and at most one retry, so one slow
 * Stripe response cannot pin a connection for long.
 */
export const CHECKOUT_STRIPE_REQUEST_OPTIONS = { timeout: 10_000, maxNetworkRetries: 1 } as const

/** Upper bounds for the checkout-lock transaction (Postgres interval syntax). */
const CHECKOUT_LOCK_STATEMENT_TIMEOUT = "5s"
const CHECKOUT_LOCK_IDLE_IN_TRANSACTION_TIMEOUT = "30s"

const CHECKOUT_IN_PROGRESS_MESSAGE = "A checkout is already being opened for this account. Please wait a moment and try again."

function isPgLockOrStatementTimeout(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code
  // 55P03 lock_not_available, 57014 query_canceled (statement_timeout).
  return code === "55P03" || code === "57014"
}

/**
 * CS-13: serialize subscription-checkout creation per user across every API
 * instance with a transaction-scoped Postgres advisory lock. The lock is
 * only TRIED: a concurrent request gets 409 immediately instead of queueing
 * on a pool connection. The transaction carries its own statement and
 * idle-in-transaction timeouts, and the lock is released when it ends
 * (commit, rollback or a dropped connection).
 */
async function withUserCheckoutLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const client = await requireDbPool().connect()
  try {
    await client.query("BEGIN")
    await client.query(`SET LOCAL statement_timeout = '${CHECKOUT_LOCK_STATEMENT_TIMEOUT}'`)
    await client.query(`SET LOCAL idle_in_transaction_session_timeout = '${CHECKOUT_LOCK_IDLE_IN_TRANSACTION_TIMEOUT}'`)
    const { rows } = await client.query<{ locked: boolean }>(
      "select pg_try_advisory_xact_lock(hashtext($1)) as locked",
      [`cm360:checkout:${userId}`],
    )
    if (!rows[0]?.locked) {
      throw new AppError(409, CHECKOUT_IN_PROGRESS_MESSAGE)
    }
    const result = await fn()
    await client.query("COMMIT")
    return result
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {})
    if (isPgLockOrStatementTimeout(err)) throw new AppError(409, CHECKOUT_IN_PROGRESS_MESSAGE)
    throw err
  } finally {
    client.release()
  }
}

export type BillingSummary = {
  plan: PlanTier | "free"
  status: string
  planActive: boolean
  onHold: boolean
  currentPeriodEnd: string | null
  hasStripeCustomer: boolean
  stripeConfigured: boolean
  creditGrantsEnabled: boolean
}

export async function getBillingSummary(accessToken: string): Promise<BillingSummary> {
  const userId = requireUserId(accessToken)
  const db = requireDbPool()
  const { rows } = await db.query<{
    plan: string
    status: string
    current_period_end: Date | null
    stripe_customer_id: string | null
  }>("select plan, status, current_period_end, stripe_customer_id from subscriptions where user_id = $1", [userId])

  const row = rows[0]
  if (!row) {
    return {
      plan: "free",
      status: "inactive",
      planActive: false,
      onHold: false,
      currentPeriodEnd: null,
      hasStripeCustomer: false,
      stripeConfigured: Boolean(env.stripeSecretKey),
      creditGrantsEnabled: isCreditGrantingEnabled(),
    }
  }

  const plan = (row.plan as PlanTier | "free") || "free"
  return {
    plan,
    status: row.status,
    planActive: isEntitledStatus(row.status),
    onHold: isHeldPaidPlan(plan, row.status),
    currentPeriodEnd: row.current_period_end ? row.current_period_end.toISOString() : null,
    hasStripeCustomer: Boolean(row.stripe_customer_id),
    stripeConfigured: Boolean(env.stripeSecretKey),
    creditGrantsEnabled: isCreditGrantingEnabled(),
  }
}

export async function createBillingPortalSession(accessToken: string): Promise<{ url: string }> {
  const userId = requireUserId(accessToken)
  const customerId = await getOrCreateStripeCustomer(userId)
  const session = await stripeClient().billingPortal.sessions.create({
    customer: customerId,
    return_url: `${env.frontendUrl}/dashboard/billing`,
  }, { idempotencyKey: stripeIdempotencyKey("portal", userId) })
  if (!session.url) throw new AppError(502, "Stripe did not return a billing portal URL.")
  return { url: session.url }
}

async function upsertSubscriptionRow(fields: {
  userId?: string
  stripeCustomerId: string
  stripeSubscriptionId: string | null
  plan: PlanTier | "free"
  status: string
  currentPeriodEnd: Date | null
}): Promise<void> {
  const db = requireDbPool()

  // CS-13 (B06-005): a non-entitled state of some OTHER subscription (an
  // old, replaced or duplicate one) must never overwrite the row while it
  // holds a different, entitled subscription (or an admin-activated Full
  // Custom plan, which has no Stripe subscription id); otherwise a late
  // `deleted`/`past_due` for subscription A puts a user paying for
  // subscription B on hold.
  const staleOtherSubscription = (subscriptionParam: string, statusParam: string) =>
    `(
           (subscriptions.stripe_subscription_id is not null
             and subscriptions.stripe_subscription_id is distinct from ${subscriptionParam}::text)
           or (subscriptions.stripe_subscription_id is null and subscriptions.activated_at is not null)
         )
         and subscriptions.status in ('active', 'trialing')
         and ${statusParam}::text not in ('active', 'trialing')`

  if (fields.userId) {
    const { rowCount } = await db.query(
      `insert into subscriptions (user_id, stripe_customer_id, stripe_subscription_id, plan, status, current_period_end)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (user_id) do update set
         stripe_customer_id = excluded.stripe_customer_id,
         stripe_subscription_id = excluded.stripe_subscription_id,
         plan = excluded.plan,
         status = excluded.status,
         current_period_end = coalesce(excluded.current_period_end, subscriptions.current_period_end),
         updated_at = now()
       where not (${staleOtherSubscription("$3", "$5")})`,
      [fields.userId, fields.stripeCustomerId, fields.stripeSubscriptionId, fields.plan, fields.status, fields.currentPeriodEnd],
    )
    if (!rowCount) {
      log().warn(
        { userId: fields.userId, stripeSubscriptionId: fields.stripeSubscriptionId, status: fields.status },
        "stripe state of a different subscription ignored: the user holds another entitled subscription",
      )
    }
    return
  }

  const { rowCount } = await db.query(
    `update subscriptions set
       stripe_subscription_id = $1,
       plan = $2,
       status = $3,
       current_period_end = coalesce($4, current_period_end),
       updated_at = now()
     where stripe_customer_id = $5
       and not (${staleOtherSubscription("$1", "$3")})`,
    [fields.stripeSubscriptionId, fields.plan, fields.status, fields.currentPeriodEnd, fields.stripeCustomerId],
  )
  if (!rowCount) {
    log().warn(
      { stripeCustomerId: fields.stripeCustomerId, stripeSubscriptionId: fields.stripeSubscriptionId, status: fields.status },
      "stripe subscription state not applied: unknown customer, or a stale state of a different subscription",
    )
  }
}

async function monthlyGrantUsdForPlan(plan: PlanTier | "free"): Promise<number> {
  if (plan === "crawl_plus") return crawlPlusGrantUsd()
  if (plan === "full_custom") return env.fullCustomPlanMonthlyCostCapUsd
  return env.freePlanMonthlyCostCapUsd
}

async function assertPaidPlanGrantLessThanCash(plan: PlanTier | "free", amountTotalUsd: number): Promise<void> {
  if (plan === "free") return
  const grantedUsd = await monthlyGrantUsdForPlan(plan)
  assertGrantLessThanCash(grantedUsd, amountTotalUsd)
  log().info(
    { plan, ...creditGrantMetricFields(grantedUsd, amountTotalUsd) },
    "subscription monthly grant is less than cash collected",
  )
}

function planFromSubscription(subscription: Stripe.Subscription, fallbackMetadataPlan?: string): PlanTier | "free" {
  const priceId = subscription.items.data[0]?.price?.id
  const fromPrice = priceId ? planForPriceId(priceId) : null
  if (fromPrice) return fromPrice
  if (fallbackMetadataPlan === "crawl_plus" || fallbackMetadataPlan === "full_custom") {
    return fallbackMetadataPlan
  }
  return "free"
}

async function retrieveSubscription(subscriptionId: string): Promise<Stripe.Subscription> {
  return stripeClient().subscriptions.retrieve(subscriptionId, {
    expand: ["items.data.price"],
  })
}

function customerIdOf(subscription: Stripe.Subscription): string {
  return typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id
}

function isStripeResourceMissing(err: unknown): boolean {
  const e = err as { code?: string; statusCode?: number } | null
  return Boolean(e && (e.code === "resource_missing" || e.statusCode === 404))
}

/**
 * CS-13 (B06-005): Stripe does not deliver events in order, and a retried
 * old `customer.subscription.updated(active)` can arrive after `deleted`.
 * The event payload is a snapshot from when the event was created, so we
 * apply the subscription's CURRENT state from Stripe instead (as the
 * checkout and invoice paths already do). A replayed or out-of-order event
 * then re-applies the latest state rather than resurrecting an old one.
 */
async function currentSubscriptionState(
  fromEvent: Stripe.Subscription,
  eventType: string,
): Promise<Stripe.Subscription | null> {
  let current: Stripe.Subscription
  try {
    current = await retrieveSubscription(fromEvent.id)
  } catch (err) {
    // A deleted subscription Stripe no longer returns: the event's own
    // terminal state is the only information left.
    if (eventType === "customer.subscription.deleted" && isStripeResourceMissing(err)) return fromEvent
    throw err
  }
  if (customerIdOf(current) !== customerIdOf(fromEvent)) {
    log().warn(
      { subscriptionId: fromEvent.id, event: eventType },
      "stripe subscription event ignored: retrieved subscription belongs to a different customer",
    )
    return null
  }
  return current
}

function cashUsdFromInvoice(invoice: Stripe.Invoice): number | undefined {
  if (invoice.amount_paid == null || invoice.amount_paid <= 0) return undefined
  return cashUsdFromStripeAmount(invoice.amount_paid, invoice.currency)
}

// Reverses accessGate.service.ts's persistTrialDeactivation once a user
// actually pays — clears the SAME flag it set, so a chatbot that stopped
// answering on trial expiry starts answering again right after checkout,
// without waiting for anything else to re-derive that on its own.
// userIdHint covers the checkout.session.completed path (userId already
// known from session metadata); the subscription.updated/deleted webhooks
// don't carry it, so those fall back to the subscriptions row this same
// function just upserted.
async function clearTrialDeactivationIfEntitled(status: string, stripeCustomerId: string, userIdHint?: string): Promise<void> {
  if (!isEntitledStatus(status) || !pool) return
  const userId = userIdHint ?? (await pool
    .query<{ user_id: string }>("select user_id from subscriptions where stripe_customer_id = $1", [stripeCustomerId])
    .then((r) => r.rows[0]?.user_id))
  if (!userId) {
    console.log(`[billing.service] clearTrialDeactivationIfEntitled: no user_id found for stripeCustomerId=${stripeCustomerId}, skipping`)
    return
  }
  console.log(`[billing.service] clearTrialDeactivationIfEntitled: userId=${userId} status=${status}`)
  try {
    await pool.query("update users set trial_deactivated = false where id = $1 and trial_deactivated = true", [userId])
  } catch (err) {
    console.error(`[billing.service] clearTrialDeactivationIfEntitled: FAILED userId=${userId}`, err)
    log().warn({ userId, err: err instanceof Error ? err.message : String(err) }, "failed to clear trial deactivation")
  }
}

async function syncFromSubscription(
  subscription: Stripe.Subscription,
  options: { userId?: string; cashUsd?: number; fallbackPeriodEnd?: Date } = {},
): Promise<void> {
  const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id
  const plan = planFromSubscription(subscription, subscription.metadata?.plan)

  if (isEntitledStatus(subscription.status) && plan !== "free") {
    requireCreditGrantingEnabled()
    const cashUsd = options.cashUsd ?? cashUsdFromSubscriptionItem(subscription.items.data[0])
    await assertPaidPlanGrantLessThanCash(plan, cashUsd)
  }

  await upsertSubscriptionRow({
    userId: options.userId,
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscription.id,
    plan,
    status: subscription.status,
    currentPeriodEnd: periodEndFromStripeSubscription(subscription) ?? options.fallbackPeriodEnd ?? null,
  })

  await clearTrialDeactivationIfEntitled(subscription.status, customerId, options.userId)
}


export function verifyStripeWebhookSignature(rawBody: Buffer, signature: string): Stripe.Event {
  return stripeClient().webhooks.constructEvent(rawBody, signature, env.stripeWebhookSecret)
}

// HTTP callers must go through receiveVerifiedStripeEvent (WP-1.3 inbox).
// This function is the grant/sync handler only — it is not itself idempotent
// at the event-id layer; the inbox + checkout-session unique key are.
async function activatePaidCheckoutSession(session: Stripe.Checkout.Session, eventType: string): Promise<void> {
  if (!isPaidCheckoutStatus(session.payment_status)) {
    log().warn(
      { sessionId: session.id, payment_status: session.payment_status ?? "missing", event: eventType },
      "checkout session ignored — payment is not paid",
    )
    return
  }

  if (session.metadata?.topupChatbotId) {
    // CS-13: a top-up grants credits only for money actually collected.
    // "no_payment_required" is fine for a trialing subscription checkout,
    // never for a one-off credit purchase.
    if (session.payment_status !== "paid") {
      log().warn(
        { sessionId: session.id, payment_status: session.payment_status ?? "missing", event: eventType },
        "top-up checkout ignored: not a paid one-off payment",
      )
      return
    }
    const amountTotalUsd = cashUsdFromStripeAmount(session.amount_total, session.currency)
    const packageName = session.metadata.topupPackage || "topup_starter"
    const creditedUsd = await grantedCreditsForConfig(packageName, env.topupCreditUsd)
    await creditTopup(
      session.metadata.topupChatbotId,
      session.metadata.topupModel ?? "unknown",
      session.metadata.topupBillingPeriod ?? "unknown",
      creditedUsd,
      session.id,
      amountTotalUsd,
    )
    log().info(
      {
        chatbotId: session.metadata.topupChatbotId,
        model: session.metadata.topupModel,
        event: eventType,
        ...creditGrantMetricFields(creditedUsd, amountTotalUsd),
      },
      "stripe top-up checkout completed",
    )
    await import("./documentIngestion.service.js")
      .then((mod) => mod.resumePausedIngests(session.metadata!.topupChatbotId!))
      .catch((err) => {
        log().warn(
          { err: err instanceof Error ? err.message : String(err), chatbotId: session.metadata?.topupChatbotId },
          "resume paused ingest after top-up failed",
        )
      })
    if (pool && session.metadata.topupChatbotId) {
      const { rows: owner } = await pool.query<{ user_id: string; email: string }>(
        `select u.id as user_id, u.email from chatbots c join users u on u.id = c.user_id where c.id = $1`,
        [session.metadata.topupChatbotId],
      )
      if (owner[0]) {
        await createNotification({
          userId: owner[0].user_id,
          type: "payment",
          title: "Usage top-up confirmed",
          body: `A $${creditedUsd} credit was added for ${session.metadata.topupModel || "your model"}.`,
          emailTo: owner[0].email,
          metadata: { chatbotId: session.metadata.topupChatbotId },
        })
      }
    }
    return
  }

  const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id
  if (!subscriptionId) {
    log().warn({ sessionId: session.id, event: eventType }, "paid checkout has no subscription id")
    return
  }

  const subscription = await retrieveSubscription(subscriptionId)
  const plan = planFromSubscription(subscription, session.metadata?.plan)
  const amountTotalUsd = cashUsdFromStripeAmount(session.amount_total, session.currency)
  requireCreditGrantingEnabled()
  await assertPaidPlanGrantLessThanCash(plan, amountTotalUsd)
  await syncFromSubscription(subscription, {
    userId: session.metadata?.userId,
    cashUsd: amountTotalUsd,
    fallbackPeriodEnd: addOneBillingPeriod(new Date()),
  })
  await incrementBillingMetric("billing.checkout_activated", {
    userId: session.metadata?.userId,
    plan,
    sessionId: session.id,
    stripeSubscriptionId: subscription.id,
  })
  log().info(
    {
      userId: session.metadata?.userId,
      plan,
      event: eventType,
      ...creditGrantMetricFields(await monthlyGrantUsdForPlan(plan), amountTotalUsd),
    },
    "stripe checkout completed",
  )
  if (session.metadata?.userId) {
    const { rows: userRows } = await requireDbPool().query<{ email: string }>(
      "select email from users where id = $1",
      [session.metadata.userId],
    )
    await createNotification({
      userId: session.metadata.userId,
      type: "payment",
      title: "Subscription payment received",
      body: `Your ${paidPlanLabel(session.metadata.plan || plan)} plan is now active.`,
      emailTo: userRows[0]?.email,
      metadata: { plan: session.metadata.plan || plan },
    })
  }
}

async function activateFromPaidInvoice(invoice: Stripe.Invoice, eventType: string): Promise<void> {
  const subscriptionId = invoiceSubscriptionId(invoice)
  if (!subscriptionId) {
    log().debug({ event: eventType, invoiceId: invoice.id }, "paid invoice has no subscription id")
    return
  }

  const subscription = await retrieveSubscription(subscriptionId)
  const cashUsd = cashUsdFromInvoice(invoice)
  await syncFromSubscription(subscription, {
    userId: subscription.metadata?.userId,
    cashUsd,
    fallbackPeriodEnd: addOneBillingPeriod(new Date()),
  })
  log().info(
    { subscriptionId: subscription.id, status: subscription.status, event: eventType },
    "stripe invoice paid — subscription synced",
  )

  if (invoice.billing_reason === "subscription_create") return
  if (!isEntitledStatus(subscription.status)) return

  const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id
  if (!customerId || !pool) return
  const { rows } = await pool.query<{ user_id: string; email: string; plan: string; current_period_end: Date | null }>(
    `select u.id as user_id, u.email, s.plan, s.current_period_end
       from subscriptions s
       join users u on u.id = s.user_id
      where s.stripe_customer_id = $1`,
    [customerId],
  )
  if (!rows[0]) return
  const periodEnd = rows[0].current_period_end
  await createNotification({
    userId: rows[0].user_id,
    type: "payment",
    title: "Subscription payment received",
    body: periodEnd
      ? `Your ${paidPlanLabel(rows[0].plan)} plan is active. Next billing is ${periodEnd.toISOString()}.`
      : `Your ${paidPlanLabel(rows[0].plan)} plan is active again.`,
    emailTo: rows[0].email,
    metadata: { plan: rows[0].plan, kind: "invoice_paid" },
  })
}

export async function processStripeWebhookEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      await activatePaidCheckoutSession(event.data.object as Stripe.Checkout.Session, event.type)
      break
    }
    case "invoice.paid":
    case "invoice.payment_succeeded": {
      await activateFromPaidInvoice(event.data.object as Stripe.Invoice, event.type)
      break
    }
    case "customer.subscription.updated": {
      const subscription = await currentSubscriptionState(event.data.object as Stripe.Subscription, event.type)
      if (!subscription) break
      await syncFromSubscription(subscription)
      log().info({ subscriptionId: subscription.id, status: subscription.status, event: event.type }, "stripe subscription updated")
      break
    }
    case "customer.subscription.deleted": {
      const subscription = await currentSubscriptionState(event.data.object as Stripe.Subscription, event.type)
      if (!subscription) break
      await syncFromSubscription(subscription)
      log().info({ subscriptionId: subscription.id, event: event.type }, "stripe subscription canceled")
      const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id
      if (pool) {
        const { rows } = await pool.query<{ user_id: string; email: string }>(
          `select u.id as user_id, u.email from subscriptions s join users u on u.id = s.user_id where s.stripe_customer_id = $1`,
          [customerId],
        )
        if (rows[0]) {
          await createNotification({
            userId: rows[0].user_id,
            type: "subscription",
            title: "Subscription ended",
            body: "Payment was not kept current. Your dashboard is on the Free plan and your paid plan is on hold until you pay again.",
            emailTo: rows[0].email,
          })
        }
      }
      break
    }
    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice
      const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id
      if (!customerId) break
      const db = requireDbPool()
      // CS-13 (B06-005): only a failed invoice of the subscription this row
      // currently holds puts it on hold. A failed invoice of an old or
      // duplicate subscription, or one with no subscription at all, must not
      // suspend the user's current (Stripe or admin-activated) plan.
      const failedSubscriptionId = invoiceSubscriptionId(invoice)
      if (failedSubscriptionId) {
        await db.query(
          `update subscriptions set status = 'past_due', updated_at = now()
           where stripe_customer_id = $1 and stripe_subscription_id = $2`,
          [customerId, failedSubscriptionId],
        )
      }
      log().warn({ stripeCustomerId: customerId, event: event.type }, "stripe invoice payment failed")
      const { rows } = await db.query<{ user_id: string; email: string }>(
        `select u.id as user_id, u.email from subscriptions s join users u on u.id = s.user_id where s.stripe_customer_id = $1`,
        [customerId],
      )
      if (rows[0]) {
        await createNotification({
          userId: rows[0].user_id,
          type: "payment",
          title: "Payment failed",
          body: "We couldn't charge your card. Your paid plan is on hold and the dashboard is on Free until you pay. Update your payment method to restore paid features.",
          emailTo: rows[0].email,
        })
      }
      break
    }
    default:
      log().debug({ event: event.type }, "unhandled stripe webhook event type")
  }
}


export interface Entitlement extends PlanDefinition {
  active: boolean
}

function entitlementFor(plan: PlanTier | "free", active: boolean): Entitlement {
  const definition = planDefinitionFor(plan)
  // While uploads are paused (DOCUMENT_SCAN_PAUSE_UPLOADS, e.g. ClamAV switched
  // off to save memory: deploy/aws/docker-compose.no-clamav.yml), chat
  // attachments are off for every plan. The widget reads this and hides its
  // attach button, instead of letting visitors hit a scan-unavailable error.
  const chatAttachments = env.documentScanPauseUploads
    ? { ...definition.chatAttachments, enabled: false }
    : definition.chatAttachments
  return { ...definition, chatAttachments, active }
}

interface EntitlementOverrideRow {
  custom_daily_cap_usd: string | null
  custom_weekly_cap_usd: string | null
  custom_monthly_cap_usd: string | null
  custom_limit_action: string | null
  custom_allowed_models: ModelKey[] | null
}

// A per-tenant override (set by an admin for a Full Custom contract, see
// admin.service.ts's updateTenantOverride) always wins over the plan
// default when present — this is what makes Custom "configuration, not a
// separate code path" (tokenallocation.md §7). Every field is independently
// optional: a tenant can have a custom monthly cap but still use the plan's
// default daily/weekly caps, for example.
function applyEntitlementOverrides(entitlement: Entitlement, override: EntitlementOverrideRow | undefined): Entitlement {
  if (!override) return entitlement
  return {
    ...entitlement,
    perModelDailyCapUsd: override.custom_daily_cap_usd !== null ? Number(override.custom_daily_cap_usd) : entitlement.perModelDailyCapUsd,
    perModelWeeklyCapUsd: override.custom_weekly_cap_usd !== null ? Number(override.custom_weekly_cap_usd) : entitlement.perModelWeeklyCapUsd,
    perModelCapUsd: override.custom_monthly_cap_usd !== null ? Number(override.custom_monthly_cap_usd) : entitlement.perModelCapUsd,
    limitAction: (override.custom_limit_action as PlanDefinition["limitAction"] | null) ?? entitlement.limitAction,
    allowedModels: override.custom_allowed_models ?? entitlement.allowedModels,
  }
}

const ENTITLEMENT_OVERRIDE_COLUMNS = `
  s.custom_daily_cap_usd, s.custom_weekly_cap_usd, s.custom_monthly_cap_usd,
  s.custom_limit_action, s.custom_allowed_models
`


export function isEntitledStatus(status: string): boolean {
  return status === "active" || status === "trialing"
}

export function isHeldPaidPlan(plan: string | null | undefined, status: string | null | undefined): boolean {
  if (plan !== "crawl_plus" && plan !== "full_custom") return false
  return !isEntitledStatus(status ?? "")
}

// One query for every user due this tick, not one query per row — the
// 2026-09-29 production-hardening audit flagged the original per-row
// `hasSubscriptionNotice` shape (a query inside a `for` loop, once per due
// subscription) as a tick-duration cost that scales linearly with tenant
// count. Bounded today by how few subscriptions are due per tick; at 10k
// paying tenants the due-per-day count no longer is. Returns the set of
// "already notified" keys (`${userId}|${periodEndIso}`) for O(1) in-memory
// membership checks instead of a round trip per row.
async function existingNoticeKeys(kind: string, userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set()
  const { rows } = await requireDbPool().query<{ user_id: string; period_end: string }>(
    `select user_id, metadata->>'periodEnd' as period_end
       from notifications
      where type = 'subscription'
        and metadata->>'kind' = $1
        and user_id = any($2::uuid[])`,
    [kind, userIds],
  )
  return new Set(rows.map((row) => `${row.user_id}|${row.period_end}`))
}

export async function runBillingLifecycleTick(): Promise<{ held: number; reminded: number }> {
  const db = requireDbPool()
  const minDays = env.billingRenewalAlertMinDays
  const maxDays = Math.max(minDays, env.billingRenewalAlertMaxDays)

  const held = await db.query<{ user_id: string; plan: string; email: string; current_period_end: Date }>(
    `update subscriptions s
        set status = 'unpaid', updated_at = now()
       from users u
      where u.id = s.user_id
        and s.plan in ('crawl_plus', 'full_custom')
        and s.status in ('active', 'trialing')
        and s.current_period_end is not null
        and s.current_period_end < now()
    returning s.user_id, s.plan, u.email, s.current_period_end`,
  )

  const alreadyHeldNotified = await existingNoticeKeys(
    "plan_hold",
    held.rows.map((row) => row.user_id),
  )
  for (const row of held.rows) {
    const periodEndIso = row.current_period_end.toISOString()
    if (alreadyHeldNotified.has(`${row.user_id}|${periodEndIso}`)) continue
    await createNotification({
      userId: row.user_id,
      type: "subscription",
      title: `${paidPlanLabel(row.plan)} is on hold`,
      body: `Payment was not received, so your dashboard is on the Free plan. Your ${paidPlanLabel(row.plan)} account is saved and will unlock as soon as you pay.`,
      emailTo: row.email,
      metadata: { kind: "plan_hold", plan: row.plan, periodEnd: periodEndIso },
    })
  }

  const due = await db.query<{ user_id: string; plan: string; email: string; current_period_end: Date }>(
    `select s.user_id, s.plan, u.email, s.current_period_end
       from subscriptions s
       join users u on u.id = s.user_id
      where s.plan in ('crawl_plus', 'full_custom')
        and s.status in ('active', 'trialing')
        and s.current_period_end is not null
        and s.current_period_end > now()
        and s.current_period_end <= now() + ($1 * interval '1 day')
        and s.current_period_end >= now() + ($2 * interval '1 day')`,
    [maxDays, minDays],
  )

  const alreadyReminded = await existingNoticeKeys(
    "renewal_reminder",
    due.rows.map((row) => row.user_id),
  )
  let reminded = 0
  for (const row of due.rows) {
    const periodEndIso = row.current_period_end.toISOString()
    if (alreadyReminded.has(`${row.user_id}|${periodEndIso}`)) continue
    await createNotification({
      userId: row.user_id,
      type: "subscription",
      title: `${paidPlanLabel(row.plan)} renews soon`,
      body: `Your ${paidPlanLabel(row.plan)} plan renews on ${row.current_period_end.toLocaleString("en-US", { dateStyle: "long", timeStyle: "short" })}. Pay before then to keep paid features. If payment is not received, your dashboard will switch to Free and ${paidPlanLabel(row.plan)} will be on hold.`,
      emailTo: row.email,
      metadata: { kind: "renewal_reminder", plan: row.plan, periodEnd: periodEndIso },
    })
    reminded += 1
  }

  if (held.rowCount) {
    log().info({ held: held.rowCount, reminded }, "billing lifecycle placed unpaid plans on hold")
  }

  return { held: held.rowCount ?? held.rows.length, reminded }
}


export async function getEntitlementForChatbot(chatbotId: string): Promise<Entitlement> {
  if (!pool) return entitlementFor("free", false)

  // Determining a chatbot's plan is a system-level lookup, not tenant data
  // access gated by the CALLER's own scope — this is called from "public"
  // scope (the real public widget chat, and Bookly admin-chat, both keyed
  // only by chatbotId, no userId) as much as from an authenticated owner
  // scope. subscriptions' RLS policy is keyed by user_id, so without this,
  // any "public"-scope caller sees zero rows here and every paying
  // customer's chatbot silently falls back to free-tier entitlement.
  // Confirmed live: Bookly admin-chat's full_custom plan check failed
  // (402) against a real seeded full_custom subscription until this was
  // wrapped, exactly like checkAnsweringGate's earlier fix for the same
  // users_isolation policy shape.
  const { rows } = await runWithSystemContext(() =>
    pool!.query<{ plan: string; status: string } & EntitlementOverrideRow>(
      `select s.plan, s.status, ${ENTITLEMENT_OVERRIDE_COLUMNS}
       from subscriptions s
       join chatbots c on c.user_id = s.user_id
       where c.id = $1`,
      [chatbotId],
    ),
  )
  const row = rows[0]
  const active = Boolean(row && isEntitledStatus(row.status))
  if (!active || !row) return entitlementFor("free", false)
  return applyEntitlementOverrides(entitlementFor(row.plan as PlanTier, true), row)
}

export async function getEntitlementForUser(userId: string): Promise<Entitlement> {
  const db = requireDbPool()
  const { rows } = await db.query<{ plan: string; status: string } & EntitlementOverrideRow>(
    `select plan, status, ${ENTITLEMENT_OVERRIDE_COLUMNS} from subscriptions s where user_id = $1`,
    [userId],
  )
  const row = rows[0]
  const active = Boolean(row && isEntitledStatus(row.status))
  if (!active || !row) return entitlementFor("free", false)
  return applyEntitlementOverrides(entitlementFor(row.plan as PlanTier, true), row)
}
