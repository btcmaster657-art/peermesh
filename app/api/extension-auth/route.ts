import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'
import { issueDesktopToken, verifyDesktopToken } from '@/lib/desktop-token'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://peermesh-beta.vercel.app'
const EXTENSION_AUTH_TTL_MS = 365 * 24 * 60 * 60 * 1000

function isProfileActivated(profile: { is_verified?: boolean | null; phone_number?: string | null } | null | undefined): boolean {
  return !!(profile?.is_verified || profile?.phone_number)
}

async function ensureProfileActivated<T extends { is_verified?: boolean | null; phone_number?: string | null }>(
  userId: string,
  profile: T | null,
): Promise<T | null> {
  if (!profile || profile.is_verified || !profile.phone_number) return profile
  await adminClient
    .from('profiles')
    .update({ is_verified: true, verified_at: new Date().toISOString() })
    .eq('id', userId)
  return { ...profile, is_verified: true }
}

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

// â”€â”€ POST â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Two uses:
//   1. Website after sign-in â†’ body: { ext_id }  (extension flow)
//   2. Desktop app           â†’ body: { device: true }  (device flow â€” request code)

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))

  // â”€â”€ Device flow: desktop requests a code â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
      verification_uri: `${APP_URL}/extension`,
      expires_in: 600,
      interval: 3,
    }, { headers: CORS })
  }

  // â”€â”€ Extension flow: website writes token after sign-in â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    supabase_token: session.access_token,
    used: false,
    expires_at: new Date(Date.now() + EXTENSION_AUTH_TTL_MS).toISOString(),
  }, { onConflict: 'ext_id' })

  return NextResponse.json({ ok: true }, { headers: CORS })
}

// â”€â”€ PATCH â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

  const normalized = (user_code as string).toUpperCase().trim().replace(/[^A-Z0-9]/g, '')
  const formatted = normalized.length === 8 ? `${normalized.slice(0, 4)}-${normalized.slice(4)}` : normalized

  const { data: row, error: rowError } = await adminClient
    .from('device_codes')
    .select('*')
    .eq('user_code', formatted)
    .eq('status', 'pending')
    .gt('expires_at', new Date().toISOString())
    .maybeSingle()

  if (rowError) return NextResponse.json({ error: 'Database error' }, { status: 500, headers: CORS })
  if (!row) return NextResponse.json({ error: 'Invalid or expired code' }, { status: 404, headers: CORS })

  if (action === 'deny') {
    await adminClient.from('device_codes').update({ status: 'denied' }).eq('id', row.id)
    return NextResponse.json({ ok: true }, { headers: CORS })
  }

  const token = issueDesktopToken(session.user.id)
  await adminClient.from('device_codes').update({
    status: 'approved',
    user_id: session.user.id,
    token,
  }).eq('id', row.id)

  return NextResponse.json({ ok: true }, { headers: CORS })
}

