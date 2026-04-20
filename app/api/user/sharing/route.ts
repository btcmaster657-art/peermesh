import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'
import { verifyDesktopToken } from '@/lib/desktop-token'
import {
  buildPrivateShareExpiry,
  generatePrivateShareCode,
  isPrivateShareActive,
  parsePrivateShareExpiryHours,
} from '@/lib/private-sharing'

const RELAY_SECRET = process.env.RELAY_SECRET ?? ''

function isRelayRequest(req: Request): boolean {
  const relaySecret = req.headers.get('x-relay-secret') ?? ''
  return !!RELAY_SECRET && relaySecret === RELAY_SECRET
}

function getTodaySharedBytes(profile: {
  share_bytes_today?: number | null
  share_bytes_today_date?: string | null
}): number {
  const today = new Date().toISOString().slice(0, 10)
  return profile.share_bytes_today_date === today ? (profile.share_bytes_today ?? 0) : 0
}

function getProviderShareStatus(profile: {
  daily_share_limit_mb?: number | null
  share_bytes_today?: number | null
  share_bytes_today_date?: string | null
}) {
  const totalBytesToday = getTodaySharedBytes(profile)
  const limitBytes = profile.daily_share_limit_mb == null ? null : profile.daily_share_limit_mb * 1024 * 1024
  return {
    total_bytes_today: totalBytesToday,
    daily_limit_bytes: limitBytes,
    can_accept_sessions: limitBytes == null ? true : totalBytesToday < limitBytes,
  }
}

function parseDailyShareLimitMb(value: unknown): number | null | undefined {
  if (value === null) return null
  if (value === undefined) return undefined

  const raw = typeof value === 'string' ? value.trim() : String(value)
  if (!raw) return undefined

  const parsed = Number.parseInt(raw, 10)
  if (!Number.isInteger(parsed)) return undefined
  if (parsed < 1024) return undefined
  return parsed
}

type PrivateShareRow = {
  base_device_id: string
  share_code: string
  enabled: boolean
  expires_at: string | null
}

function serializePrivateShare(row: PrivateShareRow | null) {
  if (!row) return null
  return {
    base_device_id: row.base_device_id,
    code: row.share_code,
    enabled: row.enabled,
    expires_at: row.expires_at,
    active: isPrivateShareActive(row.enabled, row.expires_at),
  }
}

async function loadPrivateShareDevice(userId: string, baseDeviceId: string): Promise<PrivateShareRow | null> {
  const { data, error } = await adminClient
    .from('private_share_devices')
    .select('base_device_id, share_code, enabled, expires_at')
    .eq('user_id', userId)
    .eq('base_device_id', baseDeviceId)
    .maybeSingle()

  if (error) throw error
  return data ?? null
}

async function issuePrivateShareCode(userId: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = generatePrivateShareCode()
    const { data, error } = await adminClient
      .from('private_share_devices')
      .select('id')
      .eq('share_code', code)
      .maybeSingle()

    if (error) throw error
    if (!data) return code
  }

  throw new Error(`Could not issue a unique private share code for ${userId}`)
}

