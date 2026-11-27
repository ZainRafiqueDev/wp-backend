/**
 * WP-4.2 load probe. Not part of CI — it needs a running API and a real
 * chatbot. Example:
 *
 *   npx tsx scripts/loadTestChat.ts --url http://localhost:4000 --n 50
 *
 * 500 concurrent is too expensive against live providers; this script
 * hits GET /health so it measures pool/connection behavior, not model spend.
 */
const url = process.argv.includes("--url")
  ? process.argv[process.argv.indexOf("--url") + 1]
  : "http://localhost:4000"
const n = process.argv.includes("--n") ? Number(process.argv[process.argv.indexOf("--n") + 1]) : 50

async function main() {
  const started = Date.now()
  const results = await Promise.allSettled(
    Array.from({ length: n }, () => fetch(`${url}/health`).then((res) => res.status)),
  )
  const ok = results.filter((r) => r.status === "fulfilled" && r.value < 500).length
  const failed = n - ok
  console.log(`loadTestChat n=${n} ok=${ok} failed=${failed} elapsedMs=${Date.now() - started}`)
  if (failed > 0) process.exit(1)
}

void main()
