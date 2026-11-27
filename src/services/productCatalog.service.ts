
import { pool } from "../lib/db.js"
import { recordRetrievalObservation, withHnswSearch } from "../lib/pgvectorHnsw.js"
import { AppError } from "../lib/errors.js"
import { checkStock, getProduct, listProducts, type WooCommerceCredentials } from "../lib/woocommerce/connector.js"
import { authorizeToolCall } from "./toolAuthorization.service.js"
import { EmbeddingBudgetError } from "../lib/embeddingBudget.js"
import { EmbeddingDimensionError, EmbeddingPriceMissingError } from "../lib/embeddingPricing.js"
import { log } from "../lib/logger.js"
import { activeEmbeddingIdentity, embedText, embedTexts, toPgVectorLiteral } from "./embeddings.service.js"

function requireDbPool() {
  if (!pool) throw new AppError(503, "Database is not configured. Set DATABASE_URL and JWT_SECRET.")
  return pool
}

export interface CatalogProduct {
  woocommerceProductId: string
  name: string
  description: string | null
  price: number | null
  stockQuantity: number | null
  // For rendering a real product card (image, price, description, a
  // "View on site"/"Buy" button linking straight to WooCommerce's own
  // product page — no purchase flow of this codebase's own for that
  // button, per the explicit product decision).
  imageUrl: string | null
  productUrl: string | null
}

function mapRow(row: Record<string, unknown>): CatalogProduct {
  return {
    woocommerceProductId: row.woocommerce_product_id as string,
    name: row.name as string,
    description: (row.description as string | null) ?? null,
    price: row.price === null ? null : Number(row.price),
    stockQuantity: (row.stock_quantity as number | null) ?? null,
    imageUrl: (row.image_url as string | null) ?? null,
    productUrl: (row.product_url as string | null) ?? null,
  }
}


export async function syncProductCatalog(chatbotId: string, creds: WooCommerceCredentials): Promise<number> {
  const db = requireDbPool()
  const products = await listProducts(creds)
  const embeddings = await embedTexts(
    products.map((p) => `${p.name}\n${p.description || ""}`),
    { chatbotId, purpose: "product_sync" },
  )
  const identity = activeEmbeddingIdentity()

  for (let i = 0; i < products.length; i++) {
    const product = products[i]
    const embedding = embeddings[i]
    await db.query(
      `insert into product_catalog_cache (chatbot_id, woocommerce_product_id, name, description, price, stock_quantity, image_url, product_url, embedding, embedding_model, embedding_dim, last_synced_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
       on conflict (chatbot_id, woocommerce_product_id) do update set
         name = excluded.name, description = excluded.description, price = excluded.price,
         stock_quantity = excluded.stock_quantity, image_url = excluded.image_url, product_url = excluded.product_url,
         embedding = excluded.embedding, embedding_model = excluded.embedding_model,
         embedding_dim = excluded.embedding_dim, last_synced_at = now()`,
      [
        chatbotId,
        String(product.id),
        product.name,
        product.description,
        product.price ? Number(product.price) : null,
        product.manage_stock ? product.stock_quantity : null,
        product.images?.[0]?.src ?? null,
        product.permalink ?? null,
        embedding ? toPgVectorLiteral(embedding) : null,
        embedding ? identity.model : null,
        embedding ? identity.dim : null,
      ],
    )
  }
  return products.length
}


export async function resyncSingleProduct(chatbotId: string, creds: WooCommerceCredentials, wooProductId: number): Promise<void> {
  const db = requireDbPool()
  const product = await getProduct(creds, wooProductId)
  const embedding = await embedText(`${product.name}\n${product.description || ""}`, {
    chatbotId,
    purpose: "product_sync",
  })
  const identity = activeEmbeddingIdentity()
  await db.query(
    `insert into product_catalog_cache (chatbot_id, woocommerce_product_id, name, description, price, stock_quantity, image_url, product_url, embedding, embedding_model, embedding_dim, last_synced_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
     on conflict (chatbot_id, woocommerce_product_id) do update set
       name = excluded.name, description = excluded.description, price = excluded.price,
       stock_quantity = excluded.stock_quantity, image_url = excluded.image_url, product_url = excluded.product_url,
       embedding = excluded.embedding, embedding_model = excluded.embedding_model,
       embedding_dim = excluded.embedding_dim, last_synced_at = now()`,
    [
      chatbotId,
      String(product.id),
      product.name,
      product.description,
      product.price ? Number(product.price) : null,
      product.manage_stock ? product.stock_quantity : null,
      product.images?.[0]?.src ?? null,
      product.permalink ?? null,
      embedding ? toPgVectorLiteral(embedding) : null,
      embedding ? identity.model : null,
      embedding ? identity.dim : null,
    ],
  )
}


// Real bug found here (surfaced once CI's Postgres image actually had
// pgvector and the table existed to test against): matching the customer's
// ENTIRE message as one ILIKE substring against name/description only ever
// matches if their whole sentence happens to be a literal substring of the
// product text — never true for a real question like "Do you have the Blue
// Widget in stock?". This is the no-embedding fallback path (no
// OPENAI_API_KEY configured), so it has to work on keywords, not the raw
// sentence.
const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "do", "does", "did", "how", "much", "what", "in", "and", "or", "to", "of",
  "for", "it", "this", "that", "have", "has", "you", "your", "i", "im", "can", "could", "would", "please",
  "hi", "hello", "on", "at", "with", "me", "my", "we", "us", "our", "was", "were", "be", "been", "being",
  "will", "shall", "should", "may", "might", "must", "not", "no", "yes", "if", "but", "so", "than", "then",
  "there", "here", "when", "where", "why", "who", "whom", "which", "about", "out", "up", "down", "from", "into",
])

