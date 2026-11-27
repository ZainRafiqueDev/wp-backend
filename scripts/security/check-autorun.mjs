#!/usr/bin/env node
// Repository integrity check (CS-14). Dependency-free on purpose: CI runs it
// with plain `node` right after checkout and BEFORE `npm ci` / `pnpm install`,
// so nothing from node_modules or a package lifecycle script runs first.
//
// It fails on the auto-run / hidden-payload patterns seen in the 2026-10/11
// malware incident (audit S1-002, S1-003, S1-005, B02-001):
//   vscode-folder-open   .vscode/tasks.json task with runOn: folderOpen
//   vscode-auto-tasks    .vscode/settings.json (or *.code-workspace) enabling
//                        task.allowAutomaticTasks
//   long-line            tracked source/config line over 1,000 chars
//   hidden-code          120+ consecutive spaces/tabs followed by code
//   split-payload        config file with 3+ lines over 300 chars, or 2+
//                        lines padded with 40+ spaces before code (a payload
//                        split to stay under the single-line limits)
//   package-script       package.json script that runs an untracked file, an
//                        extension-less entry (e.g. `node init`), a file
//                        outside src/ or scripts/ BEFORE another command
//                        (e.g. `node ./x.js && next dev`), inline eval, or
//                        pipes a download into a shell
//   dynamic-code         eval( / new Function( / Function( in source dirs
//   unreferenced-font    file under public/fonts/ that nothing references
//
// Usage: node scripts/security/check-autorun.mjs [repoRoot]
// Exit codes: 0 clean, 1 findings, 2 could not run (e.g. not a git repo).
// Self-test: node scripts/security/check-autorun.selftest.mjs

import { execFileSync } from "node:child_process"
import console from "node:console"
import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { pathToFileURL } from "node:url"

export const MAX_LINE_LENGTH = 1000
const HIDDEN_CODE = /[ \t]{120,}\S/
const SPLIT_LONG_LINE = 300
const SPLIT_LONG_LINES_MAX = 2 // 3+ such lines in one config file fail
const SPLIT_PADDED = /\S[ \t]{40,}\S/
const SPLIT_PADDED_MAX = 1 // 2+ such lines in one config file fail
// Files that tooling loads automatically (where the 2026-11 payloads hid).
const CONFIG_FILE = new RegExp([
  String.raw`(^|\/|\.)config\.[cm]?[jt]s$`,
  String.raw`(^|\/)\.[\w.-]*rc(\.\w+)?$`,
  String.raw`(^|\/)tsconfig[\w.-]*\.json$`,
  String.raw`(^|\/)(package|vercel|components)\.json$`,
  String.raw`(^|\/)Dockerfile[\w.-]*$`,
  String.raw`(^|\/)docker-compose[\w.-]*\.ya?ml$`,
  String.raw`(^|\/)\.(vscode|github|husky)\/`,
].join("|"))
// Where an entry file run BEFORE another command may live (package-relative).
const PRE_APP_DIRS = /^(src|scripts)\//

const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
])

const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".avif", ".bmp", ".tiff",
  ".mp4", ".webm", ".mov", ".mp3", ".wav", ".ogg", ".pdf", ".zip", ".gz",
  ".tgz", ".tar", ".7z", ".woff", ".woff2", ".ttf", ".otf", ".eot", ".exe",
  ".dll", ".so", ".dylib", ".node", ".wasm", ".bin", ".docx", ".xlsx",
  ".pptx", ".jar", ".class", ".pyc",
])

// Generated/vendored text that legitimately has very long lines. These are
// still scanned for hidden-code; only the length limit is skipped.
const MINIFIED = /(\.min\.(js|css|mjs)|\.map|\.tsbuildinfo)$/i
const GENERATED_DIR = /(^|\/)coverage\// // istanbul HTML report (vendored prettify.js)
// Prose is not source/config: long paragraphs are normal there.
const PROSE_EXT = new Set([".md", ".mdx", ".txt", ".rst"])

const CODE_EXT = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"])
const SOURCE_DIR = /(^|\/)(src|app|components|lib|pages|hooks)\//

