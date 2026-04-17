import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'
import { createHmac } from 'crypto'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

const TOKEN_SECRET = process.env.DESKTOP_TOKEN_SECRET ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? 'changeme'
const TOKEN_TTL_MS = 60 * 60 * 1000 // 1 hour

/** Issue a short-lived HMAC-signed token: base64(payload).signature */
function issueDesktopToken(userId: string): string {
  const payload = Buffer.from(JSON.stringify({ sub: userId, iat: Date.now(), exp: Date.now() + TOKEN_TTL_MS })).toString('base64url')
  const sig = createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url')
  return `${payload}.${sig}`
}

/** Verify a desktop token. Returns userId or null. */
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

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS })
}

// POST /api/extension-auth — called by website after sign-in to write a one-time token
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401, headers: CORS })

  const { ext_id } = await req.json()
  if (!ext_id || typeof ext_id !== 'string' || ext_id.length < 10) {
    return NextResponse.json({ error: 'Invalid ext_id' }, { status: 400, headers: CORS })
  }

  const desktopToken = issueDesktopToken(session.user.id)

  await adminClient.from('extension_auth_tokens').upsert({
    ext_id,
    user_id: session.user.id,
    // Store our signed desktop token, NOT the raw Supabase access_token
    token: desktopToken,
    used: false,
    expires_at: new Date(Date.now() + TOKEN_TTL_MS).toISOString(),
  }, { onConflict: 'ext_id' })

  return NextResponse.json({ ok: true }, { headers: CORS })
}

// GET /api/extension-auth?verify=1 — called by desktop app to verify its signed token
// Authorization: Bearer <desktopToken>  ?userId=<uid>
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)

  if (searchParams.get('verify') === '1') {
    const auth = req.headers.get('authorization') ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    const userId = searchParams.get('userId') ?? ''
    if (!token) return NextResponse.json({ error: 'Missing token' }, { status: 401, headers: CORS })
    const tokenUserId = verifyDesktopToken(token)
    if (!tokenUserId) return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401, headers: CORS })
    if (userId && tokenUserId !== userId) return NextResponse.json({ error: 'Token mismatch' }, { status: 403, headers: CORS })
    return NextResponse.json({ ok: true, userId: tokenUserId }, { headers: CORS })
  }

  // GET /api/extension-auth?ext_id=<uuid> — called by extension to exchange for user data
  const ext_id = searchParams.get('ext_id')

  if (!ext_id) {
    return NextResponse.json({ error: 'Missing ext_id' }, { status: 400, headers: CORS })
  }

  const { data: row } = await adminClient
    .from('extension_auth_tokens')
    .select('*')
    .eq('ext_id', ext_id)
    .eq('used', false)
    .gt('expires_at', new Date().toISOString())
    .single()

  if (!row) return NextResponse.json({ pending: true }, { headers: CORS })

  // Verify our signed token
  const userId = verifyDesktopToken(row.token)
  if (!userId || userId !== row.user_id) {
    return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401, headers: CORS })
  }

  const { data: profile } = await adminClient
    .from('profiles')
    .select('username, country_code, trust_score, is_verified, total_bytes_shared, total_bytes_used, is_sharing')
    .eq('id', row.user_id)
    .single()

  if (!profile?.is_verified) {
    return NextResponse.json({ error: 'Account not verified' }, { status: 403, headers: CORS })
  }

  // Mark token as used (one-time)
  await adminClient.from('extension_auth_tokens').update({ used: true }).eq('ext_id', ext_id)

  return NextResponse.json({
    user: {
      id: row.user_id,
      token: row.token, // signed desktop token, not Supabase JWT
      username: profile.username,
      country: profile.country_code,
      trustScore: profile.trust_score,
      totalShared: profile.total_bytes_shared,
      totalUsed: profile.total_bytes_used,
      isSharing: profile.is_sharing,
    },
  }, { headers: CORS })
}
