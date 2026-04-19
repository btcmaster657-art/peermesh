import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'
import { verifyDesktopToken } from '@/lib/desktop-token'

const RELAY_SECRET = process.env.RELAY_SECRET ?? ''

async function resolveUserId(req: Request, bodyUserId?: string): Promise<string | null> {
  const relaySecret = req.headers.get('x-relay-secret') ?? ''
  if (RELAY_SECRET && relaySecret === RELAY_SECRET) return bodyUserId ?? null

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (user) return user.id

  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!token) return null

  const fromDesktop = verifyDesktopToken(token)
  if (fromDesktop) return fromDesktop

  const { data } = await adminClient.auth.getUser(token)
  return data.user?.id ?? null
}

// ── GET: fetch fresh profile stats (extension polls this) ──────────────────
export async function GET(req: Request) {
  const userId = await resolveUserId(req)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data, error } = await adminClient
    .from('profiles')
    .select('total_bytes_shared, total_bytes_used, bandwidth_used_month, bandwidth_limit, trust_score, is_sharing, daily_share_limit_mb, has_accepted_provider_terms')
    .eq('id', userId)
    .single()

  if (error || !data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(data)
}

// ── POST: set is_sharing flag OR increment bytes (desktop provider) ───────────
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))

  // Desktop bandwidth report: { bytes: number }
  if (typeof body.bytes === 'number' && body.bytes > 0) {
    const userId = await resolveUserId(req)
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    await adminClient.rpc('increment_bytes_shared', { p_user_id: userId, p_bytes: body.bytes })
    return NextResponse.json({ ok: true })
  }

  // Accept provider terms — works for all clients (Bearer token or cookie)
  if (body.acceptProviderTerms === true) {
    const userId = await resolveUserId(req)
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    await adminClient.from('profiles').update({ has_accepted_provider_terms: true }).eq('id', userId)
    return NextResponse.json({ ok: true })
  }

  // Web dashboard: { isSharing: boolean } or { dailyLimitMb: number | null }
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Setting daily share limit
  if ('dailyLimitMb' in body) {
    const limitMb = body.dailyLimitMb === null ? null : parseInt(body.dailyLimitMb)
    if (body.dailyLimitMb !== null && (isNaN(limitMb!) || limitMb! < 0)) {
      return NextResponse.json({ error: 'dailyLimitMb must be a positive number or null' }, { status: 400 })
    }
    await adminClient.from('profiles').update({ daily_share_limit_mb: limitMb ?? null }).eq('id', user.id)
    return NextResponse.json({ ok: true, daily_share_limit_mb: limitMb ?? null })
  }

  if (typeof body.isSharing !== 'boolean') {
    return NextResponse.json({ error: 'isSharing must be boolean' }, { status: 400 })
  }

  await adminClient.from('profiles').update({ is_sharing: body.isSharing }).eq('id', user.id)
  return NextResponse.json({ success: true, isSharing: body.isSharing })
}

// ── PUT: provider heartbeat ───────────────────────────────────────────────────
export async function PUT(req: Request) {
  const body = await req.json().catch(() => ({}))
  const { device_id, user_id } = body

  if (!device_id) {
    return NextResponse.json({ error: 'device_id required' }, { status: 400 })
  }

  const userId = await resolveUserId(req, user_id)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Detect country from the request IP — never trust client-supplied value
  let country = 'XX'
  try {
    const ip =
      req.headers.get('x-provider-ip') ||
      req.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
      req.headers.get('x-real-ip') ||
      ''
    if (ip) {
      const geo = await fetch(`https://ipapi.co/${ip}/country/`, { signal: AbortSignal.timeout(3000) })
      if (geo.ok) country = (await geo.text()).trim().slice(0, 2).toUpperCase()
    }
  } catch {}

  const { error: rpcError } = await adminClient.rpc('upsert_provider_heartbeat', {
    p_user_id: userId,
    p_device_id: device_id,
    p_country: country,
  })

  // Opportunistically clean up stale devices from other users
  try { await adminClient.rpc('cleanup_stale_providers') } catch {}

  if (rpcError) return NextResponse.json({ error: rpcError.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

// ── DELETE: device stopped sharing ───────────────────────────────────────────
export async function DELETE(req: Request) {
  const body = await req.json().catch(() => ({}))
  const { device_id, user_id } = body

  if (!device_id) return NextResponse.json({ error: 'device_id required' }, { status: 400 })

  const userId = await resolveUserId(req, user_id)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  await adminClient.rpc('remove_provider_device', {
    p_user_id: userId,
    p_device_id: device_id,
  })

  // Clean up any other stale devices so is_sharing never stays stale
  try { await adminClient.rpc('cleanup_stale_providers') } catch {}

  return NextResponse.json({ ok: true })
}
