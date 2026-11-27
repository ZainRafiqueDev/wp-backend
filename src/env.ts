import "dotenv/config"

import { z } from "zod"

import { AppError } from "./lib/errors.js"
import {
  CRAWL_PLUS_20,
  DEFAULT_CRAWL_PLUS_SALE_USD,
  DEFAULT_TOPUP_SALE_USD,
  evaluateCreditGrantConfig,
  grantedCreditsFromSale,
} from "./lib/planEconomics.js"

function trimmed(value: string | undefined) {
  return value?.trim() || ""
}

function positiveEnvInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.floor(n)
}

function positiveEnvNumber(raw: string | undefined, fallback: number): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return n
}

function unitEnvNumber(raw: string | undefined, fallback: number): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return fallback
  return n
}

function envFlag(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null || raw.trim() === "") return fallback
  return !["0", "false", "off", "no"].includes(raw.trim().toLowerCase())
}

const nodeEnv = process.env.NODE_ENV || "development"

const topupSaleUsd = Number(process.env.TOPUP_SALE_USD || DEFAULT_TOPUP_SALE_USD)
const crawlPlusSaleUsd = Number(process.env.CRAWL_PLUS_SALE_USD || DEFAULT_CRAWL_PLUS_SALE_USD)
const fullCustomSaleUsd = Number(process.env.FULL_CUSTOM_SALE_USD || 0)
const crawlPlusPlanMonthlyCostCapUsd = Number(
  process.env.CRAWL_PLUS_PLAN_MONTHLY_COST_CAP_USD || CRAWL_PLUS_20.maximumSafeCreditsUsd,
)
const defaultEmbeddingDailyBudgetUsd = Math.round((crawlPlusPlanMonthlyCostCapUsd / 30) * 10_000) / 10_000

function defaultTopupCreditUsd(): number {
  try {
    return grantedCreditsFromSale(topupSaleUsd, CRAWL_PLUS_20.aiBudgetRatio)
  } catch {
    return 0
  }
}

