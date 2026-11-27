import { randomUUID } from "node:crypto"

import { describe, expect, it } from "vitest"

import { pool } from "../../src/lib/db.js"
import { runWithTenantContext, runWithSystemContext } from "../../src/lib/tenantContext.js"
import { seedOwnedChatbot } from "../helpers/seedTenant.js"

function db() {
  if (!pool) throw new Error("pool required")
  return pool
}

async function insertChunk(chatbotId: string, content: string) {
  const documentId = randomUUID()
  await db().query(
    `insert into chatbot_documents (id, chatbot_id, file_name, file_type, file_size, status)
     values ($1, $2, 'rls.txt', 'txt', 12, 'ready')`,
    [documentId, chatbotId],
  )
  await db().query(
    `insert into chatbot_document_chunks (document_id, chatbot_id, content)
     values ($1, $2, $3)`,
    [documentId, chatbotId, content],
  )
}

describe("WP-3.1 Postgres RLS", () => {
  it("returns 0 rows when tenant context is empty", async () => {
    if (!pool) throw new Error("pool required")
    const tenant = await seedOwnedChatbot("rls-empty")
    await insertChunk(tenant.chatbotId, "secret for empty-context probe")

    const empty = await runWithTenantContext({}, async () => {
      const users = await db().query("select id from users")
      const bots = await db().query("select id from chatbots")
      const chunks = await db().query("select id from chatbot_document_chunks")
      return { users: users.rowCount, bots: bots.rowCount, chunks: chunks.rowCount }
    })

    expect(empty.users).toBe(0)
    expect(empty.bots).toBe(0)
    expect(empty.chunks).toBe(0)
  })

  it("returns 0 rows for the wrong tenant even when SQL omits the chatbot_id filter", async () => {
    if (!pool) throw new Error("pool required")
    const a = await seedOwnedChatbot("rls-tenant-a")
    const b = await seedOwnedChatbot("rls-tenant-b")
    await insertChunk(a.chatbotId, "tenant A only")
    await insertChunk(b.chatbotId, "tenant B only")

    const leaked = await runWithTenantContext({ scope: "worker", chatbotId: b.chatbotId }, async () => {
      const { rows } = await db().query<{ content: string }>("select content from chatbot_document_chunks")
      return rows.map((row) => row.content)
    })

    expect(leaked).toContain("tenant B only")
    expect(leaked).not.toContain("tenant A only")
  })

  it("lets the owning chatbot context read its own rows", async () => {
    if (!pool) throw new Error("pool required")
    const tenant = await seedOwnedChatbot("rls-owner")
    await insertChunk(tenant.chatbotId, "visible to owner")

    const rows = await runWithTenantContext({ scope: "user", userId: tenant.userId, chatbotId: tenant.chatbotId }, async () => {
      const chunks = await db().query<{ content: string }>("select content from chatbot_document_chunks")
      const bots = await db().query<{ id: string }>("select id from chatbots")
      return { contents: chunks.rows.map((row) => row.content), botIds: bots.rows.map((row) => row.id) }
    })

    expect(rows.contents).toEqual(["visible to owner"])
    expect(rows.botIds).toEqual([tenant.chatbotId])
  })

  it("keeps requireOwnedChatbotId as the application check (defense in depth, not a replacement)", async () => {
    if (!pool) throw new Error("pool required")
    const a = await seedOwnedChatbot("rls-app-a")
    const b = await seedOwnedChatbot("rls-app-b")
    const { requireOwnedChatbotId } = await import("../../src/lib/chatbotOwnership.js")

    await expect(
      runWithTenantContext({ scope: "user", userId: a.userId }, () => requireOwnedChatbotId(a.userId, b.chatbotId)),
    ).rejects.toMatchObject({ status: 404 })

    const owned = await runWithTenantContext({ scope: "user", userId: a.userId }, () =>
      requireOwnedChatbotId(a.userId, a.chatbotId),
    )
    expect(owned).toBe(a.chatbotId)
  })

  it("applies SET LOCAL on pool.connect() without recursing", async () => {
    if (!pool) throw new Error("pool required")
    const tenant = await seedOwnedChatbot("rls-connect")
    await runWithTenantContext({ scope: "worker", chatbotId: tenant.chatbotId }, async () => {
      const client = await db().connect()
      try {
        const { rows } = await client.query<{ chatbot: string }>("select current_setting('app.chatbot_id', true) as chatbot")
        expect(rows[0].chatbot).toBe(tenant.chatbotId)
        const nested = await db().connect()
        try {
          const again = await nested.query<{ chatbot: string }>("select current_setting('app.chatbot_id', true) as chatbot")
          expect(again.rows[0].chatbot).toBe(tenant.chatbotId)
        } finally {
          nested.release()
        }
      } finally {
        client.release()
      }
    })
  })

  it("allows a notification insert when user_id is bound after an auth-scoped lookup", async () => {
    if (!pool) throw new Error("pool required")
    const tenant = await seedOwnedChatbot("rls-notify")
    const inserted = await runWithTenantContext({ scope: "auth", userEmail: "auth-notify@example.com" }, async () => {
      const { createNotification } = await import("../../src/services/notification.service.js")
      return createNotification({
        userId: tenant.userId,
        type: "email_verification",
        title: "rls notify",
        body: "otp path",
      })
    })
    expect(inserted?.title).toBe("rls notify")
  })

  it("isolates concurrent tenants on the shared pool", async () => {
    if (!pool) throw new Error("pool required")
    const a = await seedOwnedChatbot("rls-conc-a")
    const b = await seedOwnedChatbot("rls-conc-b")
    await insertChunk(a.chatbotId, "concurrent A")
    await insertChunk(b.chatbotId, "concurrent B")

    const [fromA, fromB] = await Promise.all([
      runWithTenantContext({ scope: "worker", chatbotId: a.chatbotId }, async () => {
        const { rows } = await db().query<{ content: string }>("select content from chatbot_document_chunks")
        return rows.map((row) => row.content)
      }),
      runWithTenantContext({ scope: "worker", chatbotId: b.chatbotId }, async () => {
        const { rows } = await db().query<{ content: string }>("select content from chatbot_document_chunks")
        return rows.map((row) => row.content)
      }),
    ])

    expect(fromA).toContain("concurrent A")
    expect(fromA).not.toContain("concurrent B")
    expect(fromB).toContain("concurrent B")
    expect(fromB).not.toContain("concurrent A")
  })

  // Phase 2 (2026-10-27): resolveTenantContext's setTenantContext call sets
  // a GUC via set_config(..., true) — transaction-local (SET LOCAL),
  // applied fresh by db.ts's query wrapper inside a BEGIN/COMMIT around
  // every pool.query() call, and gone the instant that transaction ends and
  // the connection is released back to the pool. This proves it end to end
  // on the real shared pool: a workspace member's request and a *different*
  // tenant's owner request, running concurrently (so the pool is free to
  // hand them the same underlying connection back-to-back), each see only
  // their own data — never the other's, and never the member's resolved
  // tenant leaking into the unrelated owner's session or vice versa.
  it("a member's resolved tenant context never leaks to a different, concurrent tenant on the shared pool", async () => {
    if (!pool) throw new Error("pool required")
    const { resolveTenantContext } = await import("../../src/lib/tenancy.js")

    const owner = await seedOwnedChatbot("rls-member-owner")
    const other = await seedOwnedChatbot("rls-member-other")

    const member = await pool.query<{ id: string }>(
      `insert into users (email, password_hash, name, email_verified) values ($1, 'x', 'member', true) returning id`,
      [`rls-member-${randomUUID()}@example.test`],
    )
    const memberUserId = member.rows[0].id
    await pool.query(
      `insert into workspace_members (owner_user_id, member_user_id, role) values ($1, $2, 'viewer')`,
      [owner.userId, memberUserId],
    )

    // chatbots_isolation's policy matches on user_id directly (not just
    // chatbot_id), so this table is the right one to pin down userId-GUC
    // resolution specifically, independent of chatbotId ever being set.
    // Hammer it, not just run it once — repeated concurrent rounds make a
    // same-connection reuse far more likely to actually occur within the
    // run, not just possible in theory.
    for (let round = 0; round < 5; round++) {
      const [asMember, asOther] = await Promise.all([
        runWithTenantContext({}, async () => {
          const { tenantUserId } = await resolveTenantContext(memberUserId, "viewer")
          expect(tenantUserId).toBe(owner.userId)
          const { rows } = await db().query<{ id: string }>("select id from chatbots")
          return rows.map((row) => row.id)
        }),
        runWithTenantContext({}, async () => {
          const { tenantUserId } = await resolveTenantContext(other.userId, "viewer")
          expect(tenantUserId).toBe(other.userId)
          const { rows } = await db().query<{ id: string }>("select id from chatbots")
          return rows.map((row) => row.id)
        }),
      ])

      expect(asMember).toContain(owner.chatbotId)
      expect(asMember).not.toContain(other.chatbotId)
      expect(asOther).toContain(other.chatbotId)
      expect(asOther).not.toContain(owner.chatbotId)
    }
  })

  it("SET LOCAL never leaks as a session-level setting on a connection returned to the pool", async () => {
    if (!pool) throw new Error("pool required")
    const tenant = await seedOwnedChatbot("rls-no-session-leak")

    // pool.connect() is itself wrapped (checkoutTenantClient) — every
    // checkout re-applies the CURRENT ALS context's GUCs itself, which is
    // the actual safety mechanism this test is pinning down: even a brand
    // new checkout, with no tenant context active (outside any
    // runWithTenantContext), must never inherit the PREVIOUS caller's
    // tenant. db.ts never exposes a truly bare pg client, by design — this
    // checkout-time reset is what stands in for "never session-level."
    await runWithTenantContext({ scope: "user", userId: tenant.userId }, async () => {
      await db().query("select 1")
    })

    const client = await db().connect()
    try {
      const { rows } = await client.query<{ user_id: string }>("select current_setting('app.user_id', true) as user_id")
      expect(rows[0].user_id || "").not.toBe(tenant.userId)
    } finally {
      client.release()
    }
  })
})