async function resolveUserId(req: Request, bodyUserId?: string): Promise<string | null> {
  if (isRelayRequest(req)) return bodyUserId ?? null

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
  const url = new URL(req.url)
  const relayProviderUserId = url.searchParams.get('providerUserId')
  const baseDeviceId = url.searchParams.get('baseDeviceId')?.trim() || null

  if (isRelayRequest(req) && relayProviderUserId) {
    const { data, error } = await adminClient
      .from('profiles')
      .select('daily_share_limit_mb, share_bytes_today, share_bytes_today_date')
      .eq('id', relayProviderUserId)
      .single()

    if (error || !data) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    // Also fetch private share state for this base device if requested
    let private_share = null
    if (baseDeviceId) {
      const ps = await loadPrivateShareDevice(relayProviderUserId, baseDeviceId)
      private_share = serializePrivateShare(ps)
    }

    return NextResponse.json({ ...getProviderShareStatus(data), private_share })
  }

  const userId = await resolveUserId(req)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data, error } = await adminClient
    .from('profiles')
    .select('total_bytes_shared, total_bytes_used, bandwidth_used_month, bandwidth_limit, trust_score, is_sharing, is_premium, daily_share_limit_mb, has_accepted_provider_terms, share_bytes_today, share_bytes_today_date')
    .eq('id', userId)
    .single()

  if (error || !data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const privateShare = baseDeviceId ? await loadPrivateShareDevice(userId, baseDeviceId) : null
  return NextResponse.json({
    total_bytes_shared: data.total_bytes_shared,
    total_bytes_used: data.total_bytes_used,
    bandwidth_used_month: data.bandwidth_used_month,
    bandwidth_limit: data.bandwidth_limit,
    trust_score: data.trust_score,
    is_sharing: data.is_sharing,
    is_premium: data.is_premium,
    daily_share_limit_mb: data.daily_share_limit_mb,
    has_accepted_provider_terms: data.has_accepted_provider_terms,
    private_share: serializePrivateShare(privateShare),
    ...getProviderShareStatus(data),
  })
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

  if (body.privateSharing && typeof body.privateSharing === 'object') {
    const userId = await resolveUserId(req)
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const baseDeviceId = String(body.privateSharing.baseDeviceId ?? '').trim()
    if (!baseDeviceId) {
      return NextResponse.json({ error: 'baseDeviceId is required' }, { status: 400 })
    }

    if (body.privateSharing.enabled !== undefined && typeof body.privateSharing.enabled !== 'boolean') {
      return NextResponse.json({ error: 'enabled must be boolean' }, { status: 400 })
    }

    const expiryHours = parsePrivateShareExpiryHours(body.privateSharing.expiryHours)
    if (body.privateSharing.expiryHours !== undefined && expiryHours === undefined) {
      return NextResponse.json({ error: 'expiryHours must be null or an integer between 1 and 720' }, { status: 400 })
    }

    const refresh = body.privateSharing.refresh === true
    const existing = await loadPrivateShareDevice(userId, baseDeviceId)
    const enabled = body.privateSharing.enabled ?? existing?.enabled ?? false
    const expiresAt = expiryHours !== undefined
      ? buildPrivateShareExpiry(expiryHours)
      : (existing?.expires_at ?? null)

    if (!enabled && !refresh && expiryHours === undefined && !existing) {
      return NextResponse.json({ ok: true, private_share: null })
    }

    let code = existing?.share_code ?? null
    if (!code || refresh) code = await issuePrivateShareCode(userId)

    const payload = {
      user_id: userId,
      base_device_id: baseDeviceId,
      share_code: code,
      enabled,
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    }

    const { data, error } = await adminClient
      .from('private_share_devices')
      .upsert(payload, { onConflict: 'user_id,base_device_id' })
      .select('base_device_id, share_code, enabled, expires_at')
      .single()

    if (error || !data) {
      return NextResponse.json({ error: error?.message ?? 'Could not update private sharing' }, { status: 500 })
    }

    return NextResponse.json({ ok: true, private_share: serializePrivateShare(data) })
  }

  // Web dashboard: { isSharing: boolean } or { dailyLimitMb: number | null }
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Setting daily share limit
  if ('dailyLimitMb' in body) {
    const limitMb = parseDailyShareLimitMb(body.dailyLimitMb)
    if (limitMb === undefined) {
      return NextResponse.json({ error: 'dailyLimitMb must be null or at least 1024 MB (1 GB)' }, { status: 400 })
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

  let userId = await resolveUserId(req, user_id)

  // Fallback: token expired but body has user_id — verify the user exists before trusting it
  if (!userId && user_id) {
    const { data: profile } = await adminClient
      .from('profiles')
      .select('id')
      .eq('id', user_id)
      .maybeSingle()
    if (profile) userId = user_id
  }

  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Detect country from the request IP
  // x-vercel-ip-country is injected by Vercel for free — no external call needed.
  // When the relay calls this endpoint it passes x-provider-ip (the real provider IP)
  // so we fall back to a geo-lookup only in that case.
  let country = 'XX'
  const providerIp = req.headers.get('x-provider-ip')
  if (providerIp) {
    // Relay-forwarded heartbeat — geo-lookup the real provider IP
    try {
      const geo = await fetch(`http://ip-api.com/json/${providerIp}?fields=status,countryCode`, { signal: AbortSignal.timeout(3000) })
      if (geo.ok) {
        const json = await geo.json()
        if (json.status === 'success' && json.countryCode) country = json.countryCode.toUpperCase()
      }
    } catch {}
  } else {
    // Direct heartbeat from desktop/CLI — Vercel knows the real IP
    const vercelCountry = req.headers.get('x-vercel-ip-country')
    if (vercelCountry && /^[A-Z]{2}$/.test(vercelCountry)) country = vercelCountry
  }

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
