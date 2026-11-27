import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

import {
  CHATBOT_SCOPED_ROUTES,
  discoveredChatbotScopedRoutes,
  routeKey,
} from "../helpers/crossTenantRoutePack.js"

const TESTS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

function collectTestFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...collectTestFiles(full))
      continue
    }
    if (entry.endsWith(".ts")) out.push(full)
  }
  return out
}

function testsCorpus(): string {
  return collectTestFiles(TESTS_ROOT).map((file) => readFileSync(file, "utf8")).join("\n")
}

describe("WP-1.7 cross-tenant route pack", () => {
  it("lists every chatbot-scoped route discovered in source", () => {
    const discovered = discoveredChatbotScopedRoutes()
    const catalog = new Set(CHATBOT_SCOPED_ROUTES.map((route) => routeKey(route.method, route.path)))
    const missing = discovered.filter((route) => !catalog.has(routeKey(route.method, route.path)))

    expect(discovered.length).toBeGreaterThan(0)
    expect(missing).toEqual([])
  })

  it("does not keep stale catalog entries that are no longer mounted", () => {
    const discovered = new Set(discoveredChatbotScopedRoutes().map((route) => routeKey(route.method, route.path)))
    const stale = CHATBOT_SCOPED_ROUTES.filter((route) => !discovered.has(routeKey(route.method, route.path)))
    expect(stale).toEqual([])
  })

  it("has a CROSS_TENANT covering marker in tests for every catalog route", () => {
    const corpus = testsCorpus()
    const missing = CHATBOT_SCOPED_ROUTES.filter((route) => !corpus.includes(route.coveringMarker))
    expect(missing.map((route) => route.coveringMarker)).toEqual([])
  })
})
