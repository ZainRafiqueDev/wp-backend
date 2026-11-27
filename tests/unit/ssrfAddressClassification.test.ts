import { beforeEach, describe, expect, it, vi } from "vitest"

// CS-08 (B04-027 / S3-019): every IPv6 spelling that reaches a private,
// loopback or metadata IPv4 (or is itself non-public) must be refused, both
// as a URL literal (after WHATWG normalisation, e.g. [::ffff:127.0.0.1] ->
// [::ffff:7f00:1]) and as a DNS answer. Public addresses must still pass.

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }))
vi.mock("node:dns/promises", () => ({
  default: { lookup: (...args: unknown[]) => lookupMock(...args) },
  lookup: (...args: unknown[]) => lookupMock(...args),
}))

const { assertSafeUrl, isPrivateAddress, SsrfBlockedError } = await import("../../src/lib/crawler/ssrf.js")

const BLOCKED_URLS: [string, string][] = [
  // IPv4-mapped, hex form (what new URL() produces) and dotted input form
  ["http://[::ffff:7f00:1]/", "IPv4-mapped loopback (hex)"],
  ["http://[::ffff:127.0.0.1]/", "IPv4-mapped loopback (dotted, normalised to hex)"],
  ["http://[::ffff:a9fe:a9fe]/latest/meta-data/", "IPv4-mapped 169.254.169.254"],
  ["http://[::ffff:a00:1]/", "IPv4-mapped 10.0.0.1"],
  ["http://[::ffff:c0a8:101]/", "IPv4-mapped 192.168.1.1"],
  ["http://[0:0:0:0:0:ffff:7f00:1]/", "IPv4-mapped loopback (expanded)"],
  // IPv4-translated (RFC 2765)
  ["http://[::ffff:0:7f00:1]/", "IPv4-translated loopback"],
  // IPv4-compatible (deprecated ::/96)
  ["http://[::7f00:1]/", "IPv4-compatible loopback"],
  ["http://[::127.0.0.1]/", "IPv4-compatible loopback (dotted)"],
  ["http://[::a9fe:a9fe]/", "IPv4-compatible metadata"],
  // NAT64
  ["http://[64:ff9b::7f00:1]/", "NAT64 loopback"],
  ["http://[64:ff9b::a9fe:a9fe]/", "NAT64 metadata"],
  ["http://[64:ff9b::10.0.0.1]/", "NAT64 private (dotted)"],
  ["http://[64:ff9b:1::1]/", "local-use NAT64"],
  // 6to4 embedding private IPv4
  ["http://[2002:7f00:1::]/", "6to4 loopback"],
  ["http://[2002:a9fe:a9fe::1]/", "6to4 metadata"],
  ["http://[2002:c0a8:101::1]/", "6to4 192.168.1.1"],
  ["http://[2002:a00:1::1]/", "6to4 10.0.0.1"],
  // Teredo
  ["http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/", "Teredo"],
  ["http://[2001::7f00:1]/", "Teredo (compressed)"],
  // Native IPv6 special-purpose ranges
  ["http://[::]/", "unspecified"],
  ["http://[::1]/", "loopback"],
  ["http://[0:0:0:0:0:0:0:1]/", "loopback (expanded)"],
  ["http://[fd00:ec2::254]/", "AWS IPv6 metadata"],
  ["http://[fc00::1]/", "ULA fc00::/7"],
  ["http://[fdff:ffff::1]/", "ULA fd"],
  ["http://[fe80::1]/", "link-local"],
  ["http://[febf::1]/", "link-local upper"],
  ["http://[fec0::1]/", "site-local"],
  ["http://[ff02::1]/", "multicast"],
  ["http://[100::1]/", "discard-only"],
  ["http://[2001:db8::1]/", "documentation"],
  ["http://[2001:2::1]/", "benchmarking"],
  ["http://[2001:10::1]/", "ORCHID"],
  ["http://[2001:20::1]/", "ORCHIDv2"],
  ["http://[3fff::1]/", "documentation 3fff::/20"],
  ["http://[5f00::1]/", "SRv6"],
  ["http://[4000::1]/", "outside 2000::/3"],
  // IPv4
  ["http://127.0.0.1/", "loopback"],
  ["http://127.255.255.254/", "loopback /8"],
  ["http://0.0.0.0/", "unspecified"],
  ["http://10.1.2.3/", "private 10/8"],
  ["http://172.31.255.255/", "private 172.16/12"],
  ["http://192.168.0.1/", "private 192.168/16"],
  ["http://100.64.0.1/", "CGNAT"],
  ["http://100.100.100.200/", "CGNAT (Alibaba metadata)"],
  ["http://169.254.169.254/", "link-local metadata"],
  ["http://192.0.0.192/", "IETF protocol assignments (Oracle metadata)"],
  ["http://192.0.2.1/", "TEST-NET-1"],
  ["http://192.88.99.1/", "6to4 relay anycast"],
  ["http://198.18.0.1/", "benchmarking"],
  ["http://198.51.100.1/", "TEST-NET-2"],
  ["http://203.0.113.1/", "TEST-NET-3"],
  ["http://224.0.0.1/", "multicast"],
  ["http://240.0.0.1/", "reserved"],
  ["http://255.255.255.255/", "broadcast"],
  // Alternative IPv4 spellings (normalised by the URL parser)
  ["http://2130706433/", "decimal loopback"],
  ["http://0x7f.0.0.1/", "hex-octet loopback"],
  ["http://0177.0.0.1/", "octal loopback"],
  ["http://127.1/", "short-form loopback"],
  ["http://0xa9fea9fe/", "hex metadata"],
]

