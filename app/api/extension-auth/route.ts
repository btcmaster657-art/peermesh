import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'
import { issueDesktopToken, verifyDesktopToken } from '@/lib/desktop-token'

export { verifyDesktopToken } // re-export for desktop/main.js verify call

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://peermesh-beta.vercel.app'

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateDeviceCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
}

function generateUserCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const part = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
  return `${part()}-${part()}`
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS })
}

// ── POST ──────────────────────────────────────────────────────────────────────
// Two uses:
//   1. Website after sign-in → body: { ext_id }  (extension flow)
//   2. Desktop app           → body: { device: true }  (device flow — request code)

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))

  // ── Device flow: desktop requests a code ──────────────────────────────────
  if (body.device === true) {
    const device_code = generateDeviceCode()
    const user_code = generateUserCode()

    await adminClient.from('device_codes').insert({
      device_code,
      user_code,
      status: 'pending',
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    })

    return NextResponse.json({
      device_code,
      user_code,
      verification_uri: `${APP_URL}/activate`,
      expires_in: 600,
      interval: 3,
    }, { headers: CORS })
  }

  // ── Extension flow: website writes token after sign-in ────────────────────
  const supabase = await createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401, headers: CORS })

  const { ext_id } = body
  if (!ext_id || typeof ext_id !== 'string' || ext_id.length < 10) {
    return NextResponse.json({ error: 'Invalid ext_id' }, { status: 400, headers: CORS })
  }

  const token = issueDesktopToken(session.user.id)

  await adminClient.from('extension_auth_tokens').upsert({
    ext_id,
    user_id: session.user.id,
    token,
    used: false,
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  }, { onConflict: 'ext_id' })

  return NextResponse.json({ ok: true }, { headers: CORS })
}

// ── PATCH ─────────────────────────────────────────────────────────────────────
// Website (authenticated) approves or denies a device code.
// Body: { user_code, action: 'approve' | 'deny' }

export async function PATCH(req: Request) {
  const supabase = await createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401, headers: CORS })

  const { user_code, action } = await req.json().catch(() => ({}))
  if (!user_code || !['approve', 'deny'].includes(action)) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400, headers: CORS })
  }

  const { data: row } = await adminClient
    .from('device_codes')
    .select('*')
    .eq('user_code', (user_code as string).toUpperCase().trim())
    .eq('status', 'pending')
    .gt('expires_at', new Date().toISOString())
    .single()

  if (!row) return NextResponse.json({ error: 'Invalid or expired code' }, { status: 404, headers: CORS })

  if (action === 'deny') {
    await adminClient.from('device_codes').update({ status: 'denied' }).eq('id', row.id)
    return NextResponse.json({ ok: true }, { headers: CORS })
  }

  // Approve — issue desktop token
  const token = issueDesktopToken(session.user.id)
  await adminClient.from('device_codes').update({
    status: 'approved',
    user_id: session.user.id,
    token,
  }).eq('id', row.id)

  return NextResponse.json({ ok: true }, { headers: CORS })
}

// ── GET ───────────────────────────────────────────────────────────────────────
// Three uses (via query params):
//   ?device_code=<code>          — desktop polls for approval
//   ?verify=1&userId=<id>        — desktop verifies its token (Authorization: Bearer <token>)
//   ?ext_id=<uuid>               — extension exchanges for user data

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)

  // ── Token verify ──────────────────────────────────────────────────────────
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

  // ── Device code poll ──────────────────────────────────────────────────────
  const device_code = searchParams.get('device_code')
  if (device_code) {
    const { data: row } = await adminClient
      .from('device_codes')
      .select('*')
      .eq('device_code', device_code)
      .single()

    if (!row) return NextResponse.json({ error: 'Invalid device_code' }, { status: 404, headers: CORS })

    if (new Date(row.expires_at) < new Date()) {
      await adminClient.from('device_codes').update({ status: 'expired' }).eq('device_code', device_code)
      return NextResponse.json({ status: 'expired' }, { headers: CORS })
    }

    if (row.status === 'pending') return NextResponse.json({ status: 'pending' }, { headers: CORS })
    if (row.status === 'denied') return NextResponse.json({ status: 'denied' }, { headers: CORS })
    if (row.status === 'expired') return NextResponse.json({ status: 'expired' }, { headers: CORS })

    if (row.status === 'approved' && row.token && row.user_id) {
      const { data: profile } = await adminClient
        .from('profiles')
        .select('username, country_code, trust_score, is_verified')
        .eq('id', row.user_id)
        .single()

      if (!profile?.is_verified) {
        return NextResponse.json({ error: 'Account not verified' }, { status: 403, headers: CORS })
      }

      return NextResponse.json({
        status: 'approved',
        user: {
          id: row.user_id,
          token: row.token,
          username: profile.username,
          country: profile.country_code,
          trustScore: profile.trust_score,
        },
      }, { headers: CORS })
    }

    return NextResponse.json({ status: row.status }, { headers: CORS })
  }

  // ── Extension ext_id exchange ─────────────────────────────────────────────
  const ext_id = searchParams.get('ext_id')
  if (!ext_id) return NextResponse.json({ error: 'Missing parameter' }, { status: 400, headers: CORS })

  const { data: row } = await adminClient
    .from('extension_auth_tokens')
    .select('*')
    .eq('ext_id', ext_id)
    .eq('used', false)
    .gt('expires_at', new Date().toISOString())
    .single()

  if (!row) return NextResponse.json({ pending: true }, { headers: CORS })

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

  await adminClient.from('extension_auth_tokens').update({ used: true }).eq('ext_id', ext_id)

  return NextResponse.json({
    user: {
      id: row.user_id,
      token: row.token,
      username: profile.username,
      country: profile.country_code,
      trustScore: profile.trust_score,
      totalShared: profile.total_bytes_shared,
      totalUsed: profile.total_bytes_used,
      isSharing: profile.is_sharing,
    },
  }, { headers: CORS })
}
