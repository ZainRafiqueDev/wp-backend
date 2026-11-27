import { describe, expect, it, vi, beforeEach } from "vitest"

vi.mock("../../src/services/billing.service.js", () => ({
  getEntitlementForChatbot: vi.fn(),
}))
vi.mock("../../src/services/usage.service.js", () => ({
  isModelQuotaAvailable: vi.fn(),
  getModelPeriodCostUsd: vi.fn(async () => 0),
  getEffectiveModelCapUsd: vi.fn(async () => 100),
}))
vi.mock("../../src/lib/circuitBreaker.js", () => ({
  isCircuitOpen: vi.fn(async () => false),
}))
vi.mock("../../src/services/modelCosts.service.js", () => ({
  cheapestAvailableProvider: vi.fn(async (allowed: string[]) => allowed.includes("gemini") ? "gemini" : allowed[0]),
}))
vi.mock("../../src/services/routingEvents.service.js", () => ({
  recordRoutingEvent: vi.fn(async () => undefined),
}))

const { isModelQuotaAvailable, getModelPeriodCostUsd, getEffectiveModelCapUsd } = await import(
  "../../src/services/usage.service.js"
)
const { isCircuitOpen } = await import("../../src/lib/circuitBreaker.js")
const { decideModelRoute } = await import("../../src/services/modelRouting.service.js")

function entitlement(allowed: string[] = ["openai", "anthropic", "gemini"]) {
  return { allowedModels: allowed } as never
}

beforeEach(() => {
  vi.mocked(isModelQuotaAvailable).mockReset().mockResolvedValue(true)
  vi.mocked(isCircuitOpen).mockReset().mockResolvedValue(false)
  vi.mocked(getModelPeriodCostUsd).mockReset().mockResolvedValue(0)
  vi.mocked(getEffectiveModelCapUsd).mockReset().mockResolvedValue(100)
})

describe("WP-4.3 model routing", () => {
  it("selects the preferred model when allowed, healthy, and under quota", async () => {
    const decision = await decideModelRoute({
      chatbotId: "00000000-0000-0000-0000-000000000001",
      entitlement: entitlement(),
      preferredModel: "gemini",
    })
    expect(decision?.provider).toBe("gemini")
    expect(decision?.reason).toBe("preferred")
  })

  it("skips an open circuit and uses the next fallback", async () => {
    vi.mocked(isCircuitOpen).mockImplementation(async (provider: string) => provider === "openai")
    const decision = await decideModelRoute({
      chatbotId: "00000000-0000-0000-0000-000000000001",
      entitlement: entitlement(),
      preferredModel: "openai",
    })
    expect(decision?.provider).not.toBe("openai")
    expect(decision?.reason).toBe("circuit_open")
  })

  it("never selects a model outside allowed_models", async () => {
    const decision = await decideModelRoute({
      chatbotId: "00000000-0000-0000-0000-000000000001",
      entitlement: entitlement(["openai"]),
      preferredModel: "gemini",
    })
    expect(decision?.provider).toBe("openai")
  })

  it("returns null when every candidate is exhausted", async () => {
    vi.mocked(isModelQuotaAvailable).mockResolvedValue(false)
    const decision = await decideModelRoute({
      chatbotId: "00000000-0000-0000-0000-000000000001",
      entitlement: entitlement(),
      preferredModel: "openai",
    })
    expect(decision).toBeNull()
  })

  it("routes to the cheapest allowed model when remaining credits are below the threshold", async () => {
    vi.mocked(getModelPeriodCostUsd).mockResolvedValue(90)
    vi.mocked(getEffectiveModelCapUsd).mockResolvedValue(100)
    const decision = await decideModelRoute({
      chatbotId: "00000000-0000-0000-0000-000000000001",
      entitlement: entitlement(["openai", "gemini"]),
      preferredModel: "openai",
    })
    expect(decision?.provider).toBe("gemini")
    expect(decision?.reason).toBe("cost_switching")
  })
})