// â”€â”€ GET â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Three uses (via query params):
//   ?device_code=<code>          â€” desktop polls for approval
//   ?verify=1&userId=<id>        â€” desktop verifies its token (Authorization: Bearer <token>)
//   ?ext_id=<uuid>               â€” extension exchanges for user data

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)

  // â”€â”€ Token refresh â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Called by desktop/CLI/extension when their token has expired mid-session.
  // Re-issues a fresh desktop token for the userId if the user still exists and
  // is verified. No old token required â€” the userId is the identity anchor.
  if (searchParams.get('refresh') === '1') {
    // Desktop/CLI agents refresh their token using only userId â€” no old token required.
    // Refused only if the device has been explicitly revoked (status = 'revoked').
    const userId = searchParams.get('userId') ?? ''
    if (!userId) return NextResponse.json({ error: 'userId required' }, { status: 400, headers: CORS })
    const { data: rawProfile } = await adminClient
      .from('profiles').select('id, is_verified, phone_number').eq('id', userId).maybeSingle()
    const profile = await ensureProfileActivated(userId, rawProfile)
    if (!isProfileActivated(profile)) return NextResponse.json({ error: 'Not found or not verified' }, { status: 404, headers: CORS })
    const { data: revokedRow } = await adminClient
      .from('device_codes').select('id').eq('user_id', userId).eq('status', 'revoked').maybeSingle()
    if (revokedRow) return NextResponse.json({ revoked: true }, { status: 403, headers: CORS })
    return NextResponse.json({ token: issueDesktopToken(userId) }, { headers: CORS })
  }

  // â”€â”€ Token verify â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Returns { ok: true } when valid, { revoked: true } when explicitly revoked.
  // A 401 (expired token) is NOT revocation â€” clients should refresh, not sign out.
  if (searchParams.get('verify') === '1') {
    const auth = req.headers.get('authorization') ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    const userId = searchParams.get('userId') ?? ''
    if (!token) return NextResponse.json({ error: 'Missing token' }, { status: 401, headers: CORS })
    const tokenUserId = verifyDesktopToken(token)
    if (!tokenUserId) {
      // Token is cryptographically invalid or expired â€” not the same as revoked.
      // Return 401 so the client can attempt a refresh, not a sign-out.
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401, headers: CORS })
    }
    if (userId && tokenUserId !== userId) return NextResponse.json({ error: 'Token mismatch' }, { status: 403, headers: CORS })

    // Check if this device has been explicitly revoked in device_codes
    const { data: revokedRow } = await adminClient
      .from('device_codes')
      .select('id')
      .eq('user_id', tokenUserId)
      .eq('status', 'revoked')
      .maybeSingle()

    if (revokedRow) {
      return NextResponse.json({ revoked: true }, { status: 403, headers: CORS })
    }

    return NextResponse.json({ ok: true, userId: tokenUserId }, { headers: CORS })
  }

  // â”€â”€ Device code poll â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
        .select('username, country_code, trust_score, role, is_verified, phone_number, has_accepted_provider_terms, contribution_credits_bytes, wallet_balance_usd, wallet_pending_payout_usd')
        .eq('id', row.user_id)
        .single()

      const activeProfile = await ensureProfileActivated(row.user_id, profile)
      if (!isProfileActivated(activeProfile)) {
        return NextResponse.json({ error: 'Account not verified' }, { status: 403, headers: CORS })
      }

      return NextResponse.json({
        status: 'approved',
        user: {
          id: row.user_id,
          token: row.token,
          username: activeProfile?.username,
          country: activeProfile?.country_code,
          trustScore: activeProfile?.trust_score,
          role: activeProfile?.role,
          walletBalanceUsd: activeProfile?.wallet_balance_usd,
          contributionCreditsBytes: activeProfile?.contribution_credits_bytes,
          walletPendingPayoutUsd: activeProfile?.wallet_pending_payout_usd,
          hasAcceptedProviderTerms: activeProfile?.has_accepted_provider_terms ?? false,
        },
      }, { headers: CORS })
    }

    return NextResponse.json({ status: row.status }, { headers: CORS })
  }

  // â”€â”€ Extension ext_id exchange â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    .select('username, country_code, trust_score, role, is_verified, phone_number, is_premium, total_bytes_shared, total_bytes_used, is_sharing, has_accepted_provider_terms, daily_share_limit_mb, contribution_credits_bytes, wallet_balance_usd, wallet_pending_payout_usd')
    .eq('id', row.user_id)
    .single()

  const activeProfile = await ensureProfileActivated(row.user_id, profile)
  if (!isProfileActivated(activeProfile)) {
    return NextResponse.json({ error: 'Account not verified' }, { status: 403, headers: CORS })
  }

  try {
    await adminClient
      .from('extension_auth_tokens')
      .update({ expires_at: new Date(Date.now() + EXTENSION_AUTH_TTL_MS).toISOString() })
      .eq('id', row.id)
  } catch {}

  return NextResponse.json({
    user: {
      id: row.user_id,
      token: row.token,
      supabaseToken: row.supabase_token,
      username: activeProfile?.username,
      country: activeProfile?.country_code,
      trustScore: activeProfile?.trust_score,
      role: activeProfile?.role,
      isPremium: activeProfile?.is_premium,
      totalShared: activeProfile?.total_bytes_shared,
      totalUsed: activeProfile?.total_bytes_used,
      isSharing: activeProfile?.is_sharing,
      contributionCreditsBytes: activeProfile?.contribution_credits_bytes,
      walletBalanceUsd: activeProfile?.wallet_balance_usd,
      walletPendingPayoutUsd: activeProfile?.wallet_pending_payout_usd,
      hasAcceptedProviderTerms: activeProfile?.has_accepted_provider_terms ?? false,
      dailyLimitMb: activeProfile?.daily_share_limit_mb,
    },
  }, { headers: CORS })
}
