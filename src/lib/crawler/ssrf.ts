import dns from "node:dns/promises"
import { isIPv4, isIPv6 } from "node:net"


export class SsrfBlockedError extends Error {}


// Everything that is not globally reachable public unicast (RFC 6890 / IANA
// special-purpose registries). Checked against the 32-bit value, so every
// IPv4 spelling that reaches here has already been normalised to an integer.
const BLOCKED_IPV4_RANGES: [string, number, string][] = [
  ["0.0.0.0", 8, "unspecified / this-network"],
  ["10.0.0.0", 8, "private"],
  ["100.64.0.0", 10, "carrier-grade NAT"],
  ["127.0.0.0", 8, "loopback"],
  ["169.254.0.0", 16, "link-local / cloud metadata"],
  ["172.16.0.0", 12, "private"],
  ["192.0.0.0", 24, "IETF protocol assignments"],
  ["192.0.2.0", 24, "documentation"],
  ["192.88.99.0", 24, "6to4 relay anycast"],
  ["192.168.0.0", 16, "private"],
  ["198.18.0.0", 15, "benchmarking"],
  ["198.51.100.0", 24, "documentation"],
  ["203.0.113.0", 24, "documentation"],
  ["224.0.0.0", 4, "multicast"],
  ["240.0.0.0", 4, "reserved / broadcast"],
]

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map(Number)
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
}

const BLOCKED_IPV4_INTS = BLOCKED_IPV4_RANGES.map(([base, bits, reason]) => {
  const mask = (~0 << (32 - bits)) >>> 0
  return { network: (ipv4ToInt(base) & mask) >>> 0, mask, reason }
})

function classifyIPv4Int(value: number): string | null {
  for (const { network, mask, reason } of BLOCKED_IPV4_INTS) {
    if (((value & mask) >>> 0) === network) return reason
  }
  return null
}

/**
 * Parses any valid IPv6 text form (compressed, expanded, with a dotted IPv4
 * tail, with a zone id) into its eight 16-bit groups. Returns null if the
 * input is not a valid IPv6 address.
 */
function parseIPv6(input: string): number[] | null {
  let text = input.toLowerCase()
  const zone = text.indexOf("%")
  if (zone >= 0) text = text.slice(0, zone)
  if (!isIPv6(text)) return null

  // A dotted IPv4 tail ("::ffff:127.0.0.1") becomes two hex groups.
  const lastColon = text.lastIndexOf(":")
  const tail = text.slice(lastColon + 1)
  if (tail.includes(".")) {
    if (!isIPv4(tail)) return null
    const value = ipv4ToInt(tail)
    text = `${text.slice(0, lastColon + 1)}${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`
  }

  const toGroups = (part: string) => (part === "" ? [] : part.split(":").map((g) => Number.parseInt(g, 16)))
  const doubleColon = text.indexOf("::")
  let groups: number[]
  if (doubleColon >= 0) {
    const head = toGroups(text.slice(0, doubleColon))
    const rest = toGroups(text.slice(doubleColon + 2))
    const fill = 8 - head.length - rest.length
    if (fill < 1) return null
    groups = [...head, ...new Array<number>(fill).fill(0), ...rest]
  } else {
    groups = toGroups(text)
  }
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null
  return groups
}

function embeddedIPv4(high: number, low: number): number {
  return ((high << 16) | low) >>> 0
}

function classifyEmbedded(kind: string, value: number): string | null {
  const reason = classifyIPv4Int(value)
  return reason ? `${kind} embedding ${reason} IPv4` : null
}

