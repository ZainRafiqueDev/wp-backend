import { createApp } from "./app.js"

const port = Number(process.env.PORT || 4100)
const apiKey = process.env.API_KEY || undefined

const app = createApp({ apiKey })
app.listen(port, () => {
 
  console.log(`booking-api demo listening on :${port}${apiKey ? " (API key required)" : " (no API key configured)"}`)
})
