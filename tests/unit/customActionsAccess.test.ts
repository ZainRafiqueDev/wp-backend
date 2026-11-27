import { beforeEach, describe, expect, it, vi } from "vitest"

const { getEntitlementForChatbot, getModelPeriodCreditUsd } = vi.hoisted(() => ({
  getEntitlementForChatbot: vi.fn(),
  getModelPeriodCreditUsd: vi.fn(),
}))

vi.mock("../../src/services/billing.service.js", () => ({ getEntitlementForChatbot }))
vi.mock("../../src/services/usage.service.js", () => ({ getModelPeriodCreditUsd }))

import {
  getCustomActionTopupModels,
  requireCrawlPlusCustomActions,
  requireCustomActionTopup,
} from "../../src/services/customActionsAccess.service.js"

function entitlement(plan: "free" | "crawl_plus" | "full_custom", active = true) {
  return {
    plan,
    active,
    maxChatbots: 5,
    maxSeats: 3,
    allowedModels: ["anthropic", "openai", "gemini"],
    perModelCapUsd: 5,
    perModelDailyCapUsd: 1,
    perModelWeeklyCapUsd: 3,
    documentIngestion: { enabled: true, maxDocuments: 25, maxFileSizeBytes: 15 * 1024 * 1024, maxChatbotBytes: 375 * 1024 * 1024 },
    chatAttachments: { enabled: true, maxFileSizeBytes: 20 * 1024 * 1024, maxFilesPerMessage: 3, retentionDays: 30, allowedTypes: ["png", "jpg", "webp", "pdf", "txt"], totalStorageBytes: 500 * 1024 * 1024 },
    limitAction: "BLOCK",
  }
}

describe("Custom Actions access policy", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getModelPeriodCreditUsd.mockResolvedValue(0)
  })

  it.each(["free", "full_custom"] as const)("rejects the %s plan", async (plan) => {
    getEntitlementForChatbot.mockResolvedValue(entitlement(plan))
    await expect(requireCrawlPlusCustomActions("bot-1")).rejects.toMatchObject({ status: 402 })
  })

  it("rejects inactive Crawl Plus", async () => {
    getEntitlementForChatbot.mockResolvedValue(entitlement("crawl_plus", false))
    await expect(requireCrawlPlusCustomActions("bot-1")).rejects.toMatchObject({ status: 402 })
  })

  it("requires a current Claude or OpenAI top-up", async () => {
    getEntitlementForChatbot.mockResolvedValue(entitlement("crawl_plus"))
    await expect(requireCustomActionTopup("bot-1")).rejects.toMatchObject({ status: 402 })
  })

  it("returns only topped-up action-capable models", async () => {
    getEntitlementForChatbot.mockResolvedValue(entitlement("crawl_plus"))
    getModelPeriodCreditUsd.mockImplementation(async (_chatbotId: string, model: string) =>
      model === "openai" ? 5 : 0,
    )

    await expect(getCustomActionTopupModels("bot-1")).resolves.toEqual(["openai"])
  })
})
