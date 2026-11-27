import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import { Client } from "pg"

// CS-17 (B08-013, B08-023). The live Bookly tests run a separate Node app.
// They used to resolve it from a relative path outside this repo (which
// pointed at whatever happened to sit there), hand it the developer's full
// process.env (every provider/Stripe secret), and leave the child running if
// the health check failed. Now they:
//   - never run unless RUN_LIVE_BOOKLY_TESTS=1 (otherwise the suites are
//     reported as skipped, with the reason printed);
//   - require BOOKLY_REPO_DIR (absolute path to a git checkout) and
//     BOOKLY_REPO_SHA (the reviewed commit); HEAD must match it;
//   - pass the child an explicit env allowlist;
//   - kill and await the child when startup fails, and await exit on stop.

export const LIVE_BOOKLY_FLAG = "RUN_LIVE_BOOKLY_TESTS"

export type LiveBooklyGate =
  | { enabled: true; dir: string; dbUrl: string }
  | { enabled: false; reason: string }

export class LiveBooklyConfigError extends Error {
  constructor(message: string) {
    super(`live Bookly tests are enabled (${LIVE_BOOKLY_FLAG}=1) but misconfigured: ${message}`)
    this.name = "LiveBooklyConfigError"
  }
}

/**
 * Decides whether live Bookly tests may run. Disabled → a reason to report.
 * Enabled but misconfigured → throws, so the run fails instead of skipping.
 */
export function liveBooklyGate(
  env: NodeJS.ProcessEnv = process.env,
  readHead: (dir: string) => string = gitHead,
): LiveBooklyGate {
  if (env[LIVE_BOOKLY_FLAG] !== "1") {
    return { enabled: false, reason: `set ${LIVE_BOOKLY_FLAG}=1, BOOKLY_REPO_DIR and BOOKLY_REPO_SHA to run live Bookly tests` }
  }
  const dir = env.BOOKLY_REPO_DIR?.trim()
  if (!dir || !path.isAbsolute(dir)) throw new LiveBooklyConfigError("BOOKLY_REPO_DIR must be an absolute path")
  if (!existsSync(path.join(dir, "src", "server.js"))) throw new LiveBooklyConfigError(`no src/server.js under BOOKLY_REPO_DIR (${dir})`)
  const pinned = env.BOOKLY_REPO_SHA?.trim().toLowerCase()
  if (!pinned || !/^[0-9a-f]{40}$/.test(pinned)) throw new LiveBooklyConfigError("BOOKLY_REPO_SHA must be a full 40-character commit SHA")
  let head: string
  try {
    head = readHead(dir).trim().toLowerCase()
  } catch (err) {
    throw new LiveBooklyConfigError(`BOOKLY_REPO_DIR is not a git checkout (${err instanceof Error ? err.message : String(err)})`)
  }
  if (head !== pinned) throw new LiveBooklyConfigError(`BOOKLY_REPO_DIR HEAD ${head} does not match BOOKLY_REPO_SHA ${pinned}`)
  const dbUrl = env.BOOKLY_TEST_DATABASE_URL || "postgres://postgres:postgres@localhost:5455/helebooker_test"
  return { enabled: true, dir, dbUrl }
}

function gitHead(dir: string): string {
  return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
}

// Only what Node itself needs to start on Windows/POSIX. No secrets.
const PASSTHROUGH_ENV = ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE"]

export function booklyChildEnv(extra: Record<string, string>, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const name of PASSTHROUGH_ENV) {
    if (env[name] !== undefined) out[name] = env[name]
  }
  return { ...out, ...extra }
}

export interface LiveBookly {
  baseUrl: string
  db: Client
  process: ChildProcess
}

async function waitForHealth(url: string, timeoutMs: number, proc: ChildProcess): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`Bookly test server exited early with code ${proc.exitCode}`)
    try {
      const res = await fetch(`${url}/health`)
      if (res.ok) return
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Bookly test server at ${url} did not become healthy in time`)
}

async function killAndWait(proc: ChildProcess | undefined, timeoutMs = 5000): Promise<void> {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return
  const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()))
  proc.kill()
  const timer = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref())
  await Promise.race([exited, timer])
  if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL")
}

export async function startLiveBookly(port: number, label: string, gate: LiveBooklyGate = liveBooklyGate()): Promise<LiveBookly> {
  if (!gate.enabled) throw new Error(`refusing to start live Bookly: ${gate.reason}`)
  const { dir, dbUrl } = gate

  execFileSync(process.execPath, ["src/db/migrate.js"], {
    cwd: dir,
    env: booklyChildEnv({ DATABASE_URL: dbUrl, NODE_ENV: "test" }),
    stdio: "pipe",
  })

  const db = new Client({ connectionString: dbUrl })
  await db.connect()

  let proc: ChildProcess | undefined
  try {
    proc = spawn(process.execPath, ["src/server.js"], {
      cwd: dir,
      env: booklyChildEnv({ DATABASE_URL: dbUrl, PORT: String(port), JWT_SECRET: "test-jwt-secret", NODE_ENV: "test" }),
      stdio: "pipe",
    })
    proc.on("error", (err) => console.warn(`[${label}] Bookly server process error: ${err.message}`))
    proc.stdout?.on("data", (d) => process.stdout.write(`[${label}:bookly] ${d}`))
    proc.stderr?.on("data", (d) => process.stderr.write(`[${label}:bookly:err] ${d}`))

    const baseUrl = `http://localhost:${port}`
    await waitForHealth(baseUrl, 15_000, proc)
    // Cold-start warm-up: the first real request into a fresh Node process
    // is measurably slower than steady state under a parallel test run.
    await fetch(`${baseUrl}/health`).catch(() => {})
    return { baseUrl, db, process: proc }
  } catch (err) {
    await killAndWait(proc)
    await db.end().catch(() => {})
    throw err
  }
}

export async function stopLiveBookly(live: LiveBookly | undefined): Promise<void> {
  await killAndWait(live?.process)
  await live?.db.end().catch(() => {})
}
