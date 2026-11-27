import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Same reason as tests/unit/ai.test.ts: provider keys are read at
// module-evaluation time, so they're stubbed before the first import here,
// scoped to this file only via dynamic import.
vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-key")
vi.stubEnv("OPENAI_API_KEY", "test-openai-key")
vi.resetModules()

const { answerQuestion } = await import("../../src/lib/ai.js")
const { validateActionParams } = await import("../../src/lib/actionExecutor.js")
import type { ActionToolDef, ToolExecutor } from "../../src/lib/actions.js"

const page = { path: "/", title: "Orders", text: "General order and shipping policy information." }

const trackShipmentTool: ActionToolDef = {
  name: "track_shipment",
  description: "Use this when the user asks about the status of an order or shipment.",
  parameters: [{ name: "order_id", type: "string", description: "The order id", required: true }],
}

function jsonResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body, text: async () => JSON.stringify(body) } as Response
}

function withUsage(body: Record<string, unknown>, inputTokens: number, outputTokens: number) {
  return { ...body, usage: { input_tokens: inputTokens, output_tokens: outputTokens } }
}

describe("answerQuestion — real LLM tool-calling", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("executes a requested tool call and produces a grounded final answer from its result", async () => {
    const fetchMock = vi.mocked(fetch)
    // 1st call: Claude asks to call track_shipment. 2nd call: Claude answers
    // using the tool result it was fed back.
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          content: [{ type: "tool_use", id: "call_1", name: "track_shipment", input: { order_id: "A123" } }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ content: [{ type: "text", text: "Order A123 has shipped." }] }),
      )

    const executeTool: ToolExecutor = vi.fn(async (name, args) => {
      expect(name).toBe("track_shipment")
      expect(args).toEqual({ order_id: "A123" })
      return { content: JSON.stringify({ status: "shipped" }), isError: false }
    })

    const toolResultSink: string[] = []
    const answer = await answerQuestion(
      "Acme",
      [page],
      "Where's my order A123?",
      [],
      [trackShipmentTool],
      executeTool,
      toolResultSink,
    )

    expect(answer).toBe("Order A123 has shipped.")
    expect(executeTool).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // The tool's real result is captured for the caller's grounding check —
    // without this, "Order A123 has shipped" would fail verifyGroundedClaims
    // since that fact isn't in the crawled `page` content.
    expect(toolResultSink).toEqual([JSON.stringify({ status: "shipped" })])
  })

  it("feeds back a clear 'unavailable' tool result on failure instead of letting the model improvise", async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          content: [{ type: "tool_use", id: "call_1", name: "track_shipment", input: { order_id: "A123" } }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ content: [{ type: "text", text: "I'm unable to check that order's status right now." }] }),
      )

    const executeTool: ToolExecutor = vi.fn(async () => ({
      content: "This action is currently unavailable.",
      isError: true,
    }))

    const toolResultSink: string[] = []
    const answer = await answerQuestion(
      "Acme",
      [page],
      "Where's my order A123?",
      [],
      [trackShipmentTool],
      executeTool,
      toolResultSink,
    )

    expect(answer).toBe("I'm unable to check that order's status right now.")
    // A failed call's content is never fed into the grounding-check sink —
    // it isn't a verified fact, so it shouldn't be treated as one.
    expect(toolResultSink).toEqual([])

    // The model was told the call failed, not left to guess.
    const secondCallBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body))
    const toolResultMessage = secondCallBody.messages.at(-1)
    expect(toolResultMessage.content[0].is_error).toBe(true)
    expect(toolResultMessage.content[0].content).toBe("This action is currently unavailable.")
  })

  it("caps tool calls per turn and stops executing once the limit is reached", async () => {
    const fetchMock = vi.mocked(fetch)
    // Keeps asking to call the tool, forever, if allowed to.
    fetchMock.mockResolvedValue(
      jsonResponse({
        content: [{ type: "tool_use", id: "call_x", name: "track_shipment", input: { order_id: "A123" } }],
      }),
    )

    const executeTool: ToolExecutor = vi.fn(async () => ({ content: "{}", isError: false }))

    await answerQuestion("Acme", [page], "Where's my order?", [], [trackShipmentTool], executeTool, [])

    // MAX_TOOL_CALLS = 3 in src/lib/ai.ts — never more real executions than that.
    expect(executeTool).toHaveBeenCalledTimes(3)
  })

  it("captures token usage for every round trip, including tool-call overhead (Task 3 metering)", async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(
          withUsage(
            { content: [{ type: "tool_use", id: "call_1", name: "track_shipment", input: { order_id: "A123" } }] },
            120,
            15,
          ),
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(withUsage({ content: [{ type: "text", text: "Order A123 has shipped." }] }, 180, 8)),
      )

    const executeTool: ToolExecutor = vi.fn(async () => ({ content: JSON.stringify({ status: "shipped" }), isError: false }))
    const usageSink: import("../../src/lib/ai.js").AiUsage[] = []

    await answerQuestion("Acme", [page], "Where's my order A123?", [], [trackShipmentTool], executeTool, [], usageSink)

    // One entry per real HTTP round trip (the tool-use request AND the
    // follow-up that used its result), not just one for the final answer —
    // both were separately billed by the provider.
    expect(usageSink).toEqual([
      { provider: "anthropic", model: expect.any(String), inputTokens: 120, outputTokens: 15 },
      { provider: "anthropic", model: expect.any(String), inputTokens: 180, outputTokens: 8 },
    ])
  })

  it("rejects a tool call with a missing required parameter before any executor call", () => {
    const action = {
      id: "a1",
      chatbotId: "c1",
      name: "track_shipment",
      description: "desc",
      httpMethod: "GET" as const,
      urlTemplate: "https://api.example.com/{{order_id}}",
      headersTemplate: {},
      bodyTemplate: null,
      parameters: trackShipmentTool.parameters,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    const result = validateActionParams(action, {})
    expect(result.ok).toBe(false)
  })
})
