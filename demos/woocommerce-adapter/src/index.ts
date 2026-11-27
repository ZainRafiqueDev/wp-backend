import { createApp } from "./app.js"

const port = Number(process.env.PORT || 4200)
const apiKey = process.env.API_KEY || undefined

const storeUrl = process.env.WOO_STORE_URL
const consumerKey = process.env.WOO_CONSUMER_KEY
const consumerSecret = process.env.WOO_CONSUMER_SECRET

if (!storeUrl || !consumerKey || !consumerSecret) {
  // eslint-disable-next-line no-console
  console.error("Set WOO_STORE_URL, WOO_CONSUMER_KEY, and WOO_CONSUMER_SECRET before starting this adapter. See README.md.")
  process.exit(1)
}

const app = createApp({ apiKey, woo: { storeUrl: storeUrl.replace(/\/+$/, ""), consumerKey, consumerSecret } })
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`woocommerce-adapter demo listening on :${port}, proxying ${storeUrl}`)
})
