import "dotenv/config"
import { hasRelevantContent } from "../src/lib/relevance.js"

const zarar = [
  {
    path: "/",
    title: "ZARAR",
    text: "Hello, I am ZARAR Web Developer Graphic Designer. My Creative Portfolio UI/UX Web App Mobile App React JS. Skills and Experience. Take a coffee and chat with me.",
  },
]
const minimal = [
  {
    path: "/",
    title: "Acme",
    text: "Acme Co offers web development for small businesses. Contact us for a quote.",
  },
]
const queries = [
  "web development",
  "web dev",
  "website development",
  "do you build websites?",
  "do you make sites?",
  "what web services do you provide?",
  "what is the weather tomorrow?",
  "who won the world cup in 2018?",
  "What programming languages do your web developers use?",
]
for (const [name, pages] of [
  ["ZARAR", zarar],
  ["MINIMAL", minimal],
] as const) {
  console.log("====", name)
  for (const q of queries) {
    console.log(hasRelevantContent(q, pages) ? "PASS" : "FAIL", "|", q)
  }
}
