import { describe, expect, it, vi } from "vitest"

const incr = vi.fn(async () => 1)
const expire = vi.fn(async () => 1)

vi.mock("../../src/lib/redis.js", () => ({
  cacheRedis: { incr, expire },
}))

vi.mock("../../src/lib/db.js", () => ({
  pool: null,
}))

const { incrementIngestMetric } = await import("../../src/lib/ingestMetrics.js")

describe("WP-2.1 ingest metrics", () => {
  it("increments queue_depth, processing_age, and failed without throwing", async () => {
    incr.mockClear()
    expire.mockClear()
    await incrementIngestMetric("ingest.queue_depth", { depth: 1 })
    await incrementIngestMetric("ingest.processing_age", { ageMs: 12 })
    await incrementIngestMetric("ingest.failed", { documentId: "d1" })
    await incrementIngestMetric("ingest.scan_denied", { documentId: "d1" })
    await incrementIngestMetric("ingest.scan_error", { documentId: "d1" })
    expect(incr).toHaveBeenCalledTimes(5)
    expect(String(incr.mock.calls.at(0)?.at(0) ?? "")).toMatch(/^metric:ingest\.queue_depth:\d{4}-\d{2}-\d{2}$/)
    expect(String(incr.mock.calls.at(1)?.at(0) ?? "")).toMatch(/^metric:ingest\.processing_age:\d{4}-\d{2}-\d{2}$/)
    expect(String(incr.mock.calls.at(2)?.at(0) ?? "")).toMatch(/^metric:ingest\.failed:\d{4}-\d{2}-\d{2}$/)
    expect(String(incr.mock.calls.at(3)?.at(0) ?? "")).toMatch(/^metric:ingest\.scan_denied:\d{4}-\d{2}-\d{2}$/)
    expect(String(incr.mock.calls.at(4)?.at(0) ?? "")).toMatch(/^metric:ingest\.scan_error:\d{4}-\d{2}-\d{2}$/)
    expect(expire).toHaveBeenCalledTimes(5)
  })

  it("swallows Redis failures so ingest is not taken down", async () => {
    incr.mockRejectedValueOnce(new Error("redis down"))
    await expect(incrementIngestMetric("ingest.failed", { documentId: "d2" })).resolves.toBeUndefined()
  })
})
