import { safeFetch } from "./safeFetch.js"
import { assertSafeUrl } from "./ssrf.js"

const CRAWLER_AGENT_TOKEN = "chatmate360bot"
const MAX_LINES = 10000

interface RuleSet {
  disallow: string[]
  allow: string[]
}

export interface RobotsRules {
  byAgent: Map<string, RuleSet>
}


function parseRobotsTxt(text: string): RobotsRules {
  const byAgent = new Map<string, RuleSet>()
  let currentSets: RuleSet[] = []
  let collectingAgents = true

  for (const rawLine of text.split(/\r?\n/).slice(0, MAX_LINES)) {
    const line = rawLine.split("#")[0].trim()
    if (!line) continue
    const colonIdx = line.indexOf(":")
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim().toLowerCase()
    const value = line.slice(colonIdx + 1).trim()

    if (key === "user-agent") {
      if (!collectingAgents) {
        currentSets = []
        collectingAgents = true
      }
      const agent = value.toLowerCase()
      let set = byAgent.get(agent)
      if (!set) {
        set = { disallow: [], allow: [] }
        byAgent.set(agent, set)
      }
      currentSets.push(set)
      continue
    }

    if (key === "disallow" || key === "allow") {
      collectingAgents = false
      if (!value) continue
      for (const set of currentSets) {
        ;(key === "disallow" ? set.disallow : set.allow).push(value)
      }
    }
  }

  return { byAgent }
}

function ruleMatches(pathname: string, rule: string): boolean {
  if (!rule) return false
  const endAnchored = rule.endsWith("$")
  const pattern = endAnchored ? rule.slice(0, -1) : rule
  const startAnchored = !pattern.startsWith("*")
  const segments = pattern.split("*").filter((s) => s !== "")

  if (segments.length === 0) return true

  let cursor = 0
  for (let i = 0; i < segments.length; i++) {
    const found = pathname.indexOf(segments[i], cursor)
    if (found === -1) return false
    if (i === 0 && startAnchored && found !== 0) return false
    cursor = found + segments[i].length
  }
  return !endAnchored || cursor === pathname.length
}

export function isAllowed(rules: RobotsRules, pathname: string): boolean {
  const set = rules.byAgent.get(CRAWLER_AGENT_TOKEN) ?? rules.byAgent.get("*")
  if (!set) return true

  let matched: { allow: boolean; length: number } | null = null
  for (const rule of set.disallow) {
    if (ruleMatches(pathname, rule) && (!matched || rule.length > matched.length)) {
      matched = { allow: false, length: rule.length }
    }
  }
  for (const rule of set.allow) {
    if (ruleMatches(pathname, rule) && (!matched || rule.length > matched.length)) {
      matched = { allow: true, length: rule.length }
    }
  }
  return !matched || matched.allow
}

export async function fetchRobotsRules(root: URL, timeoutMs: number, maxBytes: number): Promise<RobotsRules> {
  const robotsUrl = new URL("/robots.txt", root)
  try {
    await assertSafeUrl(robotsUrl)
  } catch {
    return { byAgent: new Map() }
  }

  const res = await safeFetch(robotsUrl, timeoutMs, maxBytes)
  if (!res.ok) return { byAgent: new Map() }

  return parseRobotsTxt(res.html)
}