describe("WP-4.1 five negative isolation tests", () => {
  it("Test 1: cross-tenant document access returns none of tenant A's chunks", async () => {
    if (!pool) throw new Error("pool required")
    const a = await seedOwnedChatbot("p41-doc-a")
    const b = await seedOwnedChatbot("p41-doc-b")
    await insertChunk(a.chatbotId, "tenant A product X secret")
    await insertChunk(b.chatbotId, "tenant B public copy")

    const fromB = await runWithTenantContext({ scope: "worker", chatbotId: b.chatbotId }, async () => {
      const { rows } = await db().query<{ content: string }>("select content from chatbot_document_chunks")
      return rows.map((row) => row.content)
    })
    expect(fromB).toContain("tenant B public copy")
    expect(fromB).not.toContain("tenant A product X secret")
  })

  it("Test 2: cross-tenant conversation access does not reveal tenant A's conversation", async () => {
    if (!pool) throw new Error("pool required")
    const a = await seedOwnedChatbot("p41-conv-a")
    const b = await seedOwnedChatbot("p41-conv-b")
    const inserted = await runWithTenantContext({ scope: "worker", chatbotId: a.chatbotId }, async () => {
      const { rows } = await db().query<{ id: string }>(
        `insert into conversations (chatbot_id, session_id) values ($1, $2) returning id`,
        [a.chatbotId, `sess-${a.chatbotId}`],
      )
      return rows[0].id
    })

    const leaked = await runWithTenantContext({ scope: "worker", chatbotId: b.chatbotId }, async () => {
      const { rows } = await db().query<{ id: string }>(`select id from conversations where id = $1`, [inserted])
      return rows
    })
    expect(leaked).toHaveLength(0)
  })

  it("Test 3: tenant A credit rows are invisible and unchanged under tenant B's session", async () => {
    if (!pool) throw new Error("pool required")
    const a = await seedOwnedChatbot("p41-cred-a")
    const b = await seedOwnedChatbot("p41-cred-b")
    await runWithSystemContext(async () => {
      await db().query(
        `insert into chatbot_model_credits (chatbot_id, model, billing_period, credited_usd, stripe_checkout_session_id)
         values ($1, 'openai', '2099-01', 5.00, $2)`,
        [a.chatbotId, `p41-sess-${a.chatbotId}`],
      )
    })

    const fromB = await runWithTenantContext({ scope: "worker", chatbotId: b.chatbotId }, async () => {
      const { rows } = await db().query<{ credited_usd: string }>(
        `select credited_usd from chatbot_model_credits where chatbot_id = $1`,
        [a.chatbotId],
      )
      return rows
    })
    expect(fromB).toHaveLength(0)

    const stillA = await runWithTenantContext({ scope: "worker", chatbotId: a.chatbotId }, async () => {
      const { rows } = await db().query<{ credited_usd: string }>(
        `select credited_usd from chatbot_model_credits where chatbot_id = $1`,
        [a.chatbotId],
      )
      return Number(rows[0]?.credited_usd ?? 0)
    })
    expect(stillA).toBe(5)
  })

  it("Test 4: cross-tenant vector search returns zero of tenant A's chunks for product X", async () => {
    if (!pool) throw new Error("pool required")
    const a = await seedOwnedChatbot("p41-vec-a")
    const b = await seedOwnedChatbot("p41-vec-b")
    await insertChunk(a.chatbotId, "product X unique retrieval token")

    const fromB = await runWithTenantContext({ scope: "worker", chatbotId: b.chatbotId }, async () => {
      const { rows } = await db().query<{ n: string }>(
        `select count(*)::text as n from chatbot_document_chunks where content ilike '%product X unique retrieval token%'`,
      )
      return Number(rows[0]?.n ?? 0)
    })
    expect(fromB).toBe(0)
  })

  it("Test 5: SET LOCAL app.chatbot_id to another tenant only exposes that tenant's rows", async () => {
    if (!pool) throw new Error("pool required")
    const a = await seedOwnedChatbot("p41-rls-a")
    const b = await seedOwnedChatbot("p41-rls-b")
    await insertChunk(a.chatbotId, "only A")
    await insertChunk(b.chatbotId, "only B")

    const switched = await runWithTenantContext({ scope: "worker", chatbotId: a.chatbotId }, async () => {
      return runWithTenantContext({ scope: "worker", chatbotId: b.chatbotId }, async () => {
        const { rows } = await db().query<{ content: string }>("select content from chatbot_document_chunks")
        return rows.map((row) => row.content)
      })
    })
    expect(switched).toContain("only B")
    expect(switched).not.toContain("only A")
  })
})

