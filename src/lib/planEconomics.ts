export interface SaleEconomicsInput {
  revenueUsd: number
  stripeFeeUsd: number
  platformOverheadUsd: number
  targetProfitUsd: number
}

export interface SaleEconomics {
  revenueUsd: number
  stripeFeeUsd: number
  platformOverheadUsd: number
  availableAfterFeesUsd: number
  targetProfitUsd: number
  maximumSafeCreditsUsd: number
  aiBudgetRatio: number
  profitRatio: number
}

export interface CreditGrantConfig {
  topupCreditUsd: number
  topupSaleUsd: number
  crawlPlusMonthlyGrantUsd: number
  crawlPlusSaleUsd: number
  fullCustomMonthlyGrantUsd?: number
  fullCustomSaleUsd?: number
}

/**
 * Default list prices used only when the matching env var is unset.
 * Runtime and startup validation always compare grant against configured sale,
 * never against these numbers directly.
 */
export const DEFAULT_TOPUP_SALE_USD = 10
export const DEFAULT_CRAWL_PLUS_SALE_USD = 20

export class CreditGrantInvariantError extends Error {
  readonly grantedUsd: number
  readonly amountTotalUsd: number

  constructor(grantedUsd: number, amountTotalUsd: number, message?: string) {
    super(message ?? `Credit grant ${grantedUsd} is not less than cash collected ${amountTotalUsd}.`)
    this.name = "CreditGrantInvariantError"
    this.grantedUsd = grantedUsd
    this.amountTotalUsd = amountTotalUsd
  }
}

export function usdFromStripeCents(amountTotalCents: number | null | undefined): number {
  if (amountTotalCents == null || !Number.isFinite(amountTotalCents)) return 0
  return roundUsd(amountTotalCents / 100)
}

export function creditGrantMetricFields(grantedUsd: number, amountTotalUsd: number) {
  return {
    amount_total: amountTotalUsd,
    granted_usd: grantedUsd,
    "billing.grant_usd": grantedUsd,
    "billing.amount_total_usd": amountTotalUsd,
  }
}

export function isPaidCheckoutStatus(paymentStatus: string | null | undefined): boolean {
  return paymentStatus === "paid" || paymentStatus === "no_payment_required"
}

export function cashUsdFromStripeAmount(amountCents: number | null | undefined, currency: string | null | undefined): number {
  const normalized = (currency ?? "").trim().toLowerCase()
  if (normalized !== "usd") {
    throw new CreditGrantInvariantError(
      0,
      usdFromStripeCents(amountCents),
      `Refusing non-USD cash amount (currency=${currency ?? "missing"}).`,
    )
  }
  return usdFromStripeCents(amountCents)
}

export function cashUsdFromSubscriptionItem(item: {
  quantity?: number | null
  price?: { unit_amount?: number | null; currency?: string | null } | null
} | null | undefined): number {
  const unitAmount = item?.price?.unit_amount
  if (unitAmount == null || !Number.isFinite(unitAmount)) {
    throw new CreditGrantInvariantError(0, 0, "Subscription price unit_amount is missing.")
  }
  const quantity = item?.quantity == null || !Number.isFinite(item.quantity) ? 1 : item.quantity
  return cashUsdFromStripeAmount(unitAmount * quantity, item?.price?.currency)
}

/**
 * Fail closed: AI dollars granted must be strictly less than cash collected
 * or the configured sale price. Comparison is in cents to avoid float noise.
 */
export function assertGrantLessThanCash(grantedUsd: number, amountTotalUsd: number): void {
  if (!Number.isFinite(grantedUsd) || grantedUsd < 0) {
    throw new CreditGrantInvariantError(
      grantedUsd,
      amountTotalUsd,
      "Granted credit must be a finite non-negative number.",
    )
  }
  if (!Number.isFinite(amountTotalUsd) || amountTotalUsd <= 0) {
    throw new CreditGrantInvariantError(
      grantedUsd,
      amountTotalUsd,
      "Cash collected must be a finite positive amount.",
    )
  }
  if (usdToCents(grantedUsd) >= usdToCents(amountTotalUsd)) {
    throw new CreditGrantInvariantError(grantedUsd, amountTotalUsd)
  }
}

export function assertConfiguredGrantsLessThanCash(config: CreditGrantConfig): void {
  assertGrantLessThanCash(config.topupCreditUsd, config.topupSaleUsd)
  assertGrantLessThanCash(config.crawlPlusMonthlyGrantUsd, config.crawlPlusSaleUsd)
  if (config.fullCustomSaleUsd != null && config.fullCustomSaleUsd > 0 && config.fullCustomMonthlyGrantUsd != null) {
    assertGrantLessThanCash(config.fullCustomMonthlyGrantUsd, config.fullCustomSaleUsd)
  }
}

