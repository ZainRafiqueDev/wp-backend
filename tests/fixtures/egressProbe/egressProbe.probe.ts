import dns from "node:dns"
import net from "node:net"
import tls from "node:tls"

import { request as undiciRequest } from "undici"
import { expect, it } from "vitest"

// CS-17 egress-guard probe. NOT part of the normal suite (not *.test.ts):
// tests/unit/egressGuardProbe.test.ts runs this file in a child vitest with
// tests/fixtures/egressProbe/vitest.probe.config.ts and asserts that the
// FILE fails, even though every test below passes — i.e. a blocked call
// cannot be hidden by code that swallows the error.
//
// Targets are TEST-NET addresses (RFC 5737) and the reserved .invalid TLD,
// so nothing real could be reached even if the guard were missing.

function socketError(socket: net.Socket): Promise<NodeJS.ErrnoException> {
  return new Promise((resolve, reject) => {
    socket.once("error", resolve)
    socket.once("connect", () => {
      socket.destroy()
      reject(new Error("connected — the guard did not block this socket"))
    })
  })
}

it("net.connect to a remote address is blocked", async () => {
  const err = await socketError(net.connect({ host: "198.51.100.7", port: 443 }))
  expect(err.name).toBe("BlockedEgressError")
})

it("net.createConnection(port, host) to a remote name is blocked", async () => {
  const err = await socketError(net.createConnection(443, "probe.invalid"))
  expect(err.name).toBe("BlockedEgressError")
})

it("tls.connect to a remote host is blocked", async () => {
  const err = await socketError(tls.connect({ host: "203.0.113.9", port: 443, servername: "probe.invalid" }))
  expect(err.name).toBe("BlockedEgressError")
})

it("dns.lookup of a remote name is blocked", async () => {
  const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => dns.lookup("probe.invalid", (e) => resolve(e)))
  expect(err?.name).toBe("BlockedEgressError")
  await expect(dns.promises.lookup("probe.invalid")).rejects.toMatchObject({ name: "BlockedEgressError" })
})

it("the npm undici client (own Agent, not global fetch) is blocked at the socket", async () => {
  await expect(undiciRequest("http://198.51.100.8/")).rejects.toThrow()
})
