import { pool } from "../lib/db.js"
import { AppError } from "../lib/errors.js"
import {
  computeConfigurablePricing,
  DEFAULT_PLATFORM_OVERHEAD_USD,
  DEFAULT_RESERVE_BUFFER_PERCENT,
  DEFAULT_STRIPE_FIXED_USD,
  DEFAULT_STRIPE_PERCENT,
  DEFAULT_TARGET_PROFIT_PERCENT,
  type ConfigurablePricingInput,
} from "../lib/planEconomics.js"
import { env } from "../env.js"
import { runWithSystemContext } from "../lib/tenantContext.js"

export type PricingPlanType = "subscription" | "topup"

export type PricingConfigRow = {
  id: string
  configName: string
  planType: PricingPlanType
  priceUsd: number
  stripePercent: number
  stripeFixedUsd: number
  platformOverheadUsd: number
  reserveBufferPercent: number
  targetProfitPercent: number
  computedAiCredits: number
  stripePriceId: string | null
  isActive: boolean
  effectiveFrom: string
  createdAt: string
}

export type PricingConfigDraft = ConfigurablePricingInput & {
  configName: string
  planType: PricingPlanType
  stripePriceId?: string | null
}

function requireDb() {
  if (!pool) throw new AppError(503, "Database is not configured.")
  return pool
}

function mapRow(row: Record<string, unknown>): PricingConfigRow {
  return {
    id: row.id as string,
    configName: row.config_name as string,
    planType: row.plan_type as PricingPlanType,
    priceUsd: Number(row.price_usd),
    stripePercent: Number(row.stripe_percent),
    stripeFixedUsd: Number(row.stripe_fixed_usd),
    platformOverheadUsd: Number(row.platform_overhead_usd),
    reserveBufferPercent: Number(row.reserve_buffer_percent),
    targetProfitPercent: Number(row.target_profit_percent),
    computedAiCredits: Number(row.computed_ai_credits),
    stripePriceId: (row.stripe_price_id as string | null) ?? null,
    isActive: Boolean(row.is_active),
    effectiveFrom: (row.effective_from as Date).toISOString(),
    createdAt: (row.created_at as Date).toISOString(),
  }
}

export async function listPricingConfigs(includeInactive = false): Promise<PricingConfigRow[]> {
  const db = requireDb()
  return runWithSystemContext(async () => {
    const { rows } = await db.query(
      `select * from pricing_configs
        ${includeInactive ? "" : "where is_active"}
        order by plan_type, price_usd, effective_from desc`,
    )
    return rows.map(mapRow)
  })
}

export async function getActivePricingConfig(configName: string): Promise<PricingConfigRow | null> {
  if (!pool) return null
  return runWithSystemContext(async () => {
    const { rows } = await pool!.query(
      `select * from pricing_configs
        where config_name = $1 and is_active
        order by effective_from desc
        limit 1`,
      [configName],
    )
    return rows[0] ? mapRow(rows[0]) : null
  })
}

export async function grantedCreditsForConfig(configName: string, fallbackUsd: number): Promise<number> {
  const row = await getActivePricingConfig(configName)
  return row ? row.computedAiCredits : fallbackUsd
}

export async function saleUsdForConfig(configName: string, fallbackUsd: number): Promise<number> {
  const row = await getActivePricingConfig(configName)
  return row ? row.priceUsd : fallbackUsd
}

/**
 * Never UPDATE an active row. Insert a new version and deactivate the previous
 * one so historical grants remain auditable.
 */
