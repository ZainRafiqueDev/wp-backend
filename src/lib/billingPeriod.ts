/** Calendar-month billing helpers. Pay 28 Sep 19:00 → next 28 Oct 19:00. */

export function unixSecondsToDate(ts: unknown): Date | null {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return null
  return new Date(ts * 1000)
}

export function addOneBillingPeriod(from: Date): Date {
  const next = new Date(from.getTime())
  const originalDay = next.getDate()
  next.setMonth(next.getMonth() + 1)
  if (next.getDate() !== originalDay) {
    next.setDate(0)
  }
  return next
}

export function periodEndFromStripeSubscription(
  subscription: {
    current_period_end?: number | null
    items?: { data?: Array<{ current_period_end?: number | null }> | null } | null
  },
): Date | null {
  const fromItem = unixSecondsToDate(subscription.items?.data?.[0]?.current_period_end)
  if (fromItem) return fromItem
  return unixSecondsToDate(subscription.current_period_end)
}

export function invoiceSubscriptionId(invoice: {
  subscription?: string | { id?: string } | null
  parent?: {
    subscription_details?: { subscription?: string | { id?: string } | null } | null
  } | null
  lines?: { data?: Array<{ subscription?: string | { id?: string } | null }> | null } | null
}): string | undefined {
  const fromValue = (value: string | { id?: string } | null | undefined): string | undefined => {
    if (typeof value === "string" && value) return value
    if (value && typeof value === "object" && typeof value.id === "string" && value.id) return value.id
    return undefined
  }

  return (
    fromValue(invoice.subscription) ??
    fromValue(invoice.parent?.subscription_details?.subscription) ??
    fromValue(invoice.lines?.data?.[0]?.subscription)
  )
}

export function paidPlanLabel(plan: string | null | undefined): string {
  if (plan === "crawl_plus") return "Crawl Plus"
  if (plan === "full_custom") return "Full Custom"
  return "paid"
}
