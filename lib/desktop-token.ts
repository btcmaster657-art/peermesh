import { createHmac } from 'crypto'

const TOKEN_SECRET = process.env.DESKTOP_TOKEN_SECRET ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? 'changeme'
const TOKEN_TTL_MS = 60 * 60 * 1000 // 1 hour

export function issueDesktopToken(userId: string): string {
  const payload = Buffer.from(JSON.stringify({ sub: userId, iat: Date.now(), exp: Date.now() + TOKEN_TTL_MS })).toString('base64url')
  const sig = createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url')
  return `${payload}.${sig}`
}

export function verifyDesktopToken(token: string): string | null {
  try {
    const [payload, sig] = token.split('.')
    if (!payload || !sig) return null
    const expected = createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url')
    if (expected !== sig) return null
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString())
    if (data.exp < Date.now()) return null
    return data.sub as string
  } catch {
    return null
  }
}