export async function savePricingConfig(draft: PricingConfigDraft): Promise<PricingConfigRow> {
  const db = requireDb()
  const computed = computeConfigurablePricing(draft)
  return runWithSystemContext(async () => {
    await db.query("begin")
    try {
      await db.query(
        `update pricing_configs set is_active = false
          where config_name = $1 and is_active`,
        [draft.configName],
      )
      const { rows } = await db.query(
        `insert into pricing_configs (
           config_name, plan_type, price_usd, stripe_percent, stripe_fixed_usd,
           platform_overhead_usd, reserve_buffer_percent, target_profit_percent,
           computed_ai_credits, stripe_price_id, is_active
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)
         returning *`,
        [
          draft.configName,
          draft.planType,
          draft.priceUsd,
          draft.stripePercent ?? DEFAULT_STRIPE_PERCENT,
          draft.stripeFixedUsd ?? DEFAULT_STRIPE_FIXED_USD,
          draft.platformOverheadUsd ?? DEFAULT_PLATFORM_OVERHEAD_USD,
          draft.reserveBufferPercent ?? DEFAULT_RESERVE_BUFFER_PERCENT,
          draft.targetProfitPercent ?? DEFAULT_TARGET_PROFIT_PERCENT,
          computed.computedAiCreditsUsd,
          draft.stripePriceId ?? null,
        ],
      )
      await db.query("commit")
      return mapRow(rows[0])
    } catch (err) {
      await db.query("rollback").catch(() => undefined)
      throw err
    }
  })
}

export async function deactivatePricingConfig(configName: string): Promise<void> {
  const db = requireDb()
  await runWithSystemContext(async () => {
    const { rowCount } = await db.query(
      `update pricing_configs set is_active = false where config_name = $1 and is_active`,
      [configName],
    )
    if (!rowCount) throw new AppError(404, "Pricing config not found.")
  })
}

export type RecalculatePreview = {
  configName: string
  currentCredits: number
  proposedCredits: number
  priceUsd: number
}

export async function previewRecalculateAll(overrides: Partial<ConfigurablePricingInput> = {}): Promise<RecalculatePreview[]> {
  const rows = await listPricingConfigs(false)
  return rows.map((row) => {
    const computed = computeConfigurablePricing({
      priceUsd: row.priceUsd,
      stripePercent: overrides.stripePercent ?? row.stripePercent,
      stripeFixedUsd: overrides.stripeFixedUsd ?? row.stripeFixedUsd,
      platformOverheadUsd: overrides.platformOverheadUsd ?? row.platformOverheadUsd,
      reserveBufferPercent: overrides.reserveBufferPercent ?? row.reserveBufferPercent,
      targetProfitPercent: overrides.targetProfitPercent ?? row.targetProfitPercent,
    })
    return {
      configName: row.configName,
      currentCredits: row.computedAiCredits,
      proposedCredits: computed.computedAiCreditsUsd,
      priceUsd: row.priceUsd,
    }
  })
}

export async function applyRecalculateAll(overrides: Partial<ConfigurablePricingInput> = {}): Promise<PricingConfigRow[]> {
  const rows = await listPricingConfigs(false)
  const saved: PricingConfigRow[] = []
  for (const row of rows) {
    saved.push(
      await savePricingConfig({
        configName: row.configName,
        planType: row.planType,
        priceUsd: row.priceUsd,
        stripePercent: overrides.stripePercent ?? row.stripePercent,
        stripeFixedUsd: overrides.stripeFixedUsd ?? row.stripeFixedUsd,
        platformOverheadUsd: overrides.platformOverheadUsd ?? row.platformOverheadUsd,
        reserveBufferPercent: overrides.reserveBufferPercent ?? row.reserveBufferPercent,
        targetProfitPercent: overrides.targetProfitPercent ?? row.targetProfitPercent,
        stripePriceId: row.stripePriceId,
      }),
    )
  }
  return saved
}

export async function crawlPlusGrantUsd(): Promise<number> {
  return grantedCreditsForConfig("crawl_plus_monthly", env.crawlPlusPlanMonthlyCostCapUsd)
}

export async function defaultTopupGrantUsd(): Promise<number> {
  return grantedCreditsForConfig("topup_starter", env.topupCreditUsd)
}