function extractKeywords(query: string): string[] {
  const words = query.toLowerCase().match(/[a-z0-9]+/g) ?? []
  return [...new Set(words.filter((w) => w.length >= 3 && !STOPWORDS.has(w)))]
}

export async function lookupProducts(chatbotId: string, customerId: string | null, query: string, limit = 5): Promise<CatalogProduct[]> {
  await authorizeToolCall({ chatbotId, customerId, operation: "lookup_product" })
  const db = requireDbPool()

  let embedding: number[] | null = null
  let identity: ReturnType<typeof activeEmbeddingIdentity> | null = null
  try {
    identity = activeEmbeddingIdentity()
    embedding = await embedText(query, { chatbotId, purpose: "product_query" })
  } catch (err) {
    if (
      err instanceof EmbeddingBudgetError ||
      err instanceof EmbeddingPriceMissingError ||
      err instanceof EmbeddingDimensionError
    ) {
      log().warn(
        { chatbotId, err: err.message },
        "product vector lookup skipped because embedding is unavailable or over budget",
      )
    } else {
      throw err
    }
  }
  if (embedding && identity) {
    const startedAt = Date.now()
    const { rows } = await withHnswSearch(db, (client) =>
      client.query<{ distance?: string }>(
        `select *, embedding <=> $2 as distance
         from product_catalog_cache
         where chatbot_id = $1
           and embedding_model = $4
           and embedding_dim = $5
         order by embedding <=> $2
         limit $3`,
        [chatbotId, toPgVectorLiteral(embedding), limit, identity.model, identity.dim],
      ),
    )
    await recordRetrievalObservation("product", {
      elapsedMs: Date.now() - startedAt,
      returned: rows.length,
      limit,
      distances: rows.map((row) => Number(row.distance)),
    })
    if (rows.length > 0) return rows.map(mapRow)
  }

  const keywords = extractKeywords(query)
  if (keywords.length === 0) {
    const { rows } = await db.query(
      `select * from product_catalog_cache where chatbot_id = $1 and (name ilike $2 or description ilike $2) limit $3`,
      [chatbotId, `%${query}%`, limit],
    )
    return rows.map(mapRow)
  }

  const conditions = keywords.map((_, i) => `(name ilike $${i + 2} or description ilike $${i + 2})`).join(" or ")
  const params: unknown[] = [chatbotId, ...keywords.map((k) => `%${k}%`), limit]
  const { rows } = await db.query(
    `select * from product_catalog_cache where chatbot_id = $1 and (${conditions}) limit $${params.length}`,
    params,
  )
  return rows.map(mapRow)
}

export interface LiveProductSnapshot {
  woocommerceProductId: number
  name: string
  price: number
  inStock: boolean
  quantity: number | null
}


export async function getLiveProductSnapshot(
  chatbotId: string,
  customerId: string | null,
  creds: WooCommerceCredentials,
  wooProductId: number,
): Promise<LiveProductSnapshot> {
  await authorizeToolCall({ chatbotId, customerId, operation: "check_stock" })
  const [product, stock] = await Promise.all([getProduct(creds, wooProductId), checkStock(creds, wooProductId)])
  return { woocommerceProductId: wooProductId, name: product.name, price: Number(product.price), inStock: stock.inStock, quantity: stock.quantity }
}

/** Gradual cutover: rewrite catalog rows whose model/dim is not the active identity. */
export async function reembedMismatchedProductEmbeddings(batchSize = 25): Promise<number> {
  const db = requireDbPool()
  const identity = activeEmbeddingIdentity()
  const { rows } = await db.query<{ id: string; chatbot_id: string; name: string; description: string | null }>(
    `select id, chatbot_id, name, description
     from product_catalog_cache
     where embedding is not null
       and (embedding_model is distinct from $1 or embedding_dim is distinct from $2)
     order by last_synced_at
     limit $3`,
    [identity.model, identity.dim, batchSize],
  )
  if (rows.length === 0) return 0

  const byChatbot = new Map<string, typeof rows>()
  for (const row of rows) {
    const list = byChatbot.get(row.chatbot_id) ?? []
    list.push(row)
    byChatbot.set(row.chatbot_id, list)
  }

  let updated = 0
  for (const [chatbotId, batch] of byChatbot) {
    const embeddings = await embedTexts(
      batch.map((row) => `${row.name}\n${row.description || ""}`),
      { chatbotId, purpose: "product_sync" },
    )
    for (let i = 0; i < batch.length; i++) {
      const embedding = embeddings[i]
      if (!embedding) continue
      const result = await db.query(
        `update product_catalog_cache
         set embedding = $2, embedding_model = $3, embedding_dim = $4, last_synced_at = now()
         where id = $1 and chatbot_id = $5`,
        [batch[i].id, toPgVectorLiteral(embedding), identity.model, identity.dim, chatbotId],
      )
      updated += result.rowCount ?? 0
    }
  }
  return updated
}
