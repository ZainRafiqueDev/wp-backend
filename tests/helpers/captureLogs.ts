import fs from "node:fs"

import { vi } from "vitest"

/**
 * Captures everything the process writes to stdout/stderr — pino's sync
 * SonicBoom destination (fs.writeSync on fd 1), process.stdout/stderr.write
 * and console.* — i.e. the real final log output, after every redaction
 * layer. Works the same against old and new logger code, so a test using it
 * fails on code that leaks and passes on code that does not.
 */
export function captureLogs() {
  const chunks: string[] = []
  const push = (data: unknown) => {
    chunks.push(typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : String(data))
  }

  const realWriteSync = fs.writeSync.bind(fs)
  const spies = [
    vi.spyOn(fs, "writeSync").mockImplementation(((fd: number, data: unknown, ...rest: unknown[]) => {
      if (fd === 1 || fd === 2) {
        push(data)
        return typeof data === "string" ? Buffer.byteLength(data) : (data as Buffer).length
      }
      return (realWriteSync as (...args: unknown[]) => number)(fd, data, ...rest)
    }) as typeof fs.writeSync),
    vi.spyOn(process.stdout, "write").mockImplementation(((data: unknown) => {
      push(data)
      return true
    }) as typeof process.stdout.write),
    vi.spyOn(process.stderr, "write").mockImplementation(((data: unknown) => {
      push(data)
      return true
    }) as typeof process.stderr.write),
    ...(["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : typeof a === "string" ? a : JSON.stringify(a))).join(" "))
      }),
    ),
  ]

  return {
    text: () => chunks.join("\n"),
    lines: () => chunks.join("").split("\n").filter(Boolean),
    restore: () => spies.forEach((spy) => spy.mockRestore()),
  }
}
