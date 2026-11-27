// Integer micro-USD (1 USD = 1_000_000 micro-USD) as the authoritative unit
// for the durable reservation ledger (reservations table) and the
// platform-wide budget ceiling — see tokenallocation.md §5. Postgres
// numeric(12,6)/JS float USD stays in use everywhere else (chatbot_usage,
// the existing Redis counters) for backward compatibility with dashboards
// and tests that already read that shape; only the new reservation/ceiling
// arithmetic needs to be float-rounding-free, so only it moves to bigint.

export function toMicroUsd(usd: number): bigint {
  return BigInt(Math.round(usd * 1_000_000))
}

export function fromMicroUsd(microUsd: bigint | number): number {
  return Number(microUsd) / 1_000_000
}
