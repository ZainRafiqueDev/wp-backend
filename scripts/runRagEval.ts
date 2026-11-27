/**
 * WP-3.5 RAG evaluation CLI.
 *
 *   npm run eval:rag                    # run the gate, print a readable report
 *   npm run eval:rag -- --update-baseline
 *   npm run eval:rag -- --max-regression 0.05
 *
 * The scoring harness itself lives in tests/eval/ragEval.test.ts because it
 * needs the deterministic embedding mock — running retrieval against the real
 * embedding provider for 50+ questions on every invocation would cost real
 * quota and make the numbers non-reproducible. So this CLI drives that harness
 * rather than re-implementing it, then reports on the artifact it wrote.
 */
import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import { isAbsolute, join } from "node:path"

import { env } from "../src/env.js"
import type { RagEvalBaseline, RagEvalReport } from "../src/lib/ragEval.js"

const EVAL_SPEC = "tests/eval/ragEval.test.ts"

type Options = {
  updateBaseline: boolean
  maxRegression?: string
}

function parseArgs(argv: string[]): Options {
  const options: Options = { updateBaseline: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--update-baseline") {
      options.updateBaseline = true
    } else if (arg === "--max-regression") {
      options.maxRegression = argv[i + 1]
      i += 1
    } else if (arg.startsWith("--max-regression=")) {
      options.maxRegression = arg.slice("--max-regression=".length)
    } else {
      console.error(`Unknown argument: ${arg}`)
      process.exit(2)
    }
  }
  return options
}

function runVitest(options: Options): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["vitest", "run", EVAL_SPEC], {
      stdio: "inherit",
      // npx resolves to npx.cmd on Windows, which needs a shell to launch.
      shell: process.platform === "win32",
      env: {
        ...process.env,
        // This runner is the canonical invocation: the eval spec runs alone
        // against an otherwise-quiet DB, which is the only condition under
        // which the ranking metrics are reproducible enough to gate on.
        RAG_EVAL_ENFORCE_BASELINE: "true",
        ...(options.updateBaseline ? { RAG_EVAL_UPDATE_BASELINE: "true" } : {}),
        ...(options.maxRegression ? { RAG_EVAL_MAX_REGRESSION: options.maxRegression } : {}),
      },
    })
    child.on("close", (code) => resolve(code ?? 1))
  })
}

async function readJson<T>(path: string): Promise<T | null> {
  const resolved = isAbsolute(path) ? path : join(process.cwd(), path)
  try {
    return JSON.parse(await readFile(resolved, "utf8")) as T
  } catch {
    return null
  }
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function delta(current: number, previous: number | undefined, higherIsBetter = true): string {
  if (previous === undefined) return ""
  const diff = current - previous
  if (Math.abs(diff) < 0.0005) return "  (flat)"
  const better = higherIsBetter ? diff > 0 : diff < 0
  return `  (${diff > 0 ? "+" : ""}${(diff * 100).toFixed(1)}pt ${better ? "better" : "WORSE"})`
}

function printReport(report: RagEvalReport, baseline: RagEvalBaseline | null): void {
  const base = baseline ?? undefined
  console.log("")
  console.log(`RAG eval — ${report.pairCount} labeled pairs, run at ${report.generatedAt}`)
  console.log(`Baseline: ${base ? base.generatedAt : "none recorded yet"}`)
  console.log("")
  console.log("Retrieval")
  console.log(`  Recall@5          ${pct(report.retrieval.recallAt5)}${delta(report.retrieval.recallAt5, base?.retrieval.recallAt5)}`)
  console.log(`  Recall@10         ${pct(report.retrieval.recallAt10)}${delta(report.retrieval.recallAt10, base?.retrieval.recallAt10)}`)
  console.log(`  Precision@5       ${pct(report.retrieval.precisionAt5)}${delta(report.retrieval.precisionAt5, base?.retrieval.precisionAt5)}`)
  console.log(`  MRR               ${report.retrieval.mrr.toFixed(3)}${delta(report.retrieval.mrr, base?.retrieval.mrr)}`)
  console.log(`  nDCG@10           ${report.retrieval.ndcgAt10.toFixed(3)}${delta(report.retrieval.ndcgAt10, base?.retrieval.ndcgAt10)}`)
  console.log(`  Citation coverage ${pct(report.retrieval.citationCoverage)}${delta(report.retrieval.citationCoverage, base?.retrieval.citationCoverage)}`)
  console.log("")
  console.log("Answer quality")
  console.log(`  Grounded rate     ${pct(report.quality.groundedAnswerRate)}${delta(report.quality.groundedAnswerRate, base?.quality.groundedAnswerRate)}`)
  console.log(`  Hallucination     ${pct(report.quality.hallucinationRate)}${delta(report.quality.hallucinationRate, base?.quality.hallucinationRate, false)}`)
  console.log(`  Isolation leaks   ${report.quality.isolationViolations}`)
  console.log("")
  console.log("Latency")
  console.log(`  p50 ${report.latency.p50Ms.toFixed(0)}ms   p95 ${report.latency.p95Ms.toFixed(0)}ms   mean ${report.latency.meanMs.toFixed(0)}ms`)
  console.log("")
  console.log("By question kind")
  for (const kind of report.byKind ?? []) {
    const ranked = kind.rankedPairCount > 0
    const recall = ranked ? pct(kind.retrieval.recallAt5) : "n/a"
    const mrr = ranked ? kind.retrieval.mrr.toFixed(3) : "  n/a"
    console.log(
      `  ${kind.kind.padEnd(10)} n=${String(kind.pairCount).padStart(3)}  recall@5 ${recall.padStart(6)}  mrr ${mrr}  grounded ${pct(kind.groundedAnswerRate).padStart(6)}  leaks ${kind.isolationViolations}`,
    )
  }
  console.log("")
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))

  if (env.ragEvalSkip) {
    console.error("RAG_EVAL_SKIP is set — refusing to run. Unset it to evaluate.")
    process.exit(2)
  }

  // Read the baseline before the run: an --update-baseline pass overwrites it,
  // and the deltas are only interesting against what we were compared to.
  const baselineBefore = await readJson<RagEvalBaseline>(env.ragEvalBaselinePath)
  const exitCode = await runVitest(options)
  const report = await readJson<RagEvalReport>(env.ragEvalArtifactPath)

  if (!report) {
    console.error(`No eval artifact at ${env.ragEvalArtifactPath} — the run did not complete.`)
    process.exit(exitCode || 1)
  }

  printReport(report, baselineBefore)

  if (exitCode !== 0) {
    console.error("RAG eval gate FAILED — see the threshold/regression failures above.")
  } else if (options.updateBaseline) {
    console.log(`Baseline updated at ${env.ragEvalBaselinePath}.`)
  }

  process.exit(exitCode)
}

void main()