const DYNAMIC_CODE = [
  { re: /(^|[^.\w$])eval\s*\(/, what: "eval(" },
  { re: /\b(window|globalThis|global|self)\s*\.\s*eval\s*\(/, what: "global eval(" },
  { re: /\bnew\s+Function\s*\(/, what: "new Function(" },
  { re: /(^|[^.\w$])Function\s*\(\s*["'`]/, what: "Function(<string>)" },
]

const RUNNERS = new Set([
  "node", "nodejs", "tsx", "ts-node", "ts-node-esm", "bun", "deno", "nodemon",
  "babel-node", "esno", "esr", "vite-node", "jiti",
])
const RUNNER_SUBCOMMANDS = {
  tsx: new Set(["watch"]),
  bun: new Set(["run"]),
  deno: new Set(["run"]),
}
const VALUE_FLAGS = new Set([
  "-r", "--require", "--import", "--loader", "--experimental-loader",
  "--env-file", "--conditions", "-C", "--tsconfig", "--watch-path",
  "--inspect-port", "--title", "--input-type",
])
const EVAL_FLAGS = new Set(["-e", "--eval", "-p", "--print"])
const ENTRY_SUFFIXES = ["", ".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", "/index.js", "/index.mjs", "/index.ts"]

export function listTrackedFiles(root) {
  const out = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  return out.split("\0").filter(Boolean)
}

function isBinary(file, buf) {
  if (BINARY_EXT.has(path.extname(file).toLowerCase())) return true
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

function readText(root, file) {
  const abs = path.join(root, file)
  let buf
  try {
    buf = fs.readFileSync(abs)
  } catch {
    return null // tracked but deleted in the working tree
  }
  if (isBinary(file, buf)) return null
  return buf.toString("utf8")
}

function stripQuotes(t) {
  return t.replace(/^["']|["']$/g, "")
}

// Returns problems found in one package.json script command.
export function inspectScript(command, pkgDir, tracked) {
  const problems = []
  if (/\b(curl|wget)\b[^|]*\|\s*(ba|z|da)?sh\b/.test(command)) {
    problems.push("pipes a download into a shell")
  }
  const segments = command.split(/&&|\|\||;|\||&/).filter((x) => x.trim())
  segments.forEach((segment, segIndex) => {
    const beforeAnother = segIndex < segments.length - 1
    let tokens = segment.trim().split(/\s+/).filter(Boolean).map(stripQuotes)
    // Skip env assignments and harmless wrappers in front of the real command.
    while (tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]) || ["npx", "cross-env", "env", "exec"].includes(tokens[0]))) {
      tokens = tokens.slice(1)
    }
    if (!tokens.length || !RUNNERS.has(tokens[0])) return
    const runner = tokens[0]
    let subcommandAllowed = true
    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i]
      if (EVAL_FLAGS.has(t) || /^--(eval|print)=/.test(t)) {
        problems.push(`\`${runner}\` runs inline code (${t})`)
        break
      }
      if (t.startsWith("-")) {
        if (VALUE_FLAGS.has(t)) i++
        continue
      }
      if (subcommandAllowed && RUNNER_SUBCOMMANDS[runner]?.has(t)) {
        subcommandAllowed = false
        continue
      }
      const rel = path.posix.normalize(path.posix.join(pkgDir, t))
      const local = path.posix.normalize(t)
      if (!ENTRY_SUFFIXES.some((s) => tracked.has(rel + s))) {
        problems.push(`\`${runner} ${t}\` runs a file that is not tracked in git`)
      } else if (!CODE_EXT.has(path.posix.extname(local).toLowerCase())) {
        problems.push(`\`${runner} ${t}\` runs an extension-less / non-JS entry file`)
      } else if (beforeAnother && !PRE_APP_DIRS.test(local)) {
        problems.push(`\`${runner} ${t}\` runs a file outside src/ or scripts/ before another command`)
      }
      break // only the entry point matters; the rest are its arguments
    }
  })
  return problems
}

export function runChecks(root, trackedList = listTrackedFiles(root)) {
  const findings = []
  const add = (rule, file, line, message) => findings.push({ rule, file, line, message })
  const tracked = new Set(trackedList)
  const textCache = new Map()
  const text = (f) => {
    if (!textCache.has(f)) textCache.set(f, readText(root, f))
    return textCache.get(f)
  }

  for (const file of trackedList) {
    const base = path.posix.basename(file)
    const ext = path.posix.extname(file).toLowerCase()

    if (/(^|\/)\.vscode\/tasks\.json$/.test(file)) {
      const t = text(file)
      if (t && /"runOn"\s*:\s*"folderOpen"/.test(t)) add("vscode-folder-open", file, 0, "task runs automatically on folder open (runOn: folderOpen)")
    }
    if (/(^|\/)\.vscode\/settings\.json$/.test(file) || ext === ".code-workspace") {
      const t = text(file)
      if (t && /"task\.allowAutomaticTasks"\s*:\s*("on"|true)/.test(t)) add("vscode-auto-tasks", file, 0, "enables task.allowAutomaticTasks")
    }

    if (base === "package.json") {
      const t = text(file)
      if (t) {
        let pkg
        try {
          pkg = JSON.parse(t)
        } catch {
          add("package-script", file, 0, "package.json is not valid JSON")
        }
        const pkgDir = path.posix.dirname(file) === "." ? "" : path.posix.dirname(file)
        for (const [name, cmd] of Object.entries(pkg?.scripts ?? {})) {
          if (typeof cmd !== "string") continue
          for (const p of inspectScript(cmd, pkgDir, tracked)) add("package-script", file, 0, `script "${name}": ${p}`)
        }
      }
    }

    if (/(^|\/)public\/fonts\//.test(file)) {
      const stem = base.replace(/\.[^.]+$/, "")
      const dir = path.posix.dirname(file) + "/"
      const referenced = trackedList.some((other) => {
        if (other.startsWith(dir) || LOCKFILES.has(path.posix.basename(other))) return false
        const t = text(other)
        return t != null && (t.includes(base) || (stem.length > 3 && t.includes(stem)))
      })
      if (!referenced) add("unreferenced-font", file, 0, "file under public/fonts/ is not referenced by any tracked file")
    }

    if (LOCKFILES.has(base)) continue
    const t = text(file)
    if (t == null) continue
    const lines = t.split(/\r?\n/)
    const scanDynamic = CODE_EXT.has(ext) && SOURCE_DIR.test(file)
    const checkLength = !MINIFIED.test(file) && !GENERATED_DIR.test(file) && !PROSE_EXT.has(ext)
    if (CONFIG_FILE.test(file)) {
      const longCount = lines.filter((l) => l.length > SPLIT_LONG_LINE).length
      const paddedCount = lines.filter((l) => SPLIT_PADDED.test(l)).length
      if (longCount > SPLIT_LONG_LINES_MAX) add("split-payload", file, 0, `${longCount} lines over ${SPLIT_LONG_LINE} chars in a config file`)
      else if (paddedCount > SPLIT_PADDED_MAX) add("split-payload", file, 0, `${paddedCount} lines padded with 40+ spaces before code in a config file`)
    }
    lines.forEach((line, i) => {
      if (checkLength && line.length > MAX_LINE_LENGTH) add("long-line", file, i + 1, `line is ${line.length} chars (max ${MAX_LINE_LENGTH})`)
      else if (HIDDEN_CODE.test(line)) add("hidden-code", file, i + 1, "120+ consecutive spaces followed by code")
      if (scanDynamic) {
        const trimmed = line.trim()
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) return
        const hit = DYNAMIC_CODE.find(({ re }) => re.test(line))
        if (hit) add("dynamic-code", file, i + 1, `${hit.what} in source`)
      }
    })
  }
  return findings
}

function main() {
  const root = path.resolve(process.argv[2] ?? process.cwd())
  let findings
  try {
    findings = runChecks(root)
  } catch (err) {
    console.error(`check-autorun: could not run in ${root}: ${err.message}`)
    process.exit(2)
  }
  if (findings.length === 0) {
    console.log(`check-autorun: OK (${root})`)
    return
  }
  for (const f of findings) console.error(`[${f.rule}] ${f.file}${f.line ? `:${f.line}` : ""} - ${f.message}`)
  console.error(`check-autorun: ${findings.length} finding(s). See docs/CI_CD_SECURITY.md.`)
  process.exit(1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main()
