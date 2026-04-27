import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'
import { verifyDesktopToken } from '@/lib/desktop-token'

const RELAY_SECRET = process.env.RELAY_SECRET ?? ''

function logSession(level: 'info' | 'warn' | 'error', message: string, context: Record<string, unknown>) {
  const line = `[session/end] ${message} ${JSON.stringify(context)}`
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.info(line)
}

// PATCH: relay updates provider_id / provider_kind / relay_endpoint / target_host
// mid-session. Called by relay syncs as the requester is attached, the provider
// acknowledges, or new target hosts are observed.
export async function PATCH(req: Request) {
  const secret = req.headers.get('x-relay-secret') ?? ''
  if (RELAY_SECRET && secret !== RELAY_SECRET) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const {
    sessionId,
    dbSessionId,
    status,
    providerUserId,
    providerKind,
    providerDeviceId,
    providerBaseDeviceId,
    relayEndpoint,
    targetHost,
    targetHosts,
    disconnectReason,
  } = await req.json().catch(() => ({}))

  const resolvedId = dbSessionId ?? sessionId ?? null
  const hasPatchField = !!providerUserId || !!providerKind || !!providerDeviceId || !!providerBaseDeviceId || !!relayEndpoint || !!targetHost
    || (Array.isArray(targetHosts) && targetHosts.length > 0)
    || !!disconnectReason
    || typeof status === 'string'

  if (!resolvedId || !hasPatchField) {
    return NextResponse.json(
      { error: 'dbSessionId/sessionId plus at least one session field is required' },
      { status: 400 },
    )
  }

  const patch: Record<string, unknown> = {}
  if (providerUserId) patch.provider_id = providerUserId
  if (providerKind) patch.provider_kind = providerKind
  if (providerDeviceId) patch.provider_device_id = providerDeviceId
  if (providerBaseDeviceId) patch.provider_base_device_id = providerBaseDeviceId
  if (relayEndpoint) patch.relay_endpoint = relayEndpoint
  if (targetHost) patch.target_host = targetHost
  if (Array.isArray(targetHosts) && targetHosts.length > 0) patch.target_hosts = targetHosts
  if (disconnectReason) patch.disconnect_reason = disconnectReason
  if (typeof status === 'string') patch.status = status

  const { error, count } = await adminClient
    .from('sessions')
    .update(patch, { count: 'exact' })
    .eq('id', resolvedId)
    .in('status', ['pending', 'active', 'ended'])

  if (error) {
    logSession('error', 'PATCH failed', { resolvedId, providerUserId, relayEndpoint, targetHost, error: error.message })
    return NextResponse.json({ error: 'Could not update session' }, { status: 500 })
  }

  if (!count) {
    logSession('warn', 'PATCH session row missing', { resolvedId, providerUserId, relayEndpoint, targetHost })
  }

  return NextResponse.json({ ok: true, updated: count ?? 0 })
}

