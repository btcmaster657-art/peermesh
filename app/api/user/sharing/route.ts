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

function toBaseDeviceId(deviceKey: string): string {
  const match = /^(.*)_slot_\d+$/.exec(deviceKey)
  return match?.[1] ?? deviceKey
}

function getSlotIndex(deviceKey: string, baseDeviceId = toBaseDeviceId(deviceKey)): number | null {
  const prefix = `${baseDeviceId}_slot_`
  if (!deviceKey.startsWith(prefix)) return null
  const parsed = Number.parseInt(deviceKey.slice(prefix.length), 10)
  return Number.isInteger(parsed) ? parsed : null
}

function sortPrivateShareRows(rows: PrivateShareRow[]): PrivateShareRow[] {
  return [...rows].sort((a, b) => {
    const aBase = toBaseDeviceId(a.base_device_id)
    const bBase = toBaseDeviceId(b.base_device_id)
    if (aBase !== bBase) return aBase.localeCompare(bBase)

    const aSlot = getSlotIndex(a.base_device_id, aBase)
    const bSlot = getSlotIndex(b.base_device_id, bBase)
    if (aSlot == null && bSlot == null) return a.base_device_id.localeCompare(b.base_device_id)
    if (aSlot == null) return -1
    if (bSlot == null) return 1
    return aSlot - bSlot
  })
}

function serializePrivateShare(row: PrivateShareRow | null) {
  if (!row) return null
  const baseDeviceId = toBaseDeviceId(row.base_device_id)
  return {
    device_id: row.base_device_id,
    base_device_id: baseDeviceId,
    slot_index: getSlotIndex(row.base_device_id, baseDeviceId),
    code: row.share_code,
    enabled: row.enabled,
    expires_at: row.expires_at,
    active: isPrivateShareActive(row.enabled, row.expires_at),
  }
}

function selectPrivateShareRow(
  rows: PrivateShareRow[],
  deviceId?: string | null,
  baseDeviceId?: string | null,
): PrivateShareRow | null {
  if (rows.length === 0) return null
  if (deviceId) {
    const exact = rows.find(row => row.base_device_id === deviceId)
    if (exact) return exact
  }
  if (baseDeviceId) {
    const exactBase = rows.find(row => row.base_device_id === baseDeviceId)
    if (exactBase) return exactBase
    const slotZero = rows.find(row => getSlotIndex(row.base_device_id, baseDeviceId) === 0)
    if (slotZero) return slotZero
  }
  return rows[0] ?? null
}

function isMatchingPrivateShareKey(deviceKey: string, baseDeviceId: string): boolean {
  return deviceKey === baseDeviceId || deviceKey.startsWith(`${baseDeviceId}_slot_`)
}

async function loadPrivateShareDevice(
  userId: string,
  deviceId?: string | null,
  baseDeviceId?: string | null,
): Promise<PrivateShareRow | null> {
  const resolvedBaseDeviceId = baseDeviceId || (deviceId ? toBaseDeviceId(deviceId) : null)
  if (!resolvedBaseDeviceId && !deviceId) return null

  const rows = resolvedBaseDeviceId
    ? await loadPrivateShareDevices(userId, resolvedBaseDeviceId)
    : []

  return selectPrivateShareRow(rows, deviceId, resolvedBaseDeviceId)
}

