import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"

import { pool } from "../../src/lib/db.js"
import { checkAnsweringGate } from "../../src/services/accessGate.service.js"
import { createReadyChatbotWithDomain } from "../helpers.js"

// CS-13 (B06-008): the answering gate fails closed.
describe("CS-13 answering gate fails closed", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("blocks with gate_unavailable when the gate's database lookup throws", async () => {
    const { chatbotId } = await createReadyChatbotWithDomain("cs13-gate-down", `cs13-gate-down-${Date.now()}.test`)
    vi.spyOn(pool!, "query").mockRejectedValue(new Error("connection terminated unexpectedly"))

    const gate = await checkAnsweringGate(chatbotId)
    expect(gate.blocked).toBe(true)
    expect(gate.reason).toBe("gate_unavailable")
    expect(gate.retryAfterSeconds).toBeGreaterThan(0)
  })

  it("blocks a chatbot id that does not exist", async () => {
    const gate = await checkAnsweringGate(randomUUID())
    expect(gate.blocked).toBe(true)
  })

  it("still lets a healthy, active chatbot answer", async () => {
    const { chatbotId } = await createReadyChatbotWithDomain("cs13-gate-ok", `cs13-gate-ok-${Date.now()}.test`)
    const gate = await checkAnsweringGate(chatbotId)
    expect(gate.blocked).toBe(false)
  })
})
