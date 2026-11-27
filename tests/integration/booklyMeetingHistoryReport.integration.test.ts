import { randomUUID } from "node:crypto"
import { describe, expect, it, vi } from "vitest"

// Capability 3 — wiring Bookly's meeting-history report into ChatMate360's
// OWN dashboard: downloadBooklyMeetingHistoryReport (the service backing
// GET /chatbots/:chatbotId/bookly/meeting-history) must use this chatbot's
// own stored, decrypted, scoped credentials (the SAME connector/auth
// pattern as every other Bookly call — see booklyMultiResource's
// seedFullCustomBooklyChatbot pattern, reused here), respect existing
// ownership (requireOwnedChatbotId), and turn a Bookly outage into a clean
// error rather than a hang or crash.
vi.mock("../../src/lib/bookly/connector.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/bookly/connector.js")>("../../src/lib/bookly/connector.js")
  return { ...actual, getMeetingHistoryReportPdf: vi.fn() }
})

const { pool } = await import("../../src/lib/db.js")
const { encryptSecret } = await import("../../src/lib/crypto.js")
const { downloadBooklyMeetingHistoryReport } = await import("../../src/services/booklyCredentials.service.js")
const booklyConnector = await import("../../src/lib/bookly/connector.js")
const { signupUser } = await import("../helpers.js")

async function seedFullCustomBooklyChatbot(label: string) {
  const db = pool!
  const signup = await signupUser(label)
  await db.query(`insert into subscriptions (user_id, stripe_customer_id, plan, status) values ($1, $2, 'full_custom', 'active')`, [
    signup.user.id,
    `cus_${randomUUID()}`,
  ])
  const { rows: chatbotRows } = await db.query(
    "insert into chatbots (user_id, name, sources, theme, status) values ($1, 'bot', '[]', '{}', 'ready') returning id",
    [signup.user.id],
  )
  const chatbotId = chatbotRows[0].id as string
  const resourceId = `resource-${randomUUID()}`
  await db.query(
    `insert into chatbot_bookly_credentials (chatbot_id, base_url, resource_id, resource_label, api_key_encrypted) values ($1, 'https://bookly.example.com', $2, 'Alice', $3)`,
    [chatbotId, resourceId, encryptSecret("test-bookly-api-key")],
  )
  return { chatbotId, resourceId, accessToken: signup.session.access_token as string }
}

describe("downloadBooklyMeetingHistoryReport — Bookly report wired into ChatMate360's own dashboard", () => {
  it("the owner downloads their own real report — the PDF bytes from the connector are returned unmodified", async () => {
    const fakePdf = Buffer.from("%PDF-1.4 fake report bytes %%EOF")
    vi.mocked(booklyConnector.getMeetingHistoryReportPdf).mockReset()
    vi.mocked(booklyConnector.getMeetingHistoryReportPdf).mockResolvedValueOnce(fakePdf)

    const { chatbotId, accessToken } = await seedFullCustomBooklyChatbot("meeting-history-owner")
    const pdf = await downloadBooklyMeetingHistoryReport(accessToken, chatbotId, {})

    expect(pdf).toBe(fakePdf)
    expect(booklyConnector.getMeetingHistoryReportPdf).toHaveBeenCalledTimes(1)
    const [creds] = vi.mocked(booklyConnector.getMeetingHistoryReportPdf).mock.calls[0]
    // This chatbot's own decrypted credential, not a hardcoded/shared one.
    expect(creds).toMatchObject({ baseUrl: "https://bookly.example.com", apiKey: "test-bookly-api-key" })
  })

  it("a request for another chatbot's report is rejected, even with that chatbot's real, known-valid id", async () => {
    vi.mocked(booklyConnector.getMeetingHistoryReportPdf).mockReset()
    const owner = await seedFullCustomBooklyChatbot("meeting-history-owner-2")
    const otherOwner = await seedFullCustomBooklyChatbot("meeting-history-other-tenant")

    await expect(downloadBooklyMeetingHistoryReport(owner.accessToken, otherOwner.chatbotId, {})).rejects.toThrow(/chatbot not found/i)
    expect(booklyConnector.getMeetingHistoryReportPdf).not.toHaveBeenCalled()
  })

  it("a Bookly outage (unreachable server) surfaces as a clear error, not a hang or crash", async () => {
    vi.mocked(booklyConnector.getMeetingHistoryReportPdf).mockReset()
    vi.mocked(booklyConnector.getMeetingHistoryReportPdf).mockRejectedValueOnce(new booklyConnector.BooklyApiError(0, "Could not reach the Bookly server."))

    const { chatbotId, accessToken } = await seedFullCustomBooklyChatbot("meeting-history-outage")
    await expect(downloadBooklyMeetingHistoryReport(accessToken, chatbotId, {})).rejects.toThrow(/could not reach the bookly server/i)
  })

  it("a revoked/invalid Bookly API key surfaces as a clear, actionable error", async () => {
    vi.mocked(booklyConnector.getMeetingHistoryReportPdf).mockReset()
    vi.mocked(booklyConnector.getMeetingHistoryReportPdf).mockRejectedValueOnce(new booklyConnector.BooklyApiError(401, "Invalid or revoked API key"))

    const { chatbotId, accessToken } = await seedFullCustomBooklyChatbot("meeting-history-revoked")
    await expect(downloadBooklyMeetingHistoryReport(accessToken, chatbotId, {})).rejects.toThrow(/invalid or revoked/i)
  })

  it("a chatbot with no Bookly connection at all gets a clear error, never a call to the connector", async () => {
    const db = pool!
    const signup = await signupUser("meeting-history-no-connection")
    await db.query(`insert into subscriptions (user_id, stripe_customer_id, plan, status) values ($1, $2, 'full_custom', 'active')`, [
      signup.user.id,
      `cus_${randomUUID()}`,
    ])
    const { rows: chatbotRows } = await db.query(
      "insert into chatbots (user_id, name, sources, theme, status) values ($1, 'bot', '[]', '{}', 'ready') returning id",
      [signup.user.id],
    )
    const chatbotId = chatbotRows[0].id as string

    vi.mocked(booklyConnector.getMeetingHistoryReportPdf).mockReset()
    await expect(downloadBooklyMeetingHistoryReport(signup.session.access_token as string, chatbotId, {})).rejects.toThrow(/connect a bookly resource/i)
    expect(booklyConnector.getMeetingHistoryReportPdf).not.toHaveBeenCalled()
  })
})
