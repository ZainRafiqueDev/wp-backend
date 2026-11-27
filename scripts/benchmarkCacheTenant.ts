import "dotenv/config"

import { cacheKey, getCached, setCached } from "../src/lib/cache.js"
import { redis } from "../src/lib/redis.js"

const RUNS = 40

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, index)]
}

async function main() {
  const samples: number[] = []
  for (let i = 0; i < RUNS; i++) {
    const key = cacheKey("bench-cache", "answer", String(i % 5))
    const started = performance.now()
    await setCached(key, { n: i }, 30)
    await getCached(key)
    samples.push(performance.now() - started)
  }
  const sorted = [...samples].sort((a, b) => a - b)
  console.log(
    `WP-1.6 tenant cache set+get n=${RUNS} p50=${percentile(sorted, 50).toFixed(2)}ms p95=${percentile(sorted, 95).toFixed(2)}ms`,
  )
  await redis.quit()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