// 2026-09-29 production-hardening audit finding (High): db/rls.sql's
// `user_tables` array (notifications, refresh_tokens, subscriptions,
// embedding_usage_daily) is gated by user_id alone, no chatbot_id fallback —
// the exact shape of bug already found and fixed twice this session
// (billing entitlement under "public" scope, Bookly admin-chat missing
// context). None of the tests above exercise these four tables at all.
// Each case below proves two things: (1) a caller with the WRONG user_id in
// context — or, worse, "public" scope with no user_id set at all, matching
// the real incident shape — gets 0 rows, not an error and not someone
// else's data; (2) runWithSystemContext (the documented escape hatch for a
// legitimate cross-scope read) still sees the real row, proving the data
// itself is intact and this is a context-binding gap, not data loss.
describe("High finding: user_tables RLS — public-scope caller must never silently see another tenant's row", () => {
  it("notifications: invisible under the wrong user, invisible under public/no-user scope, visible via system context", async () => {
    if (!pool) throw new Error("pool required")
    const a = await seedOwnedChatbot("rls-ut-notif-a")
    const b = await seedOwnedChatbot("rls-ut-notif-b")

    const notificationId = await runWithTenantContext({ scope: "user", userId: a.userId }, async () => {
      const { rows } = await db().query<{ id: string }>(
        `insert into notifications (user_id, type, title, body) values ($1, 'system', 'rls probe', 'body') returning id`,
        [a.userId],
      )
      return rows[0].id
    })

    const underWrongUser = await runWithTenantContext({ scope: "user", userId: b.userId }, () =>
      db().query("select id from notifications where id = $1", [notificationId]),
    )
    expect(underWrongUser.rowCount).toBe(0)

    // The real incident shape: "public" scope (a chatbotId, no userId at all).
    const underPublicScope = await runWithTenantContext({ scope: "public", chatbotId: a.chatbotId }, () =>
      db().query("select id from notifications where id = $1", [notificationId]),
    )
    expect(underPublicScope.rowCount).toBe(0)

    const underSystemContext = await runWithSystemContext(() =>
      db().query("select id from notifications where id = $1", [notificationId]),
    )
    expect(underSystemContext.rowCount).toBe(1)
  })

  it("subscriptions: invisible under the wrong user, invisible under public/no-user scope, visible via system context", async () => {
    if (!pool) throw new Error("pool required")
    const a = await seedOwnedChatbot("rls-ut-sub-a")
    const b = await seedOwnedChatbot("rls-ut-sub-b")

    await runWithSystemContext(() =>
      db().query(
        `insert into subscriptions (user_id, stripe_customer_id, plan, status) values ($1, $2, 'crawl_plus', 'active')
         on conflict (user_id) do update set plan = excluded.plan, status = excluded.status`,
        [a.userId, `cus_rls_probe_${a.userId}`],
      ),
    )

    const underWrongUser = await runWithTenantContext({ scope: "user", userId: b.userId }, () =>
      db().query("select plan from subscriptions where user_id = $1", [a.userId]),
    )
    expect(underWrongUser.rowCount).toBe(0)

    const underPublicScope = await runWithTenantContext({ scope: "public", chatbotId: a.chatbotId }, () =>
      db().query("select plan from subscriptions where user_id = $1", [a.userId]),
    )
    expect(underPublicScope.rowCount).toBe(0)

    const underSystemContext = await runWithSystemContext(() =>
      db().query<{ plan: string }>("select plan from subscriptions where user_id = $1", [a.userId]),
    )
    expect(underSystemContext.rows[0]?.plan).toBe("crawl_plus")
  })

  it("embedding_usage_daily: invisible under the wrong user, invisible under public/no-user scope, visible via system context", async () => {
    if (!pool) throw new Error("pool required")
    const a = await seedOwnedChatbot("rls-ut-embed-a")
    const b = await seedOwnedChatbot("rls-ut-embed-b")

    await runWithSystemContext(() =>
      db().query(
        `insert into embedding_usage_daily (user_id, usage_day, call_count, token_count, cost_usd)
         values ($1, current_date, 1, 100, 0.001)`,
        [a.userId],
      ),
    )

    const underWrongUser = await runWithTenantContext({ scope: "user", userId: b.userId }, () =>
      db().query("select call_count from embedding_usage_daily where user_id = $1", [a.userId]),
    )
    expect(underWrongUser.rowCount).toBe(0)

    const underPublicScope = await runWithTenantContext({ scope: "public", chatbotId: a.chatbotId }, () =>
      db().query("select call_count from embedding_usage_daily where user_id = $1", [a.userId]),
    )
    expect(underPublicScope.rowCount).toBe(0)

    const underSystemContext = await runWithSystemContext(() =>
      db().query<{ call_count: number }>("select call_count from embedding_usage_daily where user_id = $1", [a.userId]),
    )
    expect(underSystemContext.rows[0]?.call_count).toBe(1)
  })

  // refresh_tokens has a SECOND, deliberate policy (refresh_tokens_lookup)
  // permitting an auth-scoped lookup by token_hash before user_id is known —
  // not a gap, the pre-authentication rotate/logout flow needs exactly this.
  // Still worth proving the user_id-based isolation policy holds for every
  // OTHER scope, since Postgres OR's multiple permissive policies together.
  it("refresh_tokens: invisible under the wrong user or public scope; the separate auth+lookup_hash policy is the only sanctioned exception", async () => {
    if (!pool) throw new Error("pool required")
    const a = await seedOwnedChatbot("rls-ut-refresh-a")
    const b = await seedOwnedChatbot("rls-ut-refresh-b")
    const tokenHash = `rls-probe-hash-${a.userId}`

    await runWithTenantContext({ scope: "user", userId: a.userId }, () =>
      db().query(
        `insert into refresh_tokens (user_id, token_hash, expires_at) values ($1, $2, now() + interval '1 day')`,
        [a.userId, tokenHash],
      ),
    )

    const underWrongUser = await runWithTenantContext({ scope: "user", userId: b.userId }, () =>
      db().query("select id from refresh_tokens where token_hash = $1", [tokenHash]),
    )
    expect(underWrongUser.rowCount).toBe(0)

    const underPublicScope = await runWithTenantContext({ scope: "public", chatbotId: a.chatbotId }, () =>
      db().query("select id from refresh_tokens where token_hash = $1", [tokenHash]),
    )
    expect(underPublicScope.rowCount).toBe(0)

    // The one intentional exception: auth scope + the matching lookup_hash.
    const underAuthLookup = await runWithTenantContext({ scope: "auth", lookupHash: tokenHash }, () =>
      db().query("select id from refresh_tokens where token_hash = $1", [tokenHash]),
    )
    expect(underAuthLookup.rowCount).toBe(1)

    // But auth scope with a DIFFERENT lookup_hash still sees nothing —
    // the exception is bound to the specific hash, not the whole scope.
    const underAuthWrongLookup = await runWithTenantContext({ scope: "auth", lookupHash: "not-the-real-hash" }, () =>
      db().query("select id from refresh_tokens where token_hash = $1", [tokenHash]),
    )
    expect(underAuthWrongLookup.rowCount).toBe(0)
  })
})
