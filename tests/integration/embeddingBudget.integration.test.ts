import { describe, expect, it, vi } from "vitest"

vi.mock("@langchain/openai", () => ({
  OpenAIEmbeddings: class {
    embedDocuments = vi.fn(async (texts: string[]) => texts.map(() => Array.from({ length: 1536 }, () => 0.01)))
    embedQuery = vi.fn(async () => Array.from({ length: 1536 }, () => 0.01))
  },
}))

const { pool } = await import("../../src/lib/db.js")
const { env } = await import("../../src/env.js")
const { EmbeddingBudgetError, reserveEmbeddingBudget } = await import("../../src/lib/embeddingBudget.js")
const { embedTexts } = await import("../../src/services/embeddings.service.js")
const { seedOwnedChatbot } = await import("../helpers/seedTenant.js")

describe("WP-2.4 embedding budget", () => {
  it("rejects an over-budget embed and never stores a second reservation", async () => {
    const tenant = await seedOwnedChatbot("emb-budget")
    const first = await reserveEmbeddingBudget({
      chatbotId: tenant.chatbotId,
      callCount: 1,
      tokenCount: 10,
      costUsd: env.embeddingDailyBudgetUsd,
    })
    expect(first.costUsd).toBeGreaterThan(0)

    await expect(
      reserveEmbeddingBudget({
        chatbotId: tenant.chatbotId,
        callCount: 1,
        tokenCount: 10,
        costUsd: 0.000001,
      }),
    ).rejects.toBeInstanceOf(EmbeddingBudgetError)

    // CS-17 (B09-003): used to run only when a real OPENAI_API_KEY was set.
    // The provider SDK is mocked above and the test env always provides a
    // (fake) key, so this always runs; assert that rather than skip.
    expect(env.openaiApiKey, "test env must provide a (fake) OPENAI_API_KEY").toBeTruthy()
    await expect(embedTexts(["SKU-99XZ replacement filter"], { chatbotId: tenant.chatbotId, purpose: "document_ingest" })).rejects.toBeInstanceOf(
      EmbeddingBudgetError,
    )

    const { rows } = await pool!.query<{ cost_usd: string }>(
      `select cost_usd from embedding_usage_daily where user_id = $1 and usage_day = $2::date`,
      [first.userId, first.usageDay],
    )
    expect(Number(rows[0].cost_usd)).toBeCloseTo(env.embeddingDailyBudgetUsd, 6)
  })

  it("writes model and dim on a budgeted embed (provider SDK mocked)", async () => {
    expect(env.openaiApiKey, "test env must provide a (fake) OPENAI_API_KEY").toBeTruthy()
    const tenant = await seedOwnedChatbot("emb-identity")
    const vectors = await embedTexts(["hello embedding identity"], { chatbotId: tenant.chatbotId, purpose: "document_query" })
    expect(vectors[0]).toHaveLength(1536)
  })

  it("admits only one of two concurrent reservations that would exceed the daily cap", async () => {
    const tenant = await seedOwnedChatbot("emb-race")
    const half = env.embeddingDailyBudgetUsd / 2 + 0.000001
    const results = await Promise.allSettled([
      reserveEmbeddingBudget({
        chatbotId: tenant.chatbotId,
        callCount: 1,
        tokenCount: 10,
        costUsd: half,
      }),
      reserveEmbeddingBudget({
        chatbotId: tenant.chatbotId,
        callCount: 1,
        tokenCount: 10,
        costUsd: half,
      }),
      reserveEmbeddingBudget({
        chatbotId: tenant.chatbotId,
        callCount: 1,
        tokenCount: 10,
        costUsd: half,
      }),
    ])
    const fulfilled = results.filter((result) => result.status === "fulfilled")
    const rejected = results.filter((result) => result.status === "rejected")
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(2)
    expect(rejected.every((result) => result.reason instanceof EmbeddingBudgetError)).toBe(true)
  })
})