export const env = {
  nodeEnv,
  port: Number(process.env.PORT || 4000),
  frontendUrl: process.env.FRONTEND_URL || "http://localhost:3000",
  
  logLevel: process.env.LOG_LEVEL || (nodeEnv === "production" ? "info" : "debug"),
 
  trustProxyHops: Number(process.env.TRUST_PROXY_HOPS || 0),
  databaseUrl: trimmed(process.env.DATABASE_URL),
  // `pg`'s own defaults (max 10, no statement_timeout) were never tuned for
  // this app's actual size — admin/billing/commerce/document-ingestion/
  // embeddings now all share the same pool the chat path uses. A small fixed
  // pool becomes the bottleneck under real concurrent load (requests queue
  // for a free connection rather than the DB itself being slow), and with no
  // statement_timeout a single stuck/slow query can hold a connection
  // indefinitely and make that queuing worse. See src/lib/db.ts.
  dbPoolMax: positiveEnvInt(process.env.DB_POOL_MAX, 20),
  dbPoolIdleTimeoutMs: positiveEnvInt(process.env.DB_POOL_IDLE_TIMEOUT_MS, 30_000),
  dbPoolConnectionTimeoutMs: positiveEnvInt(process.env.DB_POOL_CONNECTION_TIMEOUT_MS, 5_000),
  dbStatementTimeoutMs: positiveEnvInt(process.env.DB_STATEMENT_TIMEOUT_MS, 15_000),
  // WP-3.1: SET LOCAL still runs when true. Policies only bind a non-bypass
  // role (chatmate360_app). Superuser DATABASE_URL logs rls.bypass_role.
  rlsEnabled: envFlag(process.env.RLS_ENABLED, true),
  rlsAppRole: trimmed(process.env.RLS_APP_ROLE) || "chatmate360_app",

  jwtSecret: trimmed(process.env.JWT_SECRET),
  // Customer /auth/login had no rate limit at all (unlike /admin/login,
  // which has always had one) — real credential-stuffing exposure on the
  // more commonly attacked surface. Matches the admin default.
  loginRateLimitPerMin: Number(process.env.LOGIN_RATE_LIMIT_PER_MIN || 10),
  accessTokenTtlSeconds: Number(process.env.ACCESS_TOKEN_TTL_SECONDS || 60 * 15), // 15 minutes (CS-11); the refresh cookie renews it
  refreshTokenTtlSeconds: Number(process.env.REFRESH_TOKEN_TTL_SECONDS || 60 * 60 * 24 * 30), // 30 days
  
  googleClientId: trimmed(process.env.GOOGLE_CLIENT_ID),
  googleClientSecret: trimmed(process.env.GOOGLE_CLIENT_SECRET),
  googleRedirectUri: trimmed(process.env.GOOGLE_REDIRECT_URI),
  demoMode: (process.env.DEMO_MODE || "sandbox").toLowerCase(),

  
  anthropicApiKey: trimmed(process.env.ANTHROPIC_API_KEY),
  anthropicModel: process.env.ANTHROPIC_MODEL || "claude-sonnet-5",
  geminiApiKey: trimmed(process.env.GEMINI_API_KEY),
  geminiModel: process.env.GEMINI_MODEL || "gemini-flash-latest",
  openaiApiKey: trimmed(process.env.OPENAI_API_KEY),

  openaiModel: process.env.OPENAI_MODEL || "gpt-4o-mini",
  ollamaBaseUrl: trimmed(process.env.OLLAMA_BASE_URL),
  ollamaModel: process.env.OLLAMA_MODEL || "qwen2.5:7b-instruct-q4_K_M",
  aiRequestTimeoutMs: Number(process.env.AI_REQUEST_TIMEOUT_MS || 30000),
  ollamaRequestTimeoutMs: Number(process.env.OLLAMA_REQUEST_TIMEOUT_MS || 120000),

 
  redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
  crawlQueueName: process.env.CRAWL_QUEUE_NAME || "crawl-queue",
  crawlWorkerConcurrency: Number(process.env.CRAWL_WORKER_CONCURRENCY || 3),

 
  publicChatRateLimitPerMin: Number(process.env.PUBLIC_CHAT_RATE_LIMIT_PER_MIN || 20),
  publicChatRateLimitStrictPerMin: Number(process.env.PUBLIC_CHAT_RATE_LIMIT_STRICT_PER_MIN || 5),
  publicChatMaxConcurrentPerChatbot: Number(process.env.PUBLIC_CHAT_MAX_CONCURRENT_PER_CHATBOT || 10),
  publicChatConcurrencySlotTtlSeconds: Number(process.env.PUBLIC_CHAT_CONCURRENCY_SLOT_TTL_SECONDS || 45),


  authenticatedChatRateLimitPerMin: Number(process.env.AUTHENTICATED_CHAT_RATE_LIMIT_PER_MIN || 30),

 
  relevanceCacheTtlSeconds: Number(process.env.RELEVANCE_CACHE_TTL_SECONDS || 900),
  answerCacheTtlSeconds: Number(process.env.ANSWER_CACHE_TTL_SECONDS || 600),
  pagesCacheTtlSeconds: Number(process.env.PAGES_CACHE_TTL_SECONDS || 300),
  // Schema generation for cacheKey(). Bump when prompt, retrieval, or
  // grounding format changes so old entries expire instead of being flushed.
  cacheSchemaVersion: Math.max(1, Math.floor(Number(process.env.CACHE_SCHEMA_VERSION || 1) || 1)),

  
  integrationEncryptionKey: trimmed(process.env.INTEGRATION_ENCRYPTION_KEY),

  
  backendLinkCacheTtlSeconds: Number(process.env.BACKEND_LINK_CACHE_TTL_SECONDS || 30),


  stripeSecretKey: trimmed(process.env.STRIPE_SECRET_KEY),
  stripeWebhookSecret: trimmed(process.env.STRIPE_WEBHOOK_SECRET),
  stripePriceCrawlPlus: trimmed(process.env.STRIPE_PRICE_CRAWL_PLUS),
  stripePriceFullCustom: trimmed(process.env.STRIPE_PRICE_FULL_CUSTOM),

 
  // Monthly USD is the customer-facing credit allowance. Daily/weekly values
  // are burst/smoothing controls only — they are not sold as extra credits.
  freePlanMonthlyCostCapUsd: Number(process.env.FREE_PLAN_MONTHLY_COST_CAP_USD || 0.5),
  freePlanDailyCostCapUsd: Number(process.env.FREE_PLAN_DAILY_COST_CAP_USD || 0.05),
  freePlanWeeklyCostCapUsd: Number(process.env.FREE_PLAN_WEEKLY_COST_CAP_USD || 0.15),

  // A request reserves an estimate based on prompt size and provider price.
  // These are the floor/ceiling for that estimate, not a flat per-message charge.
  minPerCallCostReservationUsd: Number(process.env.MIN_PER_CALL_COST_RESERVATION_USD || 0.0005),
  perCallCostReservationUsd: Number(process.env.PER_CALL_COST_RESERVATION_USD || 0.05),
  reservationEstimateMultiplier: Number(process.env.RESERVATION_ESTIMATE_MULTIPLIER || 1.25),
  
  aiPricingOverridesJson: trimmed(process.env.AI_PRICING_OVERRIDES_JSON),


  adminAccessTokenTtlSeconds: Number(process.env.ADMIN_ACCESS_TOKEN_TTL_SECONDS || 60 * 60 * 8), // 8 hours
  
  adminLoginRateLimitPerMin: Number(process.env.ADMIN_LOGIN_RATE_LIMIT_PER_MIN || 10),
  // WP-2.6 Full Custom activation. Safe credits = cash × this ratio (same
  // ledger as Crawl Plus). Exceeding the safe amount requires overrideReason.
  adminPlanAiBudgetRatio: (() => {
    const raw = process.env.ADMIN_PLAN_AI_BUDGET_RATIO
    if (raw == null || raw.trim() === "") return CRAWL_PLUS_20.aiBudgetRatio
    const n = Number(raw)
    if (!Number.isFinite(n) || n <= 0 || n >= 1) return CRAWL_PLUS_20.aiBudgetRatio
    return n
  })(),
  adminPlanPeriodDays: positiveEnvInt(process.env.ADMIN_PLAN_PERIOD_DAYS, 30),
  adminPlanOverrideReasonMinLength: positiveEnvInt(process.env.ADMIN_PLAN_OVERRIDE_REASON_MIN_LENGTH, 12),

 
  trialLengthDays: Number(process.env.TRIAL_LENGTH_DAYS || 30),


  crawlPlusPlanMonthlyCostCapUsd,
  // Daily/weekly: burst control, not marketed credits (WP-1.2).
  crawlPlusPlanDailyCostCapUsd: Number(process.env.CRAWL_PLUS_PLAN_DAILY_COST_CAP_USD || 0.8),
  crawlPlusPlanWeeklyCostCapUsd: Number(process.env.CRAWL_PLUS_PLAN_WEEKLY_COST_CAP_USD || 2.4),
  fullCustomPlanMonthlyCostCapUsd: Number(process.env.FULL_CUSTOM_PLAN_MONTHLY_COST_CAP_USD || 150),
  fullCustomPlanDailyCostCapUsd: Number(process.env.FULL_CUSTOM_PLAN_DAILY_COST_CAP_USD || 15),
  fullCustomPlanWeeklyCostCapUsd: Number(process.env.FULL_CUSTOM_PLAN_WEEKLY_COST_CAP_USD || 50),

  // Platform-wide hard ceiling, checked before any per-tenant cap (see
  // tokenallocation.md §2) — defaults are the spec's own section-2a
  // pre-revenue/early-stage numbers, explicitly provisional, not researched
  // targets. Alerts fire at 80%/95% of the monthly ceiling (see usage.service.ts).
  platformMonthlyCostCapUsd: Number(process.env.PLATFORM_MONTHLY_COST_CAP_USD || 500),
  platformWeeklyCostCapUsd: Number(process.env.PLATFORM_WEEKLY_COST_CAP_USD || 115),
  platformDailyCostCapUsd: Number(process.env.PLATFORM_DAILY_COST_CAP_USD || 20),

  // How long a durable reservation row may sit in 'held' before the
  // orphan-recovery sweep (worker.ts) expires it and releases its capacity.
  reservationTtlSeconds: Number(process.env.RESERVATION_TTL_SECONDS || 120),
  reservationSweepIntervalMs: Number(process.env.RESERVATION_SWEEP_INTERVAL_MS || 60_000),
  // Replays Stripe inbox rows that never reached processed_at (crash after persist).
  stripeInboxSweepIntervalMs: Number(process.env.STRIPE_INBOX_SWEEP_INTERVAL_MS || 60_000),
  // How old an unprocessed row must be (since last_attempt_at, else received_at) before the sweep replays it.
  stripeInboxReplayDelaySeconds: Math.max(1, Number(process.env.STRIPE_INBOX_REPLAY_DELAY || 30) || 30),
  stripeInboxAgeAlertSeconds: Math.max(1, Number(process.env.STRIPE_INBOX_AGE_ALERT_SECONDS || 300) || 300),
  // WP-3.3: how often the background re-chunker checks for one more
  // version-1 document to migrate to semantic chunking. Deliberately one
  // document per tick (rate-limited, tenant-isolated — see
  // rechunkLegacyDocument in documentIngestion.service.ts).
  rechunkLegacyIntervalMs: Number(process.env.RECHUNK_LEGACY_INTERVAL_MS || 30_000),
  // Processed inbox rows older than this many days are deleted. 0 disables purge.
  stripeInboxRetentionDays: (() => {
    const parsed = Number(process.env.STRIPE_INBOX_RETENTION_DAYS ?? 90)
    return Number.isFinite(parsed) ? parsed : 90
  })(),
  // Renewal reminder window: alert once when current_period_end is between
  // min and max days away (default 2–5 days before the next billing time).
  billingRenewalAlertMinDays: Math.max(1, Number(process.env.BILLING_RENEWAL_ALERT_MIN_DAYS || 2) || 2),
  billingRenewalAlertMaxDays: Math.max(1, Number(process.env.BILLING_RENEWAL_ALERT_MAX_DAYS || 5) || 5),


  freePlanMaxChatbots: Number(process.env.FREE_PLAN_MAX_CHATBOTS || 1),
  crawlPlusPlanMaxChatbots: Number(process.env.CRAWL_PLUS_PLAN_MAX_CHATBOTS || 5),
  fullCustomPlanMaxChatbots: Number(process.env.FULL_CUSTOM_PLAN_MAX_CHATBOTS || 1000),

  // Phase 2 (2026-10-27): seats = the owner + this many team members.
  freePlanMaxSeats: Number(process.env.FREE_PLAN_MAX_SEATS || 1),
  // Seat count includes the owner (workspaceMembers.service.ts:155's
  // `1 + members + pendingInvites` check) — so "4" here means owner + 3
  // invites, matching how this is marketed, not owner + 4.
  crawlPlusPlanMaxSeats: Number(process.env.CRAWL_PLUS_PLAN_MAX_SEATS || 4),
  fullCustomPlanMaxSeats: Number(process.env.FULL_CUSTOM_PLAN_MAX_SEATS || 11),


  modelPriorityOrder: (process.env.MODEL_PRIORITY_ORDER || "openai,anthropic,gemini")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  freePlanModel: trimmed(process.env.FREE_PLAN_MODEL) || "openai",


  abuseWindowSeconds: Number(process.env.ABUSE_WINDOW_SECONDS || 60),
  abuseRequestThreshold: Number(process.env.ABUSE_REQUEST_THRESHOLD || 20),
  abuseAutoDeactivate: (process.env.ABUSE_AUTO_DEACTIVATE || "false").toLowerCase() === "true",


  recrawlIntervalMs: Number(process.env.RECRAWL_INTERVAL_MS || 7 * 24 * 60 * 60 * 1000),

 
  conversationContextTurns: Number(process.env.CONVERSATION_CONTEXT_TURNS || 6),
  conversationSummaryThresholdTurns: Number(process.env.CONVERSATION_SUMMARY_THRESHOLD_TURNS || 20),

  // WP-3.4 Advanced Session Memory.
  // Idle TTL for a widget conversation. Refreshed on every turn, so this is
  // "days since the visitor last said anything", not age since creation.
  conversationTtlDays: positiveEnvInt(process.env.CONVERSATION_TTL_DAYS, 30),
  // How often the worker compacts flagged conversations, expires idle ones,
  // and purges stale cross-session memory.
  conversationMaintenanceIntervalMs: positiveEnvInt(process.env.CONVERSATION_MAINTENANCE_INTERVAL_MS, 60_000),
  conversationCompactBatchSize: positiveEnvInt(process.env.CONVERSATION_COMPACT_BATCH_SIZE, 25),
  // Cross-session memory (session_summaries + conversation_facts) is deleted
  // this many days after its last update. 0 disables the purge.
  sessionMemoryRetentionDays: (() => {
    const parsed = Number(process.env.SESSION_MEMORY_RETENTION_DAYS ?? 180)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 180
  })(),
  // Structured fact extraction. Disabling falls back to summary-only memory.
  sessionMemoryFactsEnabled: envFlag(process.env.SESSION_MEMORY_FACTS_ENABLED, true),
  sessionMemoryMaxFacts: positiveEnvInt(process.env.SESSION_MEMORY_MAX_FACTS, 25),

 
  stripePriceTopupAnthropic: trimmed(process.env.STRIPE_PRICE_TOPUP_CLAUDE),
  stripePriceTopupOpenai: trimmed(process.env.STRIPE_PRICE_TOPUP_OPENAI),
  stripePriceTopupGemini: trimmed(process.env.STRIPE_PRICE_TOPUP_GEMINI),
 
  // Configured sale prices. Grants are validated against these, not literals.
  topupSaleUsd,
  crawlPlusSaleUsd,
  fullCustomSaleUsd,

  // Never grant AI dollars ≥ cash collected. Default grant is the Crawl Plus
  // AI-budget ratio applied to the configured top-up sale price.
  topupCreditUsd: Number(process.env.TOPUP_CREDIT_USD || defaultTopupCreditUsd()),

  // Optional transactional email (Resend). When blank, verification and
  // notification emails are logged instead of sent — fine for local/dev,
  // with OTP codes / reset / invite links masked (see lib/email.ts).
  resendApiKey: trimmed(process.env.RESEND_API_KEY),
  // Production refuses to boot without RESEND_API_KEY unless this is set
  // (assertProductionGuards). With it, unsent e-mails are logged as
  // recipient hash + subject only — never the body. Users then cannot
  // receive OTPs or password-reset links; use only for a deliberate
  // email-less deployment.
  allowEmailLogOnlyInProduction: envFlag(process.env.ALLOW_EMAIL_LOG_ONLY_IN_PRODUCTION, false),
  // Non-production only: log unsent e-mail bodies with codes/links intact.
  // Ignored when NODE_ENV=production.
  emailLogShowSecrets: envFlag(process.env.EMAIL_LOG_SHOW_SECRETS, false),
  emailFrom: trimmed(process.env.EMAIL_FROM) || "ChatMate360 <onboarding@resend.dev>",

  // Email OTP (dashboard verify + chatbot order-access). Never trust the LLM
  // to mark someone verified — only Express + PostgreSQL after OTP match.
  otpTtlMinutes: Number(process.env.OTP_TTL_MINUTES || 10),
  otpMaxAttempts: Number(process.env.OTP_MAX_ATTEMPTS || 5),
  otpResendCooldownSeconds: Number(process.env.OTP_RESEND_COOLDOWN_SECONDS || 60),
  otpSendRateLimitPerMin: Number(process.env.OTP_SEND_RATE_LIMIT_PER_MIN || 5),
  otpVerifyRateLimitPerMin: Number(process.env.OTP_VERIFY_RATE_LIMIT_PER_MIN || 10),
  otpProofTtlSeconds: Number(process.env.OTP_PROOF_TTL_SECONDS || 60 * 15),
  // Lifetime of the widget customer-session token (see signCustomerSessionToken
  // in src/lib/auth.ts) that unlocks cross-session memory in chat.
  customerSessionTtlSeconds: Number(process.env.CUSTOMER_SESSION_TTL_SECONDS || 60 * 60 * 24 * 30),
  passwordResetTtlMinutes: Number(process.env.PASSWORD_RESET_TTL_MINUTES || 30),
  passwordForgotRateLimitPerMin: Number(process.env.PASSWORD_FORGOT_RATE_LIMIT_PER_MIN || 5),
  // CS-09 auth limiters (src/middleware/rateLimitAuthFlows.ts). Per-email
  // windows are 15 minutes and keyed on the normalised (lowercased) email,
  // so rotating IPs against one account is still capped. Invalid/absent
  // values fall back to the safe default.
  passwordForgotEmailRateLimitPer15Min: positiveEnvInt(process.env.PASSWORD_FORGOT_EMAIL_RATE_LIMIT_PER_15_MIN, 5),
  passwordResetRateLimitPerMin: positiveEnvInt(process.env.PASSWORD_RESET_RATE_LIMIT_PER_MIN, 10),
  otpSendEmailRateLimitPer15Min: positiveEnvInt(process.env.OTP_SEND_EMAIL_RATE_LIMIT_PER_15_MIN, 5),
  otpVerifyEmailRateLimitPer15Min: positiveEnvInt(process.env.OTP_VERIFY_EMAIL_RATE_LIMIT_PER_15_MIN, 10),
  loginEmailRateLimitPer15Min: positiveEnvInt(process.env.LOGIN_EMAIL_RATE_LIMIT_PER_15_MIN, 10),
  adminLoginEmailRateLimitPer15Min: positiveEnvInt(process.env.ADMIN_LOGIN_EMAIL_RATE_LIMIT_PER_15_MIN, 10),
  signupRateLimitPerMin: positiveEnvInt(process.env.SIGNUP_RATE_LIMIT_PER_MIN, 5),
  signupEmailRateLimitPer15Min: positiveEnvInt(process.env.SIGNUP_EMAIL_RATE_LIMIT_PER_15_MIN, 5),
  verifyEmailRateLimitPerMin: positiveEnvInt(process.env.VERIFY_EMAIL_RATE_LIMIT_PER_MIN, 10),
  resendVerificationRateLimitPerMin: positiveEnvInt(process.env.RESEND_VERIFICATION_RATE_LIMIT_PER_MIN, 5),
  resendVerificationUserRateLimitPer15Min: positiveEnvInt(process.env.RESEND_VERIFICATION_USER_RATE_LIMIT_PER_15_MIN, 3),
  // Audit 2026-11-27: anonymous form endpoints (/leads, /contact, /trial,
  // /waitlist, /demo/chat) had no rate limit at all; /leads also e-mails
  // ADMIN_NOTIFICATION_EMAIL on every new row.
  publicFormRateLimitPerMin: positiveEnvInt(process.env.PUBLIC_FORM_RATE_LIMIT_PER_MIN, 5),

  
  commerceQueueName: process.env.COMMERCE_QUEUE_NAME || "commerce-queue",
  commerceWorkerConcurrency: Number(process.env.COMMERCE_WORKER_CONCURRENCY || 3),
 
  paymentReconciliationIntervalMs: Number(process.env.PAYMENT_RECONCILIATION_INTERVAL_MS || 10 * 60 * 1000),
  
  paymentReconciliationThresholdMs: Number(process.env.PAYMENT_RECONCILIATION_THRESHOLD_MS || 5 * 60 * 1000),

  productEmbeddingModel:
    trimmed(process.env.EMBEDDING_MODEL) || process.env.PRODUCT_EMBEDDING_MODEL || "text-embedding-3-small",
  embeddingDim: positiveEnvInt(process.env.EMBEDDING_DIM, 1536),
  embeddingBudgetEnabled: envFlag(process.env.EMBEDDING_BUDGET_ENABLED, true),
  embeddingDailyBudgetUsd: positiveEnvNumber(process.env.EMBEDDING_DAILY_BUDGET_USD, defaultEmbeddingDailyBudgetUsd),
  embeddingPricingOverridesJson: trimmed(process.env.EMBEDDING_PRICING_OVERRIDES_JSON),
  embeddingReembedOnSweep: envFlag(process.env.EMBEDDING_REEMBED_ON_SWEEP, false),
  documentRetrievalMaxDistance: Number(process.env.DOCUMENT_RETRIEVAL_MAX_DISTANCE || 0.65),
  documentRetrievalLimit: Number(process.env.DOCUMENT_RETRIEVAL_LIMIT || 5),
  // Candidates considered per HNSW lookup (SET LOCAL). Higher = better filtered recall, slower.
  pgvectorHnswEfSearch: Math.min(200, Math.max(10, Number(process.env.PGVECTOR_HNSW_EF_SEARCH || 40) || 40)),

  // WP-2.3 hybrid retrieval. `vector` is the rollback. `simple` keeps SKU/id tokens.
  retrievalMode: (trimmed(process.env.RETRIEVAL_MODE) || "hybrid") === "vector" ? "vector" : "hybrid",
  retrievalTsConfig: trimmed(process.env.RETRIEVAL_TS_CONFIG) || "simple",
  retrievalRrfK: positiveEnvInt(process.env.RETRIEVAL_RRF_K, 60),
  retrievalLexicalCandidates: positiveEnvInt(process.env.RETRIEVAL_LEXICAL_CANDIDATES, 20),
  retrievalVectorCandidates: positiveEnvInt(process.env.RETRIEVAL_VECTOR_CANDIDATES, 20),
  retrievalShadowCompare: envFlag(process.env.RETRIEVAL_SHADOW_COMPARE, false),

  // WP-3.2 rerank. Pool must be >= documentRetrievalLimit or rerank has
  // nothing extra to reorder against.
  retrievalRerankEnabled: envFlag(process.env.RETRIEVAL_RERANK_ENABLED, true),
  retrievalRerankCandidatePool: positiveEnvInt(process.env.RETRIEVAL_RERANK_CANDIDATE_POOL, 15),

  // WP-2.5 RAG eval gate. Skip only with an explicit override (CI emergency).
  ragEvalSkip: envFlag(process.env.RAG_EVAL_SKIP, false),
  ragEvalMinRecallAt5: unitEnvNumber(process.env.RAG_EVAL_MIN_RECALL_AT_5, 0.8),
  ragEvalMinRecallAt10: unitEnvNumber(process.env.RAG_EVAL_MIN_RECALL_AT_10, 0.85),
  ragEvalMinPrecisionAt5: unitEnvNumber(process.env.RAG_EVAL_MIN_PRECISION_AT_5, 0.35),
  ragEvalMinMrr: unitEnvNumber(process.env.RAG_EVAL_MIN_MRR, 0.7),
  ragEvalMinNdcgAt10: unitEnvNumber(process.env.RAG_EVAL_MIN_NDCG_AT_10, 0.75),
  ragEvalMinCitationCoverage: unitEnvNumber(process.env.RAG_EVAL_MIN_CITATION_COVERAGE, 0.85),
  ragEvalMinGroundedAnswerRate: unitEnvNumber(process.env.RAG_EVAL_MIN_GROUNDED_RATE, 0.75),
  ragEvalMaxHallucinationRate: unitEnvNumber(process.env.RAG_EVAL_MAX_HALLUCINATION_RATE, 0.05),
  ragEvalMaxIsolationViolations: Number.isFinite(Number(process.env.RAG_EVAL_MAX_ISOLATION_VIOLATIONS))
    ? Math.max(0, Math.floor(Number(process.env.RAG_EVAL_MAX_ISOLATION_VIOLATIONS)))
    : 0,
  ragEvalMaxP95Ms: positiveEnvInt(process.env.RAG_EVAL_MAX_P95_MS, 2000),
  ragEvalArtifactPath: trimmed(process.env.RAG_EVAL_ARTIFACT_PATH) || "evals/rag/artifacts/last-run.json",

  // WP-3.5 regression gate. Absolute thresholds alone let quality erode
  // silently down to the floor; this compares against the last accepted run.
  ragEvalBaselinePath: trimmed(process.env.RAG_EVAL_BASELINE_PATH) || "evals/rag/baseline.json",
  // Largest allowed drop, per metric, against the baseline. Small positive
  // slack absorbs ordinary run-to-run noise without hiding a real regression.
  ragEvalMaxRegression: unitEnvNumber(process.env.RAG_EVAL_MAX_REGRESSION, 0.03),
  // Explicitly re-baselines after an intentional quality change. Never leave on.
  ragEvalUpdateBaseline: envFlag(process.env.RAG_EVAL_UPDATE_BASELINE, false),
  // Ranking metrics are only reproducible on a quiet test DB: the embedding
  // column carries an HNSW (approximate) index, so the neighbour ordering
  // shifts as the shared table grows and as other suites write concurrently.
  // `npm run eval:rag` sets this; a whole-suite `vitest run` leaves it off and
  // reports the deltas without failing on them.
  ragEvalEnforceBaseline: envFlag(process.env.RAG_EVAL_ENFORCE_BASELINE, false),

  // WP-1.5 ingest caps. These are now the FULL CUSTOM plan defaults (see
  // plans.ts): 25 docs / 20MB per file (raised from 15MB) / 400 chunks per
  // file. Chatbot-byte default kept at 25×file-cap so a tenant already
  // using the published file cap is not newly blocked — raised to 25×20MB
  // alongside the file-cap increase for the same reason. Per-chatbot
  // nullable columns override documents / total bytes / total chunks for
  // either plan.
  documentMaxPerChatbot: positiveEnvInt(process.env.DOCUMENT_MAX_PER_CHATBOT, 25),
  documentMaxFileBytes: positiveEnvInt(process.env.DOCUMENT_MAX_FILE_BYTES, 20 * 1024 * 1024),
  documentMaxChatbotBytes: positiveEnvInt(process.env.DOCUMENT_MAX_CHATBOT_BYTES, 25 * 20 * 1024 * 1024),
  documentMaxChunksPerDocument: positiveEnvInt(process.env.DOCUMENT_MAX_CHUNKS_PER_DOCUMENT, 400),
  documentMaxChunksPerChatbot: positiveEnvInt(process.env.DOCUMENT_MAX_CHUNKS_PER_CHATBOT, 25 * 400),

  // Crawl Plus plan defaults (2026-10-26 product decision): a much smaller
  // ingest footprint than Full Custom — 6 docs, 16MB per file, 50MB total
  // per chatbot. Still overridable per-chatbot via the same max_documents /
  // max_bytes columns full Custom uses.
  crawlPlusDocMaxDocuments: positiveEnvInt(process.env.CRAWL_PLUS_DOC_MAX_DOCUMENTS, 6),
  crawlPlusDocMaxFileBytes: positiveEnvInt(process.env.CRAWL_PLUS_DOC_MAX_FILE_BYTES, 16 * 1024 * 1024),
  crawlPlusDocMaxChatbotBytes: positiveEnvInt(process.env.CRAWL_PLUS_DOC_MAX_CHATBOT_BYTES, 50 * 1024 * 1024),

  // Phase 3 (2026-10-27): managed chat attachments. Crawl Plus's total is
  // per ACCOUNT (shared across all the owner's chatbots), unlike the
  // per-chatbot document caps above.
  crawlPlusAttachmentMaxFileBytes: positiveEnvInt(process.env.CRAWL_PLUS_ATTACHMENT_MAX_FILE_BYTES, 10 * 1024 * 1024),
  crawlPlusAttachmentMaxFilesPerMessage: positiveEnvInt(process.env.CRAWL_PLUS_ATTACHMENT_MAX_FILES_PER_MESSAGE, 3),
  crawlPlusAttachmentRetentionDays: positiveEnvInt(process.env.CRAWL_PLUS_ATTACHMENT_RETENTION_DAYS, 30),
  crawlPlusAttachmentTotalBytes: positiveEnvInt(process.env.CRAWL_PLUS_ATTACHMENT_TOTAL_BYTES, 200 * 1024 * 1024),
  fullCustomAttachmentMaxFileBytes: positiveEnvInt(process.env.FULL_CUSTOM_ATTACHMENT_MAX_FILE_BYTES, 20 * 1024 * 1024),
  fullCustomAttachmentMaxFilesPerMessage: positiveEnvInt(process.env.FULL_CUSTOM_ATTACHMENT_MAX_FILES_PER_MESSAGE, 3),
  fullCustomAttachmentRetentionDays: positiveEnvInt(process.env.FULL_CUSTOM_ATTACHMENT_RETENTION_DAYS, 30),
  fullCustomAttachmentTotalBytes: positiveEnvInt(process.env.FULL_CUSTOM_ATTACHMENT_TOTAL_BYTES, 500 * 1024 * 1024),
  attachmentRetentionIntervalMs: positiveEnvInt(process.env.ATTACHMENT_RETENTION_INTERVAL_MS, 60 * 60 * 1000),
  attachmentMaxPerConversation: positiveEnvInt(process.env.ATTACHMENT_MAX_PER_CONVERSATION, 10),
  attachmentMaxPerIpPerDay: positiveEnvInt(process.env.ATTACHMENT_MAX_PER_IP_PER_DAY, 20),

  // WP-2.1 async ingest. HTTP persists bytes then returns 202. Set
  // DOCUMENT_INGEST_ASYNC=false to process files <= SYNC_MAX_BYTES inline
  // (rollback). Storage driver `fs` is for local/CI; `s3` is MinIO/AWS.
  documentIngestAsync: envFlag(process.env.DOCUMENT_INGEST_ASYNC, true),
  documentIngestSyncMaxBytes: positiveEnvInt(process.env.DOCUMENT_INGEST_SYNC_MAX_BYTES, 15 * 1024 * 1024),
  documentIngestQueueName: process.env.DOCUMENT_INGEST_QUEUE_NAME || "document-ingest",
  documentIngestWorkerConcurrency: Math.min(2, Math.max(1, Number(process.env.DOCUMENT_INGEST_WORKER_CONCURRENCY || 2) || 2)),
  documentIngestStaleProcessingMs: positiveEnvInt(process.env.DOCUMENT_INGEST_STALE_PROCESSING_MS, 30 * 60 * 1000),
  documentIngestBackpressureDepth: positiveEnvInt(process.env.DOCUMENT_INGEST_BACKPRESSURE_DEPTH, 1000),
  documentIngestEmbeddingBatchSize: Math.min(100, positiveEnvInt(process.env.DOCUMENT_INGEST_EMBEDDING_BATCH_SIZE, 100)),
  documentOcrEnabled: envFlag(process.env.DOCUMENT_OCR_ENABLED, false),
  documentStorageDriver: (trimmed(process.env.DOCUMENT_STORAGE_DRIVER) || "fs") === "s3" ? "s3" : "fs",
  documentStorageDir: trimmed(process.env.DOCUMENT_STORAGE_DIR) || "var/document-storage",
  documentStorageBucket: trimmed(process.env.DOCUMENT_STORAGE_BUCKET),
  documentStorageRegion: trimmed(process.env.DOCUMENT_STORAGE_REGION) || "us-east-1",
  documentStorageEndpoint: trimmed(process.env.DOCUMENT_STORAGE_ENDPOINT),
  documentStorageAccessKey: trimmed(process.env.DOCUMENT_STORAGE_ACCESS_KEY),
  documentStorageSecretKey: trimmed(process.env.DOCUMENT_STORAGE_SECRET_KEY),

  // WP-2.2 malware scan. Scan runs in the worker before parse. Production
  // is always fail-closed and never honors DOCUMENT_SCAN_SKIP.
  documentScanVendor: (trimmed(process.env.DOCUMENT_SCAN_VENDOR) || "mock") === "clamav" ? "clamav" : "mock",
  documentScanClamdHost: trimmed(process.env.DOCUMENT_SCAN_CLAMD_HOST) || "127.0.0.1",
  documentScanClamdPort: positiveEnvInt(process.env.DOCUMENT_SCAN_CLAMD_PORT, 3310),
  documentScanTimeoutMs: positiveEnvInt(process.env.DOCUMENT_SCAN_TIMEOUT_MS, 10_000),
  documentScanFailClosed: envFlag(process.env.DOCUMENT_SCAN_FAIL_CLOSED, true),
  documentScanSkip: envFlag(process.env.DOCUMENT_SCAN_SKIP, false),
  documentScanPauseUploads: envFlag(process.env.DOCUMENT_SCAN_PAUSE_UPLOADS, false),

  // Escape hatch for assertProductionGuards() below — set only to
  // deliberately run production on local-disk storage and/or the mock
  // malware scanner (e.g. a staging environment that calls itself
  // "production"), never to silence a real deploy mistake.
  allowUnsafeProdDefaults: envFlag(process.env.ALLOW_UNSAFE_PROD_DEFAULTS, false),
  // Separate, scanner-only escape hatch. ALLOW_UNSAFE_PROD_DEFAULTS no longer
  // covers the mock scanner: turning it on to accept local-disk storage must
  // not also silently switch off malware scanning for customer uploads.
  allowMockMalwareScanInProduction: envFlag(process.env.ALLOW_MOCK_MALWARE_SCAN_IN_PRODUCTION, false),

  // Alert emails. Default OFF — never send a real Resend email unless the
  // operator enables this AND RESEND_API_KEY is set.
  alertEmailEnabled: envFlag(process.env.ALERT_EMAIL_ENABLED, false),
  alertEmailTo: trimmed(process.env.ALERT_EMAIL_TO),

  okfSemanticThreshold: unitEnvNumber(process.env.OKF_SEMANTIC_THRESHOLD, 0.85),
  okfTypeHintThreshold: unitEnvNumber(process.env.OKF_TYPE_HINT_THRESHOLD, 0.75),
  okfExactTitleThreshold: unitEnvNumber(process.env.OKF_EXACT_TITLE_THRESHOLD, 0.98),
  okfStaleDays: positiveEnvInt(process.env.OKF_STALE_DAYS, 90),
  okfStaleServeCount: positiveEnvInt(process.env.OKF_STALE_SERVE_COUNT, 100),

  // Crawl-sourced OKF suggestions (as opposed to document-upload-sourced,
  // which always ran). Off switch plus a hard per-crawl-run cap: a crawl can
  // easily turn up more relevance-filtered candidate pages than are worth
  // an LLM call and a Pending-tab entry each — see okfPageRelevance.ts.
  okfCrawlSuggestEnabled: envFlag(process.env.OKF_CRAWL_SUGGEST_ENABLED, true),
  okfCrawlSuggestMaxPagesPerRun: positiveEnvInt(process.env.OKF_CRAWL_SUGGEST_MAX_PAGES_PER_RUN, 5),

  // Full Custom lead capture (replaces self-service Stripe checkout for
  // that plan — see lead.service.ts). Blank adminNotificationEmail means
  // the "notify admin" email is skipped (logged instead, same as any other
  // email when RESEND_API_KEY is unset — see lib/email.ts).
  adminNotificationEmail: trimmed(process.env.ADMIN_NOTIFICATION_EMAIL),
  calendlyWebhookSigningKey: trimmed(process.env.CALENDLY_WEBHOOK_SIGNING_KEY),

  // Optional error tracking (src/lib/sentry.ts). Blank means errors are only
  // ever visible in stdout logs — fine for local/dev, a real gap in
  // production (see the boot warning below).
  sentryDsn: trimmed(process.env.SENTRY_DSN),
}

