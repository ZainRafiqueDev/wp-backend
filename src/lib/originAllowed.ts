
export function originAllowed(origin: string, allowedDomain: string | undefined): boolean {
  if (!allowedDomain) return false
  let hostname: string
  try {
    hostname = new URL(origin).hostname.toLowerCase()
  } catch {
    return false
  }
  const domain = allowedDomain.toLowerCase()
  return hostname === domain || hostname.endsWith(`.${domain}`)
}
