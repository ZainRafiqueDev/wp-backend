export type RankedSource = {
  sourceId: string
}

export function recallAtK(relevant: string[], retrieved: RankedSource[], k: number): number {
  if (relevant.length === 0) return retrieved.length === 0 ? 1 : 0
  const top = new Set(retrieved.slice(0, k).map((row) => row.sourceId))
  const hits = relevant.filter((id) => top.has(id)).length
  return hits / relevant.length
}

export function precisionAtK(relevant: string[], retrieved: RankedSource[], k: number): number {
  const top = retrieved.slice(0, k)
  if (top.length === 0) return relevant.length === 0 ? 1 : 0
  const wanted = new Set(relevant)
  const hits = top.filter((row) => wanted.has(row.sourceId)).length
  return hits / top.length
}

export function reciprocalRank(relevant: string[], retrieved: RankedSource[]): number {
  if (relevant.length === 0) return retrieved.length === 0 ? 1 : 0
  const wanted = new Set(relevant)
  const index = retrieved.findIndex((row) => wanted.has(row.sourceId))
  return index === -1 ? 0 : 1 / (index + 1)
}

export function ndcgAtK(relevant: string[], retrieved: RankedSource[], k: number): number {
  if (relevant.length === 0) return retrieved.length === 0 ? 1 : 0
  const wanted = new Set(relevant)
  const dcg = retrieved.slice(0, k).reduce((sum, row, index) => {
    const gain = wanted.has(row.sourceId) ? 1 : 0
    return sum + gain / Math.log2(index + 2)
  }, 0)
  const idealCount = Math.min(relevant.length, k)
  const idcg = Array.from({ length: idealCount }, (_, index) => 1 / Math.log2(index + 2)).reduce((a, b) => a + b, 0)
  return idcg === 0 ? 0 : dcg / idcg
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]
}

export function citationCoverage(relevant: string[], retrieved: RankedSource[]): number {
  if (relevant.length === 0) return 1
  const got = new Set(retrieved.map((row) => row.sourceId))
  return relevant.some((id) => got.has(id)) ? 1 : 0
}
