import { env } from "../env.js"
import type { PlanTier } from "./stripe.js"
export type ModelKey = "anthropic" | "openai" | "gemini"

// What happens once a plan's cap is fully spent. Only BLOCK has real
// enforcement behavior today (see usage.service.ts) — the other three are
// an accepted, typed config surface for policies that need real product
// decisions before they can be built (which cheaper model? how does an
// overage get billed?), not invented here. See tokenallocation.md.
export type LimitAction = "BLOCK" | "ROUTE_TO_CHEAPER_MODEL" | "USE_OVERAGE" | "ADMIN_OVERRIDE"

// 2026-10-26: was a plain boolean. Each plan now carries its own ingest
// footprint instead of sharing one global env-driven cap (see env.ts /
// ingestCaps.ts). `enabled` is the boolean every existing call site checked
// before — read `.enabled`, not the object itself, wherever the old boolean
// gate used to live.
export interface DocumentIngestionConfig {
  enabled: boolean
  maxDocuments: number
  maxFileSizeBytes: number
  maxChatbotBytes: number
}

// Phase 3 (2026-10-27). totalStorageBytes is per ACCOUNT (one pool shared
// by every chatbot the owner has), unlike maxFileSizeBytes/maxFilesPerMessage
// which are just per-upload limits — see attachment_storage_usage (keyed by
// owner_user_id, not chatbot_id) in the schema.
export interface ChatAttachmentsConfig {
  enabled: boolean
  maxFileSizeBytes: number
  maxFilesPerMessage: number
  retentionDays: number
  allowedTypes: ("png" | "jpg" | "webp" | "pdf" | "txt")[]
  totalStorageBytes: number
}

export interface PlanDefinition {
  plan: PlanTier | "free"
  maxChatbots: number
  /** The owner + this many team members (Phase 2, 2026-10-27). */
  maxSeats: number
  allowedModels: ModelKey[]

  /** Customer-facing monthly AI credits (USD). */
  perModelCapUsd: number
  /** Infra burst control for a UTC day — not marketed as credits. */
  perModelDailyCapUsd: number
  /** Infra burst control for an ISO week — not marketed as credits. */
  perModelWeeklyCapUsd: number
  documentIngestion: DocumentIngestionConfig
  chatAttachments: ChatAttachmentsConfig
  limitAction: LimitAction
}

const DOCUMENT_INGESTION_DISABLED: DocumentIngestionConfig = {
  enabled: false,
  maxDocuments: 0,
  maxFileSizeBytes: 0,
  maxChatbotBytes: 0,
}

const CHAT_ATTACHMENTS_DISABLED: ChatAttachmentsConfig = {
  enabled: false,
  maxFileSizeBytes: 0,
  maxFilesPerMessage: 0,
  retentionDays: 0,
  allowedTypes: [],
  totalStorageBytes: 0,
}

const ALLOWED_ATTACHMENT_TYPES: ChatAttachmentsConfig["allowedTypes"] = ["png", "jpg", "webp", "pdf", "txt"]

export const PLAN_DEFINITIONS: Record<PlanTier | "free", PlanDefinition> = {
  free: {
    plan: "free",
    maxChatbots: env.freePlanMaxChatbots,
    maxSeats: env.freePlanMaxSeats,
    // Same provider chain as paid plans — free is limited by cost caps, not Gemini-only.
    allowedModels: ["anthropic", "openai", "gemini"],
    perModelCapUsd: env.freePlanMonthlyCostCapUsd,
    perModelDailyCapUsd: env.freePlanDailyCostCapUsd,
    perModelWeeklyCapUsd: env.freePlanWeeklyCostCapUsd,
    documentIngestion: DOCUMENT_INGESTION_DISABLED,
    chatAttachments: CHAT_ATTACHMENTS_DISABLED,
    limitAction: "BLOCK",
  },
  crawl_plus: {
    plan: "crawl_plus",
    maxChatbots: env.crawlPlusPlanMaxChatbots,
    maxSeats: env.crawlPlusPlanMaxSeats,
    allowedModels: ["anthropic", "openai", "gemini"],
    perModelCapUsd: env.crawlPlusPlanMonthlyCostCapUsd,
    perModelDailyCapUsd: env.crawlPlusPlanDailyCostCapUsd,
    perModelWeeklyCapUsd: env.crawlPlusPlanWeeklyCostCapUsd,
    documentIngestion: {
      enabled: true,
      maxDocuments: env.crawlPlusDocMaxDocuments,
      maxFileSizeBytes: env.crawlPlusDocMaxFileBytes,
      maxChatbotBytes: env.crawlPlusDocMaxChatbotBytes,
    },
    chatAttachments: {
      enabled: true,
      maxFileSizeBytes: env.crawlPlusAttachmentMaxFileBytes,
      maxFilesPerMessage: env.crawlPlusAttachmentMaxFilesPerMessage,
      retentionDays: env.crawlPlusAttachmentRetentionDays,
      allowedTypes: ALLOWED_ATTACHMENT_TYPES,
      totalStorageBytes: env.crawlPlusAttachmentTotalBytes,
    },
    limitAction: "BLOCK",
  },
  full_custom: {
    plan: "full_custom",
    maxChatbots: env.fullCustomPlanMaxChatbots,
    maxSeats: env.fullCustomPlanMaxSeats,
    allowedModels: ["anthropic", "openai", "gemini"],
    perModelCapUsd: env.fullCustomPlanMonthlyCostCapUsd,
    perModelDailyCapUsd: env.fullCustomPlanDailyCostCapUsd,
    perModelWeeklyCapUsd: env.fullCustomPlanWeeklyCostCapUsd,
    documentIngestion: {
      enabled: true,
      maxDocuments: env.documentMaxPerChatbot,
      maxFileSizeBytes: env.documentMaxFileBytes,
      maxChatbotBytes: env.documentMaxChatbotBytes,
    },
    chatAttachments: {
      enabled: true,
      maxFileSizeBytes: env.fullCustomAttachmentMaxFileBytes,
      maxFilesPerMessage: env.fullCustomAttachmentMaxFilesPerMessage,
      retentionDays: env.fullCustomAttachmentRetentionDays,
      allowedTypes: ALLOWED_ATTACHMENT_TYPES,
      totalStorageBytes: env.fullCustomAttachmentTotalBytes,
    },
    limitAction: "BLOCK",
  },
}

export function planDefinitionFor(plan: PlanTier | "free"): PlanDefinition {
  return PLAN_DEFINITIONS[plan]
}
