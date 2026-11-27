import { describe, expect, it } from "vitest"

import { buildAttachmentNoticePages } from "../../src/lib/answerChatbotQuestion.js"

describe("buildAttachmentNoticePages", () => {
  it("returns nothing when there are no attachments", () => {
    expect(buildAttachmentNoticePages([])).toEqual([])
  })

  it("names the single file and forbids claiming to have read it", () => {
    const [page] = buildAttachmentNoticePages(["invoice.pdf"])
    expect(page.kind).toBe("attachment")
    expect(page.text).toContain("invoice.pdf")
    expect(page.text).toMatch(/cannot see its contents/i)
    expect(page.text).toMatch(/never claim to have read, viewed, opened, or looked at the file/i)
  })

  it("uses plural phrasing and lists every file when there are several", () => {
    const [page] = buildAttachmentNoticePages(["a.png", "b.pdf"])
    expect(page.text).toContain("a.png, b.pdf")
    expect(page.text).toMatch(/cannot see their contents/i)
  })
})
