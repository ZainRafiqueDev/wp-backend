import { describe, expect, it } from "vitest"

import { isCircuitOpen, recordCircuitFailure, recordCircuitSuccess } from "../../src/lib/circuitBreaker.js"

function provider(): string {
  return `test-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

describe("WP-4.2 Redis circuit breaker", () => {
  it("starts closed", async () => {
    expect(await isCircuitOpen(provider())).toBe(false)
  })

  it("opens after 5 failures in the window", async () => {
    const name = provider()
    for (let i = 0; i < 5; i += 1) {
      await recordCircuitFailure(name)
    }
    expect(await isCircuitOpen(name)).toBe(true)
  })

  it("stays closed after a single failure", async () => {
    const name = provider()
    await recordCircuitFailure(name)
    expect(await isCircuitOpen(name)).toBe(false)
  })

  it("records success on a closed circuit without opening", async () => {
    const name = provider()
    await recordCircuitSuccess(name)
    expect(await isCircuitOpen(name)).toBe(false)
  })
})
