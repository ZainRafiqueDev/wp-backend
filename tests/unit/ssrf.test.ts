import { beforeEach, describe, expect, it, vi } from "vitest"

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }))
vi.mock("node:dns/promises", () => ({
  default: { lookup: (...args: unknown[]) => lookupMock(...args) },
  lookup: (...args: unknown[]) => lookupMock(...args),
}))

const { assertSafeUrl, SsrfBlockedError } = await import("../../src/lib/crawler/ssrf.js")

describe("assertSafeUrl", () => {
  beforeEach(() => {
    lookupMock.mockReset()
  })

  it("rejects loopback (IPv4 and bracketed IPv6 literal)", async () => {
    await expect(assertSafeUrl(new URL("http://127.0.0.1/"))).rejects.toBeInstanceOf(SsrfBlockedError)
    await expect(assertSafeUrl(new URL("http://[::1]/"))).rejects.toBeInstanceOf(SsrfBlockedError)
    // Recognized as an IPv6 literal (brackets stripped) and rejected by the
    // real isPrivateIPv6 range check, not by an incidental DNS failure.
    expect(lookupMock).not.toHaveBeenCalled()
  })

  it("allows a public IPv6 literal without a DNS lookup", async () => {
    await expect(assertSafeUrl(new URL("http://[2001:4860:4860::8888]/"))).resolves.toBeUndefined()
    expect(lookupMock).not.toHaveBeenCalled()
  })

  it("rejects RFC1918 private ranges", async () => {
    await expect(assertSafeUrl(new URL("http://10.0.0.5/"))).rejects.toBeInstanceOf(SsrfBlockedError)
    await expect(assertSafeUrl(new URL("http://172.16.0.5/"))).rejects.toBeInstanceOf(SsrfBlockedError)
    await expect(assertSafeUrl(new URL("http://192.168.1.5/"))).rejects.toBeInstanceOf(SsrfBlockedError)
  })

  it("rejects the cloud metadata endpoint (169.254.169.254)", async () => {
    await expect(assertSafeUrl(new URL("http://169.254.169.254/latest/meta-data/"))).rejects.toBeInstanceOf(
      SsrfBlockedError,
    )
  })

  it("rejects non-http(s) schemes", async () => {
    await expect(assertSafeUrl(new URL("file:///etc/passwd"))).rejects.toBeInstanceOf(SsrfBlockedError)
    await expect(assertSafeUrl(new URL("ftp://example.com/"))).rejects.toBeInstanceOf(SsrfBlockedError)
  })

  it("allows a public IPv4 literal (no DNS lookup needed)", async () => {
    await expect(assertSafeUrl(new URL("http://8.8.8.8/"))).resolves.toBeUndefined()
    expect(lookupMock).not.toHaveBeenCalled()
  })

  it("rejects a hostname whose DNS resolves to a private address", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "127.0.0.1" }])
    await expect(assertSafeUrl(new URL("http://internal-service.local/"))).rejects.toBeInstanceOf(SsrfBlockedError)
  })

  it("allows a hostname whose DNS resolves to a public address", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "93.184.216.34" }])
    await expect(assertSafeUrl(new URL("http://example.com/"))).resolves.toBeUndefined()
  })

  it("fails closed when DNS resolution errors", async () => {
    lookupMock.mockRejectedValueOnce(new Error("ENOTFOUND"))
    await expect(assertSafeUrl(new URL("http://does-not-resolve.invalid/"))).rejects.toBeInstanceOf(SsrfBlockedError)
  })
})