// Boot-time format validation for the small set of connection/secret vars
// whose value silently breaking the app (wrong port, wrong scheme, missing)
// is expensive to diagnose after the fact — every request just hangs or
// fails oddly with no clue why. This is deliberately NOT a schema for all
// ~180 env vars above (most are tuning knobs with safe numeric fallbacks
// already handled by positiveEnvInt/envFlag/trimmed); it only covers values
// where a malformed-but-present string causes silent failure rather than an
// obvious startup error. Each field is optional (demo mode runs with no DB,
// no Stripe, etc.) but must be well-formed *if set*.
const optionalUrl = (scheme: RegExp) =>
  z
    .string()
    .refine((v) => v === "" || (z.string().url().safeParse(v).success && scheme.test(v)), {
      message: "must be empty or a well-formed URL with the expected scheme",
    })

const bootEnvSchema = z.object({
  databaseUrl: optionalUrl(/^postgres(ql)?:\/\//),
  redisUrl: optionalUrl(/^rediss?:\/\//),
  frontendUrl: optionalUrl(/^https?:\/\//),
  jwtSecret: z.string().refine((v) => v === "" || v.length >= 16, {
    message: "must be empty or at least 16 characters",
  }),
  integrationEncryptionKey: z.string().refine((v) => v === "" || /^[0-9a-f]{64}$/i.test(v), {
    message: "must be empty or exactly 64 hex characters",
  }),
  stripeSecretKey: z.string().refine((v) => v === "" || v.startsWith("sk_"), {
    message: "must be empty or start with sk_",
  }),
  stripeWebhookSecret: z.string().refine((v) => v === "" || v.startsWith("whsec_"), {
    message: "must be empty or start with whsec_",
  }),
  sentryDsn: optionalUrl(/^https?:\/\//),
})

function validateBootEnv(): void {
  const result = bootEnvSchema.safeParse({
    databaseUrl: env.databaseUrl,
    redisUrl: env.redisUrl,
    frontendUrl: env.frontendUrl,
    jwtSecret: env.jwtSecret,
    integrationEncryptionKey: env.integrationEncryptionKey,
    stripeSecretKey: env.stripeSecretKey,
    stripeWebhookSecret: env.stripeWebhookSecret,
    sentryDsn: env.sentryDsn,
  })
  if (result.success) return

  const lines = result.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
  // console, not the pino logger — this runs before logger config is
  // guaranteed sane and must never itself depend on env being valid.
  console.error(
    `Invalid environment configuration — refusing to start:\n${lines.join("\n")}\n` +
      "Fix the corresponding value(s) in your .env file.",
  )
  process.exit(1)
}

validateBootEnv()

export const isDemoSandbox = env.demoMode === "sandbox"
export const hasDatabase = Boolean(env.databaseUrl && env.jwtSecret)
export const hasGoogleOAuth = Boolean(env.googleClientId && env.googleClientSecret && env.googleRedirectUri)
export const hasAiProvider = Boolean(
  env.anthropicApiKey || env.geminiApiKey || env.openaiApiKey || env.ollamaBaseUrl,
)
export const hasRedis = Boolean(env.redisUrl)

export const hasIntegrationEncryption = Boolean(
  env.integrationEncryptionKey && env.integrationEncryptionKey.length === 64,
)

export const hasStripe = Boolean(env.stripeSecretKey && env.stripeWebhookSecret)

export const hasProductEmbeddings = Boolean(env.openaiApiKey)

export const hasCalendlyWebhook = Boolean(env.calendlyWebhookSigningKey)

function currentCreditGrantConfig() {
  return {
    topupCreditUsd: env.topupCreditUsd,
    topupSaleUsd: env.topupSaleUsd,
    crawlPlusMonthlyGrantUsd: env.crawlPlusPlanMonthlyCostCapUsd,
    crawlPlusSaleUsd: env.crawlPlusSaleUsd,
    fullCustomMonthlyGrantUsd: env.fullCustomPlanMonthlyCostCapUsd,
    fullCustomSaleUsd: env.fullCustomSaleUsd,
  }
}

let creditGrantConfigErrorState = evaluateCreditGrantConfig(currentCreditGrantConfig())

if (creditGrantConfigErrorState) {
  console.warn("credit grant env violates grant < configured sale — billing grants disabled", {
    ...currentCreditGrantConfig(),
    err: creditGrantConfigErrorState,
  })
}

export function getCreditGrantConfigError(): string | null {
  return creditGrantConfigErrorState
}

export function isCreditGrantingEnabled(): boolean {
  return creditGrantConfigErrorState === null
}

export function requireCreditGrantingEnabled(): void {
  if (creditGrantConfigErrorState) {
    throw new AppError(
      503,
      "Billing credit grants are disabled until granted credits are configured below the sale prices.",
    )
  }
}

export function assertCreditGrantEnv(): void {
  const err = evaluateCreditGrantConfig(currentCreditGrantConfig())
  if (err) throw new Error(err)
}

/** Test-only. Refuses to run when NODE_ENV is production. */
export function setCreditGrantConfigErrorForTests(message: string | null): void {
  if (env.nodeEnv === "production") {
    throw new Error("Refusing to mutate credit grant configuration in production.")
  }
  creditGrantConfigErrorState = message
}

export function assertProductionGuards(): void {
  if (env.nodeEnv === "production" && env.documentScanSkip) {
    throw new Error(
      "DOCUMENT_SCAN_SKIP cannot be enabled in production. Configure ClamAV or set DOCUMENT_SCAN_SKIP=false.",
    )
  }

  // Both of these have a safe, explicit opt-out (ALLOW_UNSAFE_PROD_DEFAULTS)
  // rather than a hard block, because a handful of legitimate setups
  // (ephemeral demo/staging environments that set NODE_ENV=production,
  // single-instance deployments that accept local-disk storage) really do
  // want these defaults — but silently inheriting them by forgetting to set
  // an env var is a production incident waiting to happen, not a choice.
  if (env.nodeEnv === "production" && !env.allowUnsafeProdDefaults) {
    if (env.documentStorageDriver === "fs") {
      throw new Error(
        "DOCUMENT_STORAGE_DRIVER=fs (the default) in production means every uploaded document and chat " +
          "attachment is written to local disk and lost on the next restart/redeploy. Set " +
          "DOCUMENT_STORAGE_DRIVER=s3 with a real bucket, or set ALLOW_UNSAFE_PROD_DEFAULTS=true if this is " +
          "deliberate.",
      )
    }
  }

  if (env.nodeEnv === "production" && env.documentScanVendor === "mock" && !env.allowMockMalwareScanInProduction) {
    throw new Error(
      "DOCUMENT_SCAN_VENDOR=mock (the default) in production means every uploaded document and chat " +
        "attachment is scanned by a scanner that only catches the EICAR test string, not real malware. Set " +
        "DOCUMENT_SCAN_VENDOR=clamav with a real clamd reachable. ALLOW_UNSAFE_PROD_DEFAULTS does not cover " +
        "this; only ALLOW_MOCK_MALWARE_SCAN_IN_PRODUCTION=true does, and it should never be set where real " +
        "customers upload files.",
    )
  }

  // Without a Resend key every OTP, password-reset, invite and verification
  // e-mail silently goes undelivered (B03-015). Fail closed; the opt-out is
  // explicit and logs metadata only (lib/email.ts).
  if (env.nodeEnv === "production" && !env.resendApiKey && !env.allowEmailLogOnlyInProduction) {
    throw new Error(
      "RESEND_API_KEY is not set in production, so OTP, password-reset, invite and verification e-mails " +
        "cannot be delivered. Set RESEND_API_KEY, or set ALLOW_EMAIL_LOG_ONLY_IN_PRODUCTION=true if this " +
        "deployment deliberately sends no e-mail (bodies are then never logged, only recipient hash + subject).",
    )
  }
}