export function evaluateCreditGrantConfig(config: CreditGrantConfig): string | null {
  try {
    assertConfiguredGrantsLessThanCash(config)
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

export function computeSaleEconomics(input: SaleEconomicsInput): SaleEconomics {
  const { revenueUsd, stripeFeeUsd, platformOverheadUsd, targetProfitUsd } = input
  if (![revenueUsd, stripeFeeUsd, platformOverheadUsd, targetProfitUsd].every((n) => Number.isFinite(n) && n >= 0)) {
    throw new Error("Sale economics values must be finite and non-negative.")
  }
  if (stripeFeeUsd + platformOverheadUsd + targetProfitUsd > revenueUsd) {
    throw new Error("Fees, overhead, and target profit exceed revenue — this package loses money.")
  }

  const availableAfterFeesUsd = roundUsd(revenueUsd - stripeFeeUsd - platformOverheadUsd)
  const maximumSafeCreditsUsd = roundUsd(availableAfterFeesUsd - targetProfitUsd)
  assertGrantLessThanCash(maximumSafeCreditsUsd, revenueUsd)

  return {
    revenueUsd,
    stripeFeeUsd,
    platformOverheadUsd,
    availableAfterFeesUsd,
    targetProfitUsd,
    maximumSafeCreditsUsd,
    aiBudgetRatio: revenueUsd === 0 ? 0 : maximumSafeCreditsUsd / revenueUsd,
    profitRatio: revenueUsd === 0 ? 0 : targetProfitUsd / revenueUsd,
  }
}

export function grantedCreditsFromSale(saleUsd: number, aiBudgetRatio: number): number {
  if (!Number.isFinite(saleUsd) || saleUsd < 0 || !Number.isFinite(aiBudgetRatio) || aiBudgetRatio < 0) {
    throw new Error("Sale amount and AI budget ratio must be finite and non-negative.")
  }
  const grantedUsd = roundUsd(saleUsd * aiBudgetRatio)
  assertGrantLessThanCash(grantedUsd, saleUsd)
  return grantedUsd
}

/**
 * Same ledger as Crawl Plus (WP-2.6 / ADR): safe monthly AI credits are the
 * configured AI-budget ratio applied to attested cash. Always < cash.
 */
export function safeCreditsFromCash(cashCollectedUsd: number, aiBudgetRatio: number): number {
  return grantedCreditsFromSale(cashCollectedUsd, aiBudgetRatio)
}

export function usdGreaterThan(leftUsd: number, rightUsd: number): boolean {
  return usdToCents(leftUsd) > usdToCents(rightUsd)
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100
}

function usdToCents(usd: number): number {
  return Math.round(usd * 100)
}

/** Default Crawl Plus package. List price is overridable via CRAWL_PLUS_SALE_USD. */
export const CRAWL_PLUS_20 = computeSaleEconomics({
  revenueUsd: DEFAULT_CRAWL_PLUS_SALE_USD,
  stripeFeeUsd: 1.1,
  platformOverheadUsd: 0.5,
  targetProfitUsd: 10.4,
})

export const DEFAULT_STRIPE_PERCENT = 0.029
export const DEFAULT_STRIPE_FIXED_USD = 0.3
export const DEFAULT_PLATFORM_OVERHEAD_USD = 0.5
export const DEFAULT_RESERVE_BUFFER_PERCENT = 0.05
export const DEFAULT_TARGET_PROFIT_PERCENT = 0.52

export type ConfigurablePricingInput = {
  priceUsd: number
  stripePercent?: number
  stripeFixedUsd?: number
  platformOverheadUsd?: number
  reserveBufferPercent?: number
  targetProfitPercent?: number
}

export type ConfigurablePricing = {
  priceUsd: number
  stripeFeeUsd: number
  netAfterStripeUsd: number
  netAfterOverheadUsd: number
  reserveUsd: number
  netAfterReserveUsd: number
  profitUsd: number
  computedAiCreditsUsd: number
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

/**
 * Admin-configurable credit allocation. Invariant: computed credits < price.
 * Rounded to 4dp so the stored NUMERIC(10,4) matches the check constraint.
 */
export function computeConfigurablePricing(input: ConfigurablePricingInput): ConfigurablePricing {
  const priceUsd = input.priceUsd
  const stripePercent = input.stripePercent ?? DEFAULT_STRIPE_PERCENT
  const stripeFixedUsd = input.stripeFixedUsd ?? DEFAULT_STRIPE_FIXED_USD
  const platformOverheadUsd = input.platformOverheadUsd ?? DEFAULT_PLATFORM_OVERHEAD_USD
  const reserveBufferPercent = input.reserveBufferPercent ?? DEFAULT_RESERVE_BUFFER_PERCENT
  const targetProfitPercent = input.targetProfitPercent ?? DEFAULT_TARGET_PROFIT_PERCENT

  if (![priceUsd, stripePercent, stripeFixedUsd, platformOverheadUsd, reserveBufferPercent, targetProfitPercent].every(
    (n) => Number.isFinite(n) && n >= 0,
  )) {
    throw new CreditGrantInvariantError(0, priceUsd, "Pricing inputs must be finite and non-negative.")
  }

  const stripeFeeUsd = round4(priceUsd * stripePercent + stripeFixedUsd)
  const netAfterStripeUsd = round4(priceUsd - stripeFeeUsd)
  const netAfterOverheadUsd = round4(netAfterStripeUsd - platformOverheadUsd)
  const reserveUsd = round4(netAfterOverheadUsd * reserveBufferPercent)
  const netAfterReserveUsd = round4(netAfterOverheadUsd - reserveUsd)
  const profitUsd = round4(netAfterReserveUsd * targetProfitPercent)
  const computedAiCreditsUsd = round4(netAfterReserveUsd - profitUsd)

  assertGrantLessThanCash(computedAiCreditsUsd, priceUsd)
  return {
    priceUsd,
    stripeFeeUsd,
    netAfterStripeUsd,
    netAfterOverheadUsd,
    reserveUsd,
    netAfterReserveUsd,
    profitUsd,
    computedAiCreditsUsd,
  }
}
