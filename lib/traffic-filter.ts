const ALLOWED_PORTS = new Set([80, 443, 8080, 8443])

const BLOCKED_PATTERNS = [
  /torrent/i,
  /\.onion$/,
  /^smtp\./i,
  /^mail\./i,
  /^pop3\./i,
  /^imap\./i,
  /phishing/i,
]

// RFC-1918 + loopback — never allow routing to private ranges
const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
]

export function isRequestAllowed(host: string, port: number): boolean {
  if (!ALLOWED_PORTS.has(port)) return false
  if (BLOCKED_PATTERNS.some(p => p.test(host))) return false
  if (BLOCKED_HOST_PATTERNS.some(p => p.test(host))) return false
  return true
}

export function isUserTrusted(trustScore: number): boolean {
  return trustScore >= 30
}

// Rate limiter: max 100 requests per minute per session
const sessionRequests = new Map<string, { count: number; windowStart: number }>()

export function checkRateLimit(sessionId: string): boolean {
  const now = Date.now()
  const WINDOW = 60_000
  const MAX = 100

  const record = sessionRequests.get(sessionId)
  if (!record) {
    sessionRequests.set(sessionId, { count: 1, windowStart: now })
    return true
  }

  if (now - record.windowStart > WINDOW) {
    record.count = 1
    record.windowStart = now
    return true
  }

  if (record.count >= MAX) return false
  record.count++
  return true
}

export function clearRateLimit(sessionId: string): void {
  sessionRequests.delete(sessionId)
}
