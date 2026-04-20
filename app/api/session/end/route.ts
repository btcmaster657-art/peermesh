import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'

const RELAY_SECRET = process.env.RELAY_SECRET ?? ''

function logSession(level: 'info' | 'warn' | 'error', message: string, context: Record<string, unknown>) {
  const line = `[session/end] ${message} ${JSON.stringify(context)}`
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.info(line)
}

export async function PATCH(req: Request) {
  const secret = req.headers.get('x-relay-secret') ?? ''
  if (RELAY_SECRET && secret !== RELAY_SECRET) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const {
    sessionId,
    dbSessionId,
    providerUserId,
    providerKind,
    targetHost,
  } = await req.json().catch(() => ({}))

  const resolvedSessionId = dbSessionId ?? sessionId ?? null
  if (!resolvedSessionId || (!providerUserId && !targetHost)) {
    return NextResponse.json(
      { error: 'dbSessionId/sessionId plus providerUserId or targetHost required' },
      { status: 400 },
    )
  }

  const updatePayload: Record<string, unknown> = {}
  if (providerUserId) updatePayload.provider_id = providerUserId
  if (providerKind) updatePayload.provider_kind = providerKind
  if (targetHost) updatePayload.target_host = targetHost

  const { error, count } = await adminClient
    .from('sessions')
    .update(updatePayload, { count: 'exact' })
    .eq('id', resolvedSessionId)
    .in('status', ['active', 'ended'])

  if (error) {
    logSession('error', 'PATCH update failed', {
      sessionId,
      dbSessionId,
      resolvedSessionId,
      providerUserId,
      targetHost,
      error: error.message,
    })
    return NextResponse.json({ error: 'Could not update session metadata' }, { status: 500 })
  }

  if (!count) {
    logSession('warn', 'PATCH session row missing', {
      sessionId,
      dbSessionId,
      resolvedSessionId,
      providerUserId,
      targetHost,
    })
  }

  const { error: finalizeError } = await adminClient.rpc('finalize_session_accountability', {
    p_session_id: resolvedSessionId,
    p_provider_id: providerUserId ?? null,
    p_provider_country: null,
    p_bytes_used: 0,
    p_target_host: targetHost ?? null,
  })

  if (finalizeError) {
    logSession('warn', 'PATCH accountability finalize failed', {
      resolvedSessionId,
      providerUserId,
      targetHost,
      error: finalizeError.message,
    })
  }

  return NextResponse.json({ ok: true, updated: count ?? 0 })
}

export async function POST(req: Request) {
  const relaySecret = req.headers.get('x-relay-secret') ?? ''
  const isRelay = RELAY_SECRET !== '' && relaySecret === RELAY_SECRET

  let userId: string | null = null

  if (!isRelay) {
    const supabase = await createClient()
    let user = (await supabase.auth.getUser()).data.user
    if (!user) {
      const auth = req.headers.get('authorization') ?? ''
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
      if (token) user = (await adminClient.auth.getUser(token)).data.user ?? null
    }
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    userId = user.id
  }

  const {
    sessionId,
    bytesUsed = 0,
    providerUserId,
    requesterUserId,
    country,
    targetHost,
    providerKind,
  } = await req.json().catch(() => ({}))

  if (!sessionId) return NextResponse.json({ error: 'sessionId is required' }, { status: 400 })

  const resolvedRequesterId = isRelay ? (requesterUserId ?? null) : userId
  const resolvedProviderId = providerUserId ?? null

  const { data: session, error: sessionLookupError } = await adminClient
    .from('sessions')
    .select('provider_id, provider_kind, target_country, target_host, user_id, status, bytes_used')
    .eq('id', sessionId)
    .maybeSingle()

  if (sessionLookupError) {
    logSession('error', 'POST lookup failed', { sessionId, error: sessionLookupError.message })
    return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  }

  const finalProviderId = resolvedProviderId ?? session?.provider_id ?? null
  const finalRequesterId = resolvedRequesterId ?? session?.user_id ?? null
  const finalCountry = country ?? session?.target_country ?? null
  const resolvedProviderKind = providerKind ?? session?.provider_kind ?? null
  const resolvedTargetHost = targetHost ?? session?.target_host ?? null

  const sessionMetadataUpdate: Record<string, unknown> = {
    provider_id: finalProviderId,
    target_host: resolvedTargetHost,
  }
  if (resolvedProviderKind) sessionMetadataUpdate.provider_kind = resolvedProviderKind

  const { error, count } = await adminClient
    .from('sessions')
    .update({
      ...sessionMetadataUpdate,
      status: 'ended',
      ended_at: new Date().toISOString(),
      bytes_used: bytesUsed,
    }, { count: 'exact' })
    .eq('id', sessionId)
    .eq('status', 'active')

  if (error) {
    logSession('error', 'POST end update failed', {
      sessionId,
      providerUserId,
      targetHost,
      error: error.message,
    })
    return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  }

  if (count === 0) {
    const { error: metadataError } = await adminClient
      .from('sessions')
      .update(sessionMetadataUpdate)
      .eq('id', sessionId)

    if (metadataError) {
      logSession('warn', 'POST metadata fallback failed', {
        sessionId,
        providerUserId,
        targetHost,
        error: metadataError.message,
      })
    }
  }

  const shouldApplyCounters = count !== 0

  await Promise.all([
    shouldApplyCounters && bytesUsed > 0 && finalRequesterId
      ? adminClient.rpc('increment_bandwidth', { p_user_id: finalRequesterId, p_bytes: bytesUsed })
      : Promise.resolve(),

    shouldApplyCounters && bytesUsed > 0 && finalProviderId && !isRelay && resolvedProviderKind !== 'desktop' && resolvedProviderKind !== 'cli'
      ? adminClient.rpc('increment_bytes_shared', { p_user_id: finalProviderId, p_bytes: bytesUsed })
      : Promise.resolve(),

    adminClient.rpc('finalize_session_accountability', {
      p_session_id: sessionId,
      p_provider_id: finalProviderId,
      p_provider_country: finalCountry,
      p_bytes_used: bytesUsed,
      p_target_host: resolvedTargetHost,
    }),

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
    relay: isRelay,
    finalProviderId,
    finalRequesterId,
    finalCountry,
    resolvedProviderKind,
    resolvedTargetHost,
    bytesUsed,
    updatedActiveRow: count ?? 0,
  })

  return NextResponse.json({ success: true })
}