function classifyIPv6Groups(g: number[]): string | null {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g
  const zeroUpTo = (n: number) => g.slice(0, n).every((x) => x === 0)

  // ::/96 — unspecified (::), loopback (::1) and the deprecated
  // IPv4-compatible form (::a.b.c.d). None is a legitimate fetch target.
  if (zeroUpTo(6)) {
    if (g6 === 0 && g7 === 0) return "unspecified"
    if (g6 === 0 && g7 === 1) return "loopback"
    return "IPv4-compatible (deprecated)"
  }
  // ::ffff:0:0/96 — IPv4-mapped; a dual-stack socket connects to the IPv4.
  if (zeroUpTo(5) && g5 === 0xffff) return classifyEmbedded("IPv4-mapped", embeddedIPv4(g6, g7))
  // ::ffff:0:0:0/96 — IPv4-translated (RFC 2765).
  if (zeroUpTo(4) && g4 === 0xffff && g5 === 0) return classifyEmbedded("IPv4-translated", embeddedIPv4(g6, g7))
  // 64:ff9b::/96 — NAT64 well-known prefix; the gateway connects to the IPv4.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return classifyEmbedded("NAT64", embeddedIPv4(g6, g7))
  }
  // 64:ff9b:1::/48 — local-use NAT64 (RFC 8215); the embedding is site-defined.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return "local-use NAT64"
  // 100::/64 — discard-only.
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return "discard-only"
  // 2001::/32 — Teredo. The embedded server and (obfuscated) client IPv4s are
  // attacker-chosen and Teredo is obsolete, so the whole prefix is refused.
  if (g0 === 0x2001 && g1 === 0) return "Teredo"
  if (g0 === 0x2001 && g1 === 0x2 && g2 === 0) return "benchmarking"
  if (g0 === 0x2001 && (g1 & 0xfff0) === 0x10) return "ORCHID"
  if (g0 === 0x2001 && (g1 & 0xfff0) === 0x20) return "ORCHIDv2"
  if (g0 === 0x2001 && g1 === 0xdb8) return "documentation"
  // 2002::/16 — 6to4; the relay connects to the IPv4 in groups 1-2.
  if (g0 === 0x2002) return classifyEmbedded("6to4", embeddedIPv4(g1, g2))
  if (g0 === 0x3fff && (g1 & 0xf000) === 0) return "documentation"
  if (g0 === 0x5f00) return "SRv6 SIDs"
  if (g0 === 0xfd00 && g1 === 0xec2 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 0x254) {
    return "cloud metadata"
  }
  if ((g0 & 0xfe00) === 0xfc00) return "unique local"
  if ((g0 & 0xffc0) === 0xfe80) return "link-local"
  if ((g0 & 0xffc0) === 0xfec0) return "site-local (deprecated)"
  if ((g0 & 0xff00) === 0xff00) return "multicast"
  // Only 2000::/3 is allocated as global unicast; everything else that was
  // not unwrapped above is reserved.
  if ((g0 & 0xe000) !== 0x2000) return "reserved"
  return null
}

/**
 * Why an address must not be fetched, or null when it is public unicast.
 * Unrecognised input is blocked (fail closed).
 */
export function classifyAddress(ip: string): string | null {
  if (isIPv4(ip)) return classifyIPv4Int(ipv4ToInt(ip))
  const groups = parseIPv6(ip)
  if (groups) return classifyIPv6Groups(groups)
  return "unrecognised address"
}

export function isPrivateAddress(ip: string): boolean {
  return classifyAddress(ip) !== null
}

// Test-only escape hatch so redirect/header tests can talk to a real loopback
// server. It applies only to a URL whose host is the literal 127.0.0.1 (never
// to DNS answers, so it cannot mask a rebinding test) and only while running
// under vitest; registering it anywhere else throws.
const literalLoopbackAllowedForTests = new Set<string>()

function runningUnderVitest(): boolean {
  return process.env.VITEST === "true" && process.env.NODE_ENV === "test"
}

export function allowLiteralLoopbackForTests(): () => void {
  if (!runningUnderVitest()) throw new Error("allowLiteralLoopbackForTests is only available under vitest")
  literalLoopbackAllowedForTests.add("127.0.0.1")
  return () => literalLoopbackAllowedForTests.delete("127.0.0.1")
}

function literalAllowedForTests(ip: string): boolean {
  return literalLoopbackAllowedForTests.has(ip) && runningUnderVitest()
}


export async function assertSafeUrl(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfBlockedError(`blocked scheme: ${url.protocol}`)
  }


  const hostname = url.hostname.replace(/^\[|\]$/g, "")

  if (isIPv4(hostname) || isIPv6(hostname)) {
    const reason = classifyAddress(hostname)
    if (reason && !literalAllowedForTests(hostname)) {
      throw new SsrfBlockedError(`blocked ${reason} address: ${hostname}`)
    }
    return
  }

  let records: { address: string }[]
  try {
    records = await dns.lookup(hostname, { all: true })
  } catch {
    throw new SsrfBlockedError(`DNS resolution failed for ${hostname}`)
  }
  if (records.length === 0) {
    throw new SsrfBlockedError(`no DNS records for ${hostname}`)
  }
  for (const { address } of records) {
    if (isPrivateAddress(address)) {
      throw new SsrfBlockedError(`${hostname} resolves to blocked address ${address}`)
    }
  }
}
