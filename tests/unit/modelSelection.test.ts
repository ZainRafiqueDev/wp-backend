import { describe, expect, it, vi, beforeEach } from "vitest"

// Capability 1 — manual model selection. selectModelForConversation adds a
// preference check IN FRONT of the existing, unchanged
// selectModelForNewConversation auto chain (see modelSelection.service.ts's
// own doc comment) — every one of these mocks the same two dependencies
// the pre-existing selectModelForNewConversation already used
// (getEntitlementForChatbot, isModelQuotaAvailable), so a real regression
// in the untouched auto path would show up here too.
vi.mock("../../src/services/billing.service.js", () => ({
  getEntitlementForChatbot: vi.fn(),
}))
vi.mock("../../src/services/usage.service.js", () => ({
  isModelQuotaAvailable: vi.fn(),
}))

const { getEntitlementForChatbot } = await import("../../src/services/billing.service.js")
const { isModelQuotaAvailable } = await import("../../src/services/usage.service.js")
const { selectModelForConversation, selectModelForNewConversation } = await import("../../src/services/modelSelection.service.js")

function entitlement(allowedModels: string[]) {
  return { allowedModels } as never
}

beforeEach(() => {
  vi.mocked(getEntitlementForChatbot).mockReset()
  vi.mocked(isModelQuotaAvailable).mockReset()
})

describe("selectModelForConversation — manual override in front of the unchanged auto chain", () => {
  it("no preference (undefined) behaves identically to selectModelForNewConversation — the auto chain runs completely unchanged", async () => {
    vi.mocked(getEntitlementForChatbot).mockResolvedValue(entitlement(["anthropic", "openai", "gemini"]))
    // Default MODEL_PRIORITY_ORDER is openai,anthropic,gemini — first check
    // openai (exhausted), second anthropic (available).
    vi.mocked(isModelQuotaAvailable).mockResolvedValueOnce(false).mockResolvedValueOnce(true)

    const result = await selectModelForConversation("chatbot-1", undefined)
    expect(result).toEqual({ provider: "anthropic" })
  })

  it("no preference (null — the 'auto' dropdown option) also behaves identically to the auto chain", async () => {
    vi.mocked(getEntitlementForChatbot).mockResolvedValue(entitlement(["anthropic", "openai", "gemini"]))
    vi.mocked(isModelQuotaAvailable).mockResolvedValue(true)

    const result = await selectModelForConversation("chatbot-1", null)
    expect(result).toEqual({ provider: "openai" })
  })

  it("a preferred model with available quota is selected directly, without walking the auto chain's priority order", async () => {
    vi.mocked(getEntitlementForChatbot).mockResolvedValue(entitlement(["anthropic", "openai", "gemini"]))
    vi.mocked(isModelQuotaAvailable).mockResolvedValueOnce(true) // only the preferred model's quota is ever checked

    const result = await selectModelForConversation("chatbot-1", "gemini")
    expect(result).toEqual({ provider: "gemini" })
    expect(isModelQuotaAvailable).toHaveBeenCalledTimes(1)
    expect(isModelQuotaAvailable).toHaveBeenCalledWith("chatbot-1", expect.anything(), "gemini")
  })

  it("a preferred model whose quota is exhausted falls through to the existing auto chain, which picks the next available model", async () => {
    vi.mocked(getEntitlementForChatbot).mockResolvedValue(entitlement(["anthropic", "openai", "gemini"]))
    // 1st call: the preferred model's own quota check (exhausted).
    // 2nd/3rd calls: the auto chain's walk over env.modelPriorityOrder
    // (openai, anthropic, gemini) — openai exhausted too, anthropic available.
    vi.mocked(isModelQuotaAvailable)
      .mockResolvedValueOnce(false) // preferred: gemini, exhausted
      .mockResolvedValueOnce(false) // auto chain: openai, exhausted
      .mockResolvedValueOnce(true) // auto chain: anthropic, available

    const result = await selectModelForConversation("chatbot-1", "gemini")
    expect(result).toEqual({ provider: "anthropic" })
  })

  it("a preferred model not currently allowed by the plan (e.g. downgraded after being set) falls through to the auto chain, never selected directly", async () => {
    vi.mocked(getEntitlementForChatbot).mockResolvedValue(entitlement(["openai"]))
    vi.mocked(isModelQuotaAvailable).mockResolvedValue(true)

    const result = await selectModelForConversation("chatbot-1", "gemini")
    expect(result).toEqual({ provider: "openai" })
    // Only the auto chain's own check ran — gemini was never even queried,
    // since it's not in allowedModels.
    expect(isModelQuotaAvailable).toHaveBeenCalledTimes(1)
    expect(isModelQuotaAvailable).toHaveBeenCalledWith("chatbot-1", expect.anything(), "openai")
  })

  it("an error while checking the preferred model's quota is swallowed, falling through to the auto chain rather than throwing or hanging", async () => {
    vi.mocked(getEntitlementForChatbot)
      .mockRejectedValueOnce(new Error("db unavailable")) // preference check fails
      .mockResolvedValueOnce(entitlement(["anthropic"])) // auto chain's own call succeeds
    vi.mocked(isModelQuotaAvailable).mockResolvedValue(true)

    const result = await selectModelForConversation("chatbot-1", "openai")
    expect(result).toEqual({ provider: "anthropic" })
  })

  it("when every model (preferred and fallback) is exhausted, returns null exactly like the unmodified auto chain always has", async () => {
    vi.mocked(getEntitlementForChatbot).mockResolvedValue(entitlement(["anthropic", "openai", "gemini"]))
    vi.mocked(isModelQuotaAvailable).mockResolvedValue(false)

    const result = await selectModelForConversation("chatbot-1", "gemini")
    expect(result).toBeNull()
  })

  it("selectModelForNewConversation itself is untouched — calling it directly still works exactly as before this capability existed", async () => {
    vi.mocked(getEntitlementForChatbot).mockResolvedValue(entitlement(["anthropic", "openai", "gemini"]))
    vi.mocked(isModelQuotaAvailable).mockResolvedValue(true)

    const result = await selectModelForNewConversation("chatbot-1")
    expect(result).toEqual({ provider: "openai" })
  })
})