async function loadPrivateShareDevices(userId: string, baseDeviceId: string): Promise<PrivateShareRow[]> {
  const { data, error } = await adminClient
    .from('private_share_devices')
    .select('base_device_id, share_code, enabled, expires_at')
    .eq('user_id', userId)

  if (error) throw error
  return sortPrivateShareRows((data ?? []).filter(row => isMatchingPrivateShareKey(row.base_device_id, baseDeviceId)))
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

async function cleanupStalePrivateShareSlots(
  userId: string,
  baseDeviceId: string,
  maxSlots?: number,
): Promise<{ deletedCount: number }> {
  try {
    // Get current slot configuration from provider_devices if maxSlots not provided
    let configuredSlots = maxSlots
    if (configuredSlots === undefined) {
      const { data: devices } = await adminClient
        .from('provider_devices')
        .select('connection_slots')
        .eq('user_id', userId)
        .eq('device_id', baseDeviceId)
        .maybeSingle()
      configuredSlots = devices?.connection_slots ?? 1
    }

    // Load all private share slots for this base device
    const allSlots = await loadPrivateShareDevices(userId, baseDeviceId)

    // Identify stale slots: those with slot_index >= configuredSlots
    const staleSlots = allSlots.filter(row => {
      const slotIndex = getSlotIndex(row.base_device_id, baseDeviceId)
      return slotIndex !== null && slotIndex >= configuredSlots
    })

    // Delete stale slots from DB
    if (staleSlots.length > 0) {
      const staleDeviceIds = staleSlots.map(row => row.base_device_id)
      const { error } = await adminClient
        .from('private_share_devices')
        .delete()
        .eq('user_id', userId)
        .in('base_device_id', staleDeviceIds)
      
      if (error) {
        console.error('cleanupStalePrivateShareSlots delete error:', error)
        return { deletedCount: 0 }
      }
      
      console.log(`cleanupStalePrivateShareSlots: deleted ${staleSlots.length} stale slots for user ${userId}, base ${baseDeviceId}`)
      return { deletedCount: staleSlots.length }
    }
    
    return { deletedCount: 0 }
  } catch (error) {
    // Log but don't fail the request if cleanup fails
    console.error('cleanupStalePrivateShareSlots error:', error)
    return { deletedCount: 0 }
  }
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
  const deviceId = url.searchParams.get('deviceId')?.trim() || null
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
    let private_shares = null
    const resolvedBaseDeviceId = baseDeviceId || (deviceId ? toBaseDeviceId(deviceId) : null)
    if (deviceId || resolvedBaseDeviceId) {
      const rows = resolvedBaseDeviceId
        ? await loadPrivateShareDevices(relayProviderUserId, resolvedBaseDeviceId)
        : []
      private_share = serializePrivateShare(selectPrivateShareRow(rows, deviceId, resolvedBaseDeviceId))
      private_shares = rows.map(serializePrivateShare)
    }

    return NextResponse.json({ ...getProviderShareStatus(data), private_share, private_shares })
  }

  const userId = await resolveUserId(req)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data, error } = await adminClient
    .from('profiles')
    .select('total_bytes_shared, total_bytes_used, bandwidth_used_month, bandwidth_limit, trust_score, is_sharing, is_premium, daily_share_limit_mb, has_accepted_provider_terms, share_bytes_today, share_bytes_today_date')
    .eq('id', userId)
    .single()

  if (error || !data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const resolvedBaseDeviceId = baseDeviceId || (deviceId ? toBaseDeviceId(deviceId) : null)
  const privateShareRows = resolvedBaseDeviceId
    ? await loadPrivateShareDevices(userId, resolvedBaseDeviceId)
    : []
  const privateShare = serializePrivateShare(selectPrivateShareRow(privateShareRows, deviceId, resolvedBaseDeviceId))
  const privateShares = privateShareRows.map(serializePrivateShare)
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
    private_share: privateShare,
    private_shares: privateShares,
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

    const requestedDeviceId = String(body.privateSharing.deviceId ?? '').trim()
    const requestedBaseDeviceId = String(body.privateSharing.baseDeviceId ?? '').trim()
    const baseDeviceId = requestedBaseDeviceId || (requestedDeviceId ? toBaseDeviceId(requestedDeviceId) : '')
    if (!baseDeviceId && !requestedDeviceId) {
      return NextResponse.json({ error: 'deviceId or baseDeviceId is required' }, { status: 400 })
    }

    const existingShares = baseDeviceId ? await loadPrivateShareDevices(userId, baseDeviceId) : []
    const fallbackDeviceId = requestedBaseDeviceId
      ? (requestedBaseDeviceId.includes('_slot_')
          ? requestedBaseDeviceId
          : (existingShares[0]?.base_device_id ?? `${requestedBaseDeviceId}_slot_0`))
      : ''
    const deviceId = requestedDeviceId || fallbackDeviceId
    if (!deviceId || !baseDeviceId) {
      return NextResponse.json({ error: 'deviceId or baseDeviceId is required' }, { status: 400 })
    }

    if (body.privateSharing.enabled !== undefined && typeof body.privateSharing.enabled !== 'boolean') {
      return NextResponse.json({ error: 'enabled must be boolean' }, { status: 400 })
    }

    const expiryHours = parsePrivateShareExpiryHours(body.privateSharing.expiryHours)
    if (body.privateSharing.expiryHours !== undefined && expiryHours === undefined) {
      return NextResponse.json({ error: 'expiryHours must be null or an integer between 1 and 720' }, { status: 400 })
    }

    const refresh = body.privateSharing.refresh === true
    const existing = selectPrivateShareRow(existingShares, deviceId, baseDeviceId)
    const enabled = body.privateSharing.enabled ?? existing?.enabled ?? false
    const expiresAt = expiryHours !== undefined
      ? buildPrivateShareExpiry(expiryHours)
      : (existing?.expires_at ?? null)

    if (!enabled && !refresh && expiryHours === undefined && !existing) {
      return NextResponse.json({ ok: true, private_share: null, private_shares: [] })
    }

    let code = existing?.share_code ?? null
    if (!code || refresh) code = await issuePrivateShareCode(userId)

    const payload = {
      user_id: userId,
      base_device_id: deviceId,
      share_code: code,
      enabled,
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    }

    const writeQuery = existing && existing.base_device_id !== deviceId
      ? adminClient
          .from('private_share_devices')
          .update(payload)
          .eq('user_id', userId)
          .eq('base_device_id', existing.base_device_id)
      : adminClient
          .from('private_share_devices')
          .upsert(payload, { onConflict: 'user_id,base_device_id' })

    const { data, error } = await writeQuery
      .select('base_device_id, share_code, enabled, expires_at')
      .single()

    if (error || !data) {
      return NextResponse.json({ error: error?.message ?? 'Could not update private sharing' }, { status: 500 })
    }

    // Clean up stale slots that no longer match the current slot configuration
    await cleanupStalePrivateShareSlots(userId, baseDeviceId)

    const privateShares = (await loadPrivateShareDevices(userId, baseDeviceId)).map(serializePrivateShare)
    return NextResponse.json({ ok: true, private_share: serializePrivateShare(data), private_shares: privateShares })
  }

  // Web dashboard or desktop: { isSharing: boolean } or { dailyLimitMb: number | null }
  // resolveUserId accepts Supabase cookie, Supabase Bearer token, AND desktop device token
  const userId = await resolveUserId(req)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Setting daily share limit
  if ('dailyLimitMb' in body) {
    const limitMb = parseDailyShareLimitMb(body.dailyLimitMb)
    if (limitMb === undefined) {
      return NextResponse.json({ error: 'dailyLimitMb must be null or at least 1024 MB (1 GB)' }, { status: 400 })
    }
    await adminClient.from('profiles').update({ daily_share_limit_mb: limitMb ?? null }).eq('id', userId)
    return NextResponse.json({ ok: true, daily_share_limit_mb: limitMb ?? null })
  }

  // Setting connection slots — clean up stale private share slots with debouncing
  if ('connectionSlots' in body && typeof body.connectionSlots === 'number') {
    const baseDeviceId = body.baseDeviceId ? String(body.baseDeviceId).trim() : null
    if (baseDeviceId) {
      // Debounce: only cleanup if slots actually changed
      const { data: currentDevice } = await adminClient
        .from('provider_devices')
        .select('connection_slots')
        .eq('user_id', userId)
        .eq('device_id', baseDeviceId)
        .maybeSingle()
      
      const currentSlots = currentDevice?.connection_slots ?? 1
      if (currentSlots !== body.connectionSlots) {
        const result = await cleanupStalePrivateShareSlots(userId, baseDeviceId, body.connectionSlots)
        console.log(`Slot cleanup for ${userId}/${baseDeviceId}: ${result.deletedCount} stale slots removed`)
      }
    }
    return NextResponse.json({ ok: true })
  }

  if (typeof body.isSharing !== 'boolean') {
    return NextResponse.json({ error: 'isSharing must be boolean' }, { status: 400 })
  }

  await adminClient.from('profiles').update({ is_sharing: body.isSharing }).eq('id', userId)
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
    p_relay_url: (body.relay_url && typeof body.relay_url === 'string') ? body.relay_url : null,
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
