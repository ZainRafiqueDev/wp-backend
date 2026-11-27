import { spawnSync } from "node:child_process"
import path from "node:path"

import { describe, expect, it } from "vitest"

// CS-17 review item 5: blocked low-level calls (net.connect,
// net.createConnection, tls.connect, dns.lookup, the npm undici client) must
// not only be refused but must FAIL the test file, even when the code that
// made them swallows the error. The probe file's own tests all pass; the
// setup's afterAll is what must turn the file red.
describe("CS-17 egress guard probe (child vitest run)", () => {
  it("blocks every probe and fails the probe file", () => {
    const root = path.resolve(__dirname, "../..")
    const result = spawnSync(
      process.execPath,
      [path.join(root, "node_modules/vitest/vitest.mjs"), "run", "--config", "tests/fixtures/egressProbe/vitest.probe.config.ts"],
      { cwd: root, encoding: "utf8", env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" }, timeout: 120_000 },
    )
    const out = `${result.stdout}\n${result.stderr}`
    expect(result.status, out).not.toBe(0)
    expect(out).toMatch(/Tests\s+5 passed/)
    expect(out).toContain("CS-17 test egress guard: this file attempted")
    for (const host of ["198.51.100.7", "probe.invalid", "203.0.113.9", "198.51.100.8"]) {
      expect(out).toContain(`blocked egress to ${host}`)
    }
  }, 150_000)
})
