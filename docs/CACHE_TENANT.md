# Cache tenant prefix (WP-1.6)

Every Redis value written through `src/lib/cache.ts` is built with `cacheKey(chatbotId, kind, hash)`:

```
tenant:{chatbotId}:v{CACHE_SCHEMA_VERSION}:{kind}:{hash}
```

Example: `tenant:abc:v1:answer:3:9f2c…`

Two version layers:

- **Schema version** (`CACHE_SCHEMA_VERSION`, default `1`) — bump when prompt, retrieval, citations, or grounding format changes. Old keys miss and expire. No Redis flush.
- **Per-chatbot version** (`getChatbotCacheVersion` / `bumpChatbotCacheVersion`) — already part of the hash for answer, pages, relevance, and backend-link keys. Bump after a crawl or live-data write.

`getCached` / `setCached` refuse keys that are not `tenant:{chatbotId}:vN:{kind}`. Old unprefixed keys miss until TTL expires. Do not flush Redis unless a prefix collision is confirmed.

## Answer cache bypass

The **answer** cache is skipped when:

- the question is action/tool relevant (`cache.answer_bypass_tools`)
- the request has live data (`liveData`) or backend live catalog pages

Pages, relevance, and backend-link caches stay. They are still tenant- and schema-prefixed.

## Metrics

- `cache.answer_read`
- `cache.answer_hit`
- `cache.answer_miss`
- `cache.answer_write`
- `cache.answer_bypass_tools`
- `cache.answer_invalidate` (chatbot version bump)

`cache.answer_expired` is not counted. Redis does not surface TTL expiry without keyspace notifications, and those are not enabled for this WP.

Measured local Redis set+get through `cacheKey` (n=40): p50 **1.41ms**, p95 **2.42ms**. Repeat with `npx tsx scripts/benchmarkCacheTenant.ts`.

## Rollback

Revert the key helper or lower `CACHE_SCHEMA_VERSION`. Bump chatbot cache versions (or wait for TTL). No migrations.
