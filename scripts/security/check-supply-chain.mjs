#!/usr/bin/env node
// Supply-chain / lockfile check (CI layer added 2026-11-27). Dependency-free,
// runs with plain `node` BEFORE any install.
//
//   dep-source        a package.json dependency that does not come from the
//                     npm registry (git, github:, http(s) tarball, file:)
//   lock-source       a lockfile entry resolved from anywhere other than
//                     https://registry.npmjs.org/ (or a git/tarball source)
//   lock-integrity    a lockfile entry without a sha512 integrity hash, so a
//                     swapped tarball would not be noticed
//   install-script    a dependency that wants to run an install script and is
//                     not in scripts/security/install-scripts-allowlist.json
//                     (CI installs with --ignore-scripts anyway; this makes a
//                     NEW one visible in review instead of silently skipped)
//   npmrc             a tracked .npmrc/.yarnrc/pnpm-workspace.yaml that points
//                     at another registry or turns install scripts back on
//
// Usage: node scripts/security/check-supply-chain.mjs [repoRoot]
// Exit codes: 0 clean, 1 findings, 2 could not run.

import { execFileSync } from "node:child_process"
import console from "node:console"
import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { pathToFileURL } from "node:url"

const REGISTRY = "https://registry.npmjs.org/"
const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]
const BAD_SPEC = /^(git|git\+[a-z]+|https?|file|link|ssh):|^github:|^gitlab:|^bitbucket:|^[\w.-]+\/[\w.-]+(#.*)?$/i

export function listTrackedFiles(root) {
  const out = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  return out.split("\0").filter(Boolean)
}

function checkSpec(spec) {
  if (typeof spec !== "string") return null
  if (spec.startsWith("npm:")) return checkSpec(spec.replace(/^npm:(@?[^@]+)@?/, ""))
  if (spec.startsWith("workspace:") || spec.startsWith("catalog:")) return null
  return BAD_SPEC.test(spec) ? `"${spec}" is not an npm registry version` : null
}

export function checkPackageJson(text, file, add) {
  let pkg
  try {
    pkg = JSON.parse(text)
  } catch {
    return
  }
  for (const field of DEP_FIELDS) {
    for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
      const p = checkSpec(spec)
      if (p) add("dep-source", file, `${field}.${name}: ${p}`)
    }
  }
  const walk = (obj, trail) => {
    for (const [k, v] of Object.entries(obj ?? {})) {
      if (typeof v === "string") {
        const p = checkSpec(v)
        if (p) add("dep-source", file, `overrides ${[...trail, k].join(" > ")}: ${p}`)
      } else if (v && typeof v === "object") walk(v, [...trail, k])
    }
  }
  walk(pkg.overrides, [])
  walk(pkg.resolutions, [])
  walk(pkg.pnpm?.overrides, [])
}

export function checkNpmLock(text, file, allow, add) {
  let lock
  try {
    lock = JSON.parse(text)
  } catch {
    add("lock-integrity", file, "lockfile is not valid JSON")
    return
  }
  if (!lock.packages) {
    add("lock-integrity", file, `lockfileVersion ${lock.lockfileVersion} has no "packages" map (regenerate with npm 9+)`)
    return
  }
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === "" || entry.link) continue
    if (entry.inBundle) continue // shipped inside its parent's (already hashed) tarball
    if (!key.includes("node_modules/")) continue // workspace package folders
    const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length)
    if (typeof entry.resolved !== "string" || !entry.resolved.startsWith(REGISTRY)) {
      add("lock-source", file, `${key} resolved from ${entry.resolved ?? "(nowhere)"}`)
    }
    if (typeof entry.integrity !== "string" || !entry.integrity.startsWith("sha512-")) {
      add("lock-integrity", file, `${key} has no sha512 integrity hash`)
    }
    if (entry.hasInstallScript && !allow.has(name)) {
      add("install-script", file, `${name} wants to run an install script (not in install-scripts-allowlist.json)`)
    }
  }
}