// POST: end a session - called by the relay or by the client.
// Writes all final values to sessions in one update.
export async function POST(req: Request) {
  const relaySecret = req.headers.get('x-relay-secret') ?? ''
  const isRelay = RELAY_SECRET !== '' && relaySecret === RELAY_SECRET

  let userId: string | null = null

  if (!isRelay) {
    const supabase = await createClient()
    userId = (await supabase.auth.getUser()).data.user?.id ?? null
    if (!userId) {
      const auth = req.headers.get('authorization') ?? ''
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
      if (token) {
        userId = (await adminClient.auth.getUser(token)).data.user?.id ?? verifyDesktopToken(token) ?? null
      }
    }
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const {
    sessionId,
    bytesUsed = 0,
    providerUserId,
    requesterUserId,
    country,
    targetHost,
    targetHosts,
    providerKind,
    providerDeviceId,
    providerBaseDeviceId,
    relayEndpoint,
    disconnectReason,
  } = await req.json().catch(() => ({}))

  if (!sessionId) return NextResponse.json({ error: 'sessionId is required' }, { status: 400 })

  // Load current session to fill in any fields the caller did not provide.
  const { data: existing, error: lookupError } = await adminClient
    .from('sessions')
    .select('provider_id, provider_kind, provider_device_id, provider_base_device_id, relay_endpoint, target_country, target_host, target_hosts, user_id, status, bytes_used, disconnect_reason')
    .eq('id', sessionId)
    .maybeSingle()

  if (lookupError) {
    logSession('error', 'POST lookup failed', { sessionId, error: lookupError.message })
    return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  }

  const finalProviderId = providerUserId ?? existing?.provider_id ?? null
  const finalRequesterId = isRelay ? (requesterUserId ?? existing?.user_id ?? null) : userId
  const finalCountry = country ?? existing?.target_country ?? null
  const finalProviderKind = providerKind ?? existing?.provider_kind ?? null
  const finalProviderDeviceId = providerDeviceId ?? existing?.provider_device_id ?? null
  const finalProviderBaseDeviceId = providerBaseDeviceId ?? existing?.provider_base_device_id ?? null
  const finalRelayEndpoint = relayEndpoint ?? existing?.relay_endpoint ?? null
  const finalTargetHost = targetHost ?? existing?.target_host ?? null
  const finalDisconnectReason = disconnectReason ?? existing?.disconnect_reason ?? null
  const finalBytes = Math.max(Number(bytesUsed) || 0, Number(existing?.bytes_used) || 0)

  // Merge incoming target_hosts with any already stored on the row.
  const existingHosts: string[] = (existing as { target_hosts?: string[] | null } | null)?.target_hosts ?? []
  const incomingHosts: string[] = Array.isArray(targetHosts) ? targetHosts : []
  const mergedHosts = [...new Set([...existingHosts, ...incomingHosts, ...(finalTargetHost ? [finalTargetHost] : [])])]

  // End the session - update all fields in one write.
  const { error: endError, count } = await adminClient
    .from('sessions')
    .update({
      status: 'ended',
      ended_at: new Date().toISOString(),
      bytes_used: finalBytes,
      provider_id: finalProviderId,
      provider_kind: finalProviderKind,
      provider_device_id: finalProviderDeviceId,
      provider_base_device_id: finalProviderBaseDeviceId,
      relay_endpoint: finalRelayEndpoint,
      target_host: finalTargetHost,
      target_hosts: mergedHosts,
      disconnect_reason: finalDisconnectReason,
    }, { count: 'exact' })
    .eq('id', sessionId)
    .in('status', ['pending', 'active'])

  if (endError) {
    logSession('error', 'POST end failed', { sessionId, error: endError.message })
    return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  }

  // If already ended (count=0), still patch metadata so it stays complete.
  if (count === 0) {
    await adminClient
      .from('sessions')
      .update({
        provider_id: finalProviderId,
        provider_kind: finalProviderKind,
        provider_device_id: finalProviderDeviceId,
        provider_base_device_id: finalProviderBaseDeviceId,
        relay_endpoint: finalRelayEndpoint,
        target_host: finalTargetHost,
        target_hosts: mergedHosts,
        bytes_used: finalBytes,
        disconnect_reason: finalDisconnectReason,
      })
      .eq('id', sessionId)
  }

  const shouldApplyCounters = count !== 0

  await Promise.all([
    shouldApplyCounters && finalBytes > 0 && finalRequesterId
      ? adminClient.rpc('increment_bandwidth', { p_user_id: finalRequesterId, p_bytes: finalBytes })
      : Promise.resolve(),

    // Provider bytes shared - relay finalization is authoritative for extension
    // providers. Desktop and CLI providers report their own bytes separately.
    shouldApplyCounters && finalBytes > 0 && finalProviderId &&
    finalProviderKind !== 'desktop' && finalProviderKind !== 'cli'
      ? adminClient.rpc('increment_bytes_shared', { p_user_id: finalProviderId, p_bytes: finalBytes })
      : Promise.resolve(),

    shouldApplyCounters && finalRequesterId && finalProviderId && finalCountry
      ? adminClient.rpc('set_preferred_provider', {
          p_user_id: finalRequesterId,
          p_country: finalCountry,
          p_provider_user_id: finalProviderId,
        })
      : Promise.resolve(),
  ])

  logSession('info', 'POST session finalized', {
    sessionId,
    isRelay,
    finalProviderId,
    finalRequesterId,
    finalCountry,
    finalProviderKind,
    finalProviderDeviceId,
    finalRelayEndpoint,
    finalTargetHost,
    finalDisconnectReason,
    finalBytes,
    endedActiveRow: count ?? 0,
  })

  return NextResponse.json({ success: true })
}