const ALLOWED_URLS: [string, string][] = [
  ["http://8.8.8.8/", "public IPv4"],
  ["https://1.1.1.1/", "public IPv4"],
  ["http://93.184.216.34/", "public IPv4"],
  ["http://100.128.0.1/", "just outside CGNAT"],
  ["http://172.32.0.1/", "just outside 172.16/12"],
  ["http://[2001:4860:4860::8888]/", "public IPv6"],
  ["http://[2606:4700:4700::1111]/", "public IPv6"],
  ["http://[2a00:1450:4001:80b::200e]/", "public IPv6"],
  ["http://[::ffff:808:808]/", "IPv4-mapped public"],
  ["http://[64:ff9b::808:808]/", "NAT64 public"],
  ["http://[2002:808:808::1]/", "6to4 public"],
]

const BLOCKED_DNS_ANSWERS = [
  "::ffff:7f00:1",
  "::ffff:127.0.0.1",
  "::ffff:a9fe:a9fe",
  "64:ff9b::a9fe:a9fe",
  "2002:7f00:1::",
  "2001:0:4136:e378:8000:63bf:3fff:fdd2",
  "fd00:ec2::254",
  "fe80::1%eth0",
  "::",
  "100.64.0.1",
]

describe("SSRF address classification (CS-08)", () => {
  beforeEach(() => {
    lookupMock.mockReset()
  })

  it.each(BLOCKED_URLS)("blocks %s (%s)", async (url) => {
    await expect(assertSafeUrl(new URL(url))).rejects.toBeInstanceOf(SsrfBlockedError)
    expect(lookupMock).not.toHaveBeenCalled()
  })

  it.each(ALLOWED_URLS)("allows %s (%s)", async (url) => {
    await expect(assertSafeUrl(new URL(url))).resolves.toBeUndefined()
    expect(lookupMock).not.toHaveBeenCalled()
  })

  it.each(BLOCKED_DNS_ANSWERS)("blocks a hostname whose DNS answer is %s", async (address) => {
    lookupMock.mockResolvedValueOnce([{ address: "93.184.216.34" }, { address }])
    await expect(assertSafeUrl(new URL("https://tenant-site.example/"))).rejects.toBeInstanceOf(SsrfBlockedError)
  })

  it("allows a hostname whose DNS answers are all public (IPv4 + IPv6)", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "93.184.216.34" }, { address: "2606:2800:220:1:248:1893:25c8:1946" }])
    await expect(assertSafeUrl(new URL("https://example.com/"))).resolves.toBeUndefined()
  })

  it("isPrivateAddress (used by the connect-time lookup) agrees with the URL checks", () => {
    for (const address of BLOCKED_DNS_ANSWERS) expect(isPrivateAddress(address), address).toBe(true)
    for (const address of ["8.8.8.8", "2001:4860:4860::8888", "::ffff:8.8.8.8"]) {
      expect(isPrivateAddress(address), address).toBe(false)
    }
    // Unrecognised input fails closed.
    expect(isPrivateAddress("not-an-ip")).toBe(true)
    expect(isPrivateAddress("")).toBe(true)
  })
})