export function checkPnpmLock(text, file, add) {
  const lines = text.split(/\r?\n/)
  lines.forEach((line, i) => {
    const at = `line ${i + 1}`
    const tarball = /tarball:\s*['"]?([^'",}\s]+)/.exec(line)
    if (tarball && !tarball[1].startsWith(REGISTRY)) add("lock-source", file, `${at}: tarball from ${tarball[1]}`)
    if (/resolution:\s*\{[^}]*\btype:\s*['"]?(git|directory)/.test(line) || /\brepo:\s*['"]?(https?|git|ssh)/.test(line)) {
      add("lock-source", file, `${at}: git/directory resolution`)
    }
    if (/integrity:\s*sha1-/.test(line)) add("lock-integrity", file, `${at}: weak sha1 integrity`)
    if (/resolution:\s*\{/.test(line) && !/integrity:\s*sha512-/.test(line) && !/type:/.test(line)) {
      add("lock-integrity", file, `${at}: resolution without sha512 integrity`)
    }
    if (/^\s*registry:\s*/.test(line) && !line.includes("registry.npmjs.org")) add("lock-source", file, `${at}: ${line.trim()}`)
  })
}

export function checkRc(text, file, allow, add) {
  const lines = text.split(/\r?\n/)
  lines.forEach((line, i) => {
    const t = line.trim()
    if (t.startsWith("#") || t.startsWith("//") || t.startsWith(";")) return
    const reg = /(^|:)registry\s*[=:]\s*['"]?(\S+?)['"]?$/.exec(t) || /^npmRegistryServer:\s*['"]?(\S+?)['"]?$/.exec(t)
    if (reg && !/registry\.npmjs\.org|registry\.yarnpkg\.com/.test(reg[reg.length - 1])) {
      add("npmrc", file, `line ${i + 1}: uses registry ${reg[reg.length - 1]}`)
    }
    if (/^ignore-scripts\s*=\s*false/.test(t) || /^enableScripts:\s*true/.test(t) || /^dangerouslyAllowAllBuilds:\s*true/.test(t)) {
      add("npmrc", file, `line ${i + 1}: turns dependency install scripts on (${t})`)
    }
  })
  // pnpm-workspace.yaml allowBuilds / onlyBuiltDependencies: anything allowed to
  // build must also be in the install-script allowlist.
  if (path.posix.basename(file) === "pnpm-workspace.yaml") {
    let section = null
    for (const line of lines) {
      const head = /^(\w[\w-]*):/.exec(line)
      if (head) section = head[1]
      if (section === "allowBuilds") {
        const m = /^\s+['"]?([@\w./-]+)['"]?:\s*true/.exec(line)
        if (m && !allow.has(m[1])) add("install-script", file, `allowBuilds lets ${m[1]} run its install script (not in install-scripts-allowlist.json)`)
      }
      if (section === "onlyBuiltDependencies") {
        const m = /^\s+-\s*['"]?([@\w./-]+)['"]?/.exec(line)
        if (m && !allow.has(m[1])) add("install-script", file, `onlyBuiltDependencies lets ${m[1]} run its install script (not in install-scripts-allowlist.json)`)
      }
    }
  }
}

function loadAllow(root) {
  const file = path.join(root, "scripts/security/install-scripts-allowlist.json")
  if (!fs.existsSync(file)) return new Set()
  const data = JSON.parse(fs.readFileSync(file, "utf8"))
  return new Set(Object.keys(data.packages ?? {}))
}

export function runChecks(root, trackedList = listTrackedFiles(root)) {
  const findings = []
  const add = (rule, file, message) => findings.push({ rule, file, message })
  const allow = loadAllow(root)
  for (const file of trackedList) {
    if (file.includes("node_modules/")) continue
    const base = path.posix.basename(file)
    let text
    try {
      text = fs.readFileSync(path.join(root, file), "utf8")
    } catch {
      continue
    }
    if (base === "package.json") checkPackageJson(text, file, add)
    else if (base === "package-lock.json" || base === "npm-shrinkwrap.json") checkNpmLock(text, file, allow, add)
    else if (base === "pnpm-lock.yaml") checkPnpmLock(text, file, add)
    else if ([".npmrc", ".yarnrc", ".yarnrc.yml", "pnpm-workspace.yaml"].includes(base)) checkRc(text, file, allow, add)
    else if (base === "yarn.lock" || base === "bun.lockb") add("lock-source", file, `${base} is not used by this project (npm/pnpm only); remove it`)
  }
  return findings
}

function main() {
  const root = path.resolve(process.argv[2] ?? process.cwd())
  let findings
  try {
    findings = runChecks(root)
  } catch (err) {
    console.error(`check-supply-chain: could not run in ${root}: ${err.message}`)
    process.exit(2)
  }
  if (findings.length === 0) {
    console.log(`check-supply-chain: OK (${root})`)
    return
  }
  for (const f of findings) console.error(`[${f.rule}] ${f.file} - ${f.message}`)
  console.error(`check-supply-chain: ${findings.length} finding(s).`)
  process.exit(1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main()
