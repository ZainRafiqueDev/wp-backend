import { createHash } from "node:crypto"

export type ChatbotSourceType = "website" | "pdf" | "word"

export type ChatbotSource = {
  type: ChatbotSourceType
  label: string
  url?: string
  size?: number
  characters: number
  
  content?: string
  
  contentHash?: string
}

export function hashPageContent(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

export type ChatbotTheme = {
  primaryColor: string
  bgColor: string
  textColor: string
}

export const DEFAULT_THEME: ChatbotTheme = {
  primaryColor: "#769656",
  bgColor: "#ffffff",
  textColor: "#1f2937",
}


export type ChatbotStatus = "queued" | "crawling" | "processing" | "ready" | "failed"

export type Chatbot = {
  id: string
  name: string
  sources: ChatbotSource[]
  createdAt: string
  theme: ChatbotTheme
  
  allowedDomain?: string
  status: ChatbotStatus
  
  statusReason?: string
  
  fallbackMessage?: string
  
  preferredModel?: "anthropic" | "openai" | "gemini"

  websiteUrl?: string
}


export function chatbotRowToChatbot(row: {
  id: string
  name: string
  sources: unknown
  theme: unknown
  allowed_domain: string | null
  created_at: Date
  status: string
  status_reason: string | null
  fallback_message: string | null
  preferred_model?: string | null
  website_url?: string | null
}): Chatbot {
  return {
    id: row.id,
    name: row.name,
    sources: Array.isArray(row.sources) ? (row.sources as ChatbotSource[]) : [],
    theme: parseTheme(row.theme),
    allowedDomain: row.allowed_domain || undefined,
    createdAt: row.created_at.toISOString(),
    status: (row.status as ChatbotStatus) || "ready",
    statusReason: row.status_reason || undefined,
    fallbackMessage: row.fallback_message || undefined,
    preferredModel: isModelKey(row.preferred_model) ? row.preferred_model : undefined,
    websiteUrl: row.website_url || undefined,
  }
}

function isModelKey(value: string | null | undefined): value is "anthropic" | "openai" | "gemini" {
  return value === "anthropic" || value === "openai" || value === "gemini"
}

export function defaultFallbackMessage(chatbotName: string): string {
  return `That's outside what I can help with for ${chatbotName}.`
}

function parseTheme(raw: unknown): ChatbotTheme {
  if (!raw || typeof raw !== "object") return DEFAULT_THEME
  const theme = raw as Partial<ChatbotTheme>
  return {
    primaryColor: typeof theme.primaryColor === "string" ? theme.primaryColor : DEFAULT_THEME.primaryColor,
    bgColor: typeof theme.bgColor === "string" ? theme.bgColor : DEFAULT_THEME.bgColor,
    textColor: typeof theme.textColor === "string" ? theme.textColor : DEFAULT_THEME.textColor,
  }
}
