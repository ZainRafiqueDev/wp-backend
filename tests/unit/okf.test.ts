import { describe, expect, it } from "vitest"

import { formatOKFAnswer, levenshtein, normalizeOkfTitle, toOkfMarkdownFile } from "../../src/lib/okf.js"

describe("OKF helpers", () => {
  it("treats near-identical titles as a short levenshtein distance", () => {
    expect(levenshtein(normalizeOkfTitle("Refund Window"), normalizeOkfTitle("refund window"))).toBe(0)
    expect(levenshtein("refund", "refnd")).toBe(1)
  })

  it("returns the curated body verbatim and appends a citation", () => {
    const body = "Customers have **14 days** to request a refund."
    const answer = formatOKFAnswer(
      { title: "Refund Window", bodyMd: body, resourceUrl: "https://store.example/refund" },
      "what is the refund window",
    )
    expect(answer.startsWith(body)).toBe(true)
    expect(answer).toContain("Source: Refund Window (https://store.example/refund)")
    expect(answer.replace(/\n\nSource:.*$/, "")).toBe(body)
  })

  it("exports spec-compliant YAML frontmatter", () => {
    const md = toOkfMarkdownFile({
      id: "00000000-0000-0000-0000-000000000001",
      chatbotId: "00000000-0000-0000-0000-000000000002",
      type: "Policy",
      title: "Refund Window",
      description: "How long customers have to request a refund",
      tags: ["refund", "returns"],
      resourceUrl: "https://store.example/refund",
      okfVersion: "0.1",
      bodyMd: "Fourteen days.",
      isActive: true,
      createdBy: "human",
      approvedAt: "2026-09-28T10:00:00.000Z",
      sourceDocumentId: null,
      servedCount: 0,
      createdAt: "2026-09-28T10:00:00.000Z",
      updatedAt: "2026-09-28T10:00:00.000Z",
    })
    expect(md).toContain("type: Policy")
    expect(md).toContain("title: Refund Window")
    expect(md).toContain("Fourteen days.")
  })
})
