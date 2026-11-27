import type { ChatbotSource } from "./chatbot.js"


export type SourceAnswer = {
  text: string
  source?: string
}

function sourceName(source: ChatbotSource): string {
  if (source.type !== "website") return source.label
  try {
    const url = new URL(source.url || source.label)
    const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "")
    return `${url.hostname.replace(/^www\./, "")}${path}`
  } catch {
    return source.url || source.label
  }
}

export function answerFromSources(question: string, sources: ChatbotSource[], fallbackMessage: string): SourceAnswer {
  const query = question.toLowerCase()
  const websites = sources.filter((source) => source.type === "website")
  const relevant = sources.find((source) => {
    const value = `${source.label} ${source.url || ""}`.toLowerCase()
    return query.split(/\s+/).some((word) => word.length > 3 && value.includes(word))
  })

  if (query.includes("source") || query.includes("trained") || query.includes("document")) {
    const names = sources.slice(0, 4).map(sourceName).join(", ")
    return {
      text: `I'm trained on ${sources.length} source${sources.length === 1 ? "" : "s"}: ${names}${sources.length > 4 ? ", and more" : ""}.`,
      source: sources[0] ? sourceName(sources[0]) : undefined,
    }
  }

  if (query.includes("price") || query.includes("plan") || query.includes("cost")) {
    const pricing = websites.find((source) => (source.url || source.label).includes("pricing"))
    return {
      text: pricing
        ? "I found a pricing page in your website knowledge. It contains the available plans and pricing information."
        : "I couldn't find a dedicated pricing source in the provided knowledge.",
      source: pricing ? sourceName(pricing) : undefined,
    }
  }

  if (query.includes("contact") || query.includes("support")) {
    const contact = websites.find((source) => (source.url || source.label).includes("contact"))
    return {
      text: contact
        ? "Your website includes a contact page where customers can find support and contact options."
        : "I can help with support questions using the sources you provided.",
      source: contact ? sourceName(contact) : undefined,
    }
  }

  if (relevant) {
    return {
      text: `I found a relevant source in the chatbot knowledge: ${sourceName(relevant)}. This source can be used to answer questions about that topic.`,
      source: sourceName(relevant),
    }
  }

  
  return { text: fallbackMessage }
}
