// Test harness opt-in (CS-15 / B09-017): fixtures that call pool.query with
// no tenant context run as system scope. Production has no such default —
// see allowImplicitSystemContextForTests in src/lib/tenantContext.ts, which
// reads this flag and only honours it under NODE_ENV=test. Set directly on
// globalThis (no import) so src/env.ts is not evaluated before a test file
// adjusts process.env. Tests that pin the fail-closed default turn it off.
;(globalThis as Record<string, unknown>).__cm360ImplicitSystemContextForTests = true
