import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

// CS-13 (B06-018): orderState.service.ts is the single writer of
// commerce_orders.status. Any other file that sets the column bypasses the
// transition table and its guards.
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    return statSync(full).isDirectory() ? sourceFiles(full) : full.endsWith(".ts") ? [full] : []
  })
}

describe("commerce_orders status single writer", () => {
  it("no file except orderState.service.ts updates commerce_orders.status", () => {
    const root = join(process.cwd(), "src")
    const offenders = sourceFiles(root).filter((file) => {
      if (file.endsWith(join("services", "orderState.service.ts"))) return false
      const text = readFileSync(file, "utf8")
      // Look only at the SET list of each `update commerce_orders` statement.
      const setLists = [...text.matchAll(/update\s+commerce_orders\s+set\b([\s\S]*?)(?:\bwhere\b|\breturning\b|`)/gi)].map((m) => m[1])
      return setLists.some((list) => /(?<![a-z_])status\s*=/i.test(list))
    })
    expect(offenders.map((f) => relative(root, f))).toEqual([])
  })
})
