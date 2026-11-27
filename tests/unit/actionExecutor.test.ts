import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { ChatbotAction } from "../../src/lib/actions.js"

// assertSafeUrl (lib/crawler/ssrf.ts) does a real DNS lookup for any
// non-IP-literal hostname — mocked here to a public address so the
// "successful call" tests below aren't making a real network request or
// depending on this sandbox having DNS access. Same pattern as
// tests/unit/ssrf.test.ts.
vi.mock("node:dns/promises", () => ({
  default: { lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) },
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}))

const { executeAction, validateActionParams } = await import("../../src/lib/actionExecutor.js")

function makeAction(overrides: Partial<ChatbotAction> = {}): ChatbotAction {
  return {
    id: "action-1",
    chatbotId: "chatbot-1",
    name: "check_order_status",
    description: "Use this when the user asks about an order's status.",
    httpMethod: "GET",
    urlTemplate: "https://api.example.com/orders/{{order_id}}",
    headersTemplate: {},
    bodyTemplate: null,
    parameters: [{ name: "order_id", type: "string", description: "The order id", required: true }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

describe("validateActionParams", () => {
  it("accepts a valid, fully-typed argument set", () => {
    const result = validateActionParams(makeAction(), { order_id: "A123" })
    expect(result).toEqual({ ok: true, values: { order_id: "A123" } })
  })

  it("rejects a missing required parameter before any HTTP call is attempted", () => {
    const result = validateActionParams(makeAction(), {})
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("order_id")
  })

  it("rejects a parameter of the wrong type", () => {
    const action = makeAction({
      parameters: [{ name: "quantity", type: "number", description: "How many", required: true }],
    })
    const result = validateActionParams(action, { quantity: "not-a-number" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("quantity")
  })

  it("omits an optional parameter that wasn't supplied, without error", () => {
    const action = makeAction({
      parameters: [
        { name: "order_id", type: "string", description: "id", required: true },
        { name: "note", type: "string", description: "optional note", required: false },
      ],
    })
    const result = validateActionParams(action, { order_id: "A123" })
    expect(result).toEqual({ ok: true, values: { order_id: "A123" } })
  })
})

describe("executeAction", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("blocks a private-IP action URL the same way the crawler's SSRF check does", async () => {
    const action = makeAction({ urlTemplate: "http://127.0.0.1:8080/{{order_id}}" })
    const result = await executeAction(action, { order_id: "A123" }, null)

    expect(result.isError).toBe(true)
    expect(result.content).toBe("This action is currently unavailable.")
    expect(fetch).not.toHaveBeenCalled()
  })

  it("blocks a cloud-metadata-address action URL", async () => {
    const action = makeAction({ urlTemplate: "http://169.254.169.254/latest/meta-data/{{order_id}}" })
    const result = await executeAction(action, { order_id: "A123" }, null)

    expect(result.isError).toBe(true)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("fills the URL template and adds the decrypted API key as a bearer token", async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ status: "shipped" }),
    } as Response)

    const action = makeAction()
    const result = await executeAction(action, { order_id: "A123" }, "secret-key")

    expect(result).toEqual({ content: JSON.stringify({ status: "shipped" }), isError: false })
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe("https://api.example.com/orders/A123")
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer secret-key")
  })

  it("produces a graceful 'unavailable' result on a timeout, not an unhandled error", async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockRejectedValueOnce(new Error("The operation was aborted"))

    const result = await executeAction(makeAction(), { order_id: "A123" }, null)

    expect(result).toEqual({ content: "This action is currently unavailable.", isError: true })
  })

  it("produces a graceful 'unavailable' result on a non-2xx response", async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, text: async () => "server error" } as Response)

    const result = await executeAction(makeAction(), { order_id: "A123" }, null)

    expect(result).toEqual({ content: "This action is currently unavailable.", isError: true })
  })

  // Audit 2026-11-27: model-chosen values must not move the request to
  // another host, path or query, and the saved API key only goes to the
  // template's fixed origin.
  it("percent-encodes model-supplied values so they can't add path segments, query or userinfo", async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => "{}" } as Response)

    await executeAction(makeAction(), { order_id: "A1/../../admin?delete=1#x" }, "secret-key")
    const [url, init] = fetchMock.mock.calls[0]
    expect(new URL(String(url)).pathname).toBe("/orders/A1%2F..%2F..%2Fadmin%3Fdelete%3D1%23x")
    expect(new URL(String(url)).search).toBe("")
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer secret-key")

    // "@evil.example" right after the host used to turn api.example.com into
    // userinfo; encoded, it is an invalid host and the call is refused.
    const hostAction = makeAction({ urlTemplate: "https://api.example.com{{order_id}}" })
    const hostResult = await executeAction(hostAction, { order_id: "@evil.example/steal" }, "secret-key")
    expect(hostResult).toEqual({ content: "This action is currently unavailable.", isError: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("refuses a bare dot-segment value", async () => {
    const result = await executeAction(makeAction(), { order_id: ".." }, "secret-key")
    expect(result).toEqual({ content: "This action is currently unavailable.", isError: true })
    expect(fetch).not.toHaveBeenCalled()
  })

  it("never sends the saved API key when the model fills in the host", async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, text: async () => "{}" } as Response)

    const action = makeAction({
      urlTemplate: "https://{{host}}/orders",
      parameters: [{ name: "host", type: "string", description: "host", required: true }],
    })
    await executeAction(action, { host: "attacker.example" }, "secret-key")

    const [url, init] = fetchMock.mock.calls[0]
    expect(new URL(String(url)).hostname).toBe("attacker.example")
    expect((init?.headers as Record<string, string>).Authorization).toBeUndefined()
  })

  it("doesn't override an action's own explicit Authorization header with the integration key", async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, text: async () => "{}" } as Response)

    const action = makeAction({ headersTemplate: { Authorization: "Basic owner-supplied" } })
    await executeAction(action, { order_id: "A123" }, "secret-key")

    const [, init] = fetchMock.mock.calls[0]
    expect((init?.headers as Record<string, string>).Authorization).toBe("Basic owner-supplied")
  })
})
