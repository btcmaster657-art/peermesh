import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'

const RELAY_SECRET = process.env.RELAY_SECRET ?? ''

// ── PATCH: relay assigns provider to session ──────────────────────────────────
export async function PATCH(req: Request) {
  const secret = req.headers.get('x-relay-secret') ?? ''
  if (RELAY_SECRET && secret !== RELAY_SECRET) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { sessionId, providerUserId } = await req.json().catch(() => ({}))
  if (!sessionId || !providerUserId) {
    return NextResponse.json({ error: 'sessionId and providerUserId required' }, { status: 400 })
  }

  await adminClient
    .from('sessions')
    .update({ provider_id: providerUserId })
    .eq('id', sessionId)
    .eq('status', 'active')

  await adminClient.rpc('finalize_session_accountability', {
    p_session_id: sessionId,
    p_provider_id: providerUserId,
    p_provider_country: null,
    p_bytes_used: 0,
  })

  return NextResponse.json({ ok: true })
}

// ── POST: end session ─────────────────────────────────────────────────────────
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

  const { sessionId, bytesUsed = 0, providerUserId, requesterUserId, country, targetHost } = await req.json()
  if (!sessionId) return NextResponse.json({ error: 'sessionId is required' }, { status: 400 })

  const resolvedRequesterId = isRelay ? (requesterUserId ?? null) : userId
  const resolvedProviderId = providerUserId ?? null

  const { data: session } = await adminClient
    .from('sessions')
    .select('provider_id, target_country, user_id')
    .eq('id', sessionId)
    .single()

  const finalProviderId = resolvedProviderId ?? session?.provider_id ?? null
  const finalRequesterId = resolvedRequesterId ?? session?.user_id ?? null
  const finalCountry = country ?? session?.target_country ?? null

  const { error } = await adminClient
    .from('sessions')
    .update({
      status: 'ended',
      ended_at: new Date().toISOString(),
      bytes_used: bytesUsed,
    })
    .eq('id', sessionId)

  if (error) return NextResponse.json({ error: 'Session not found' }, { status: 404 })

  // Run all DB updates in parallel
  await Promise.all([
    // Increment requester bandwidth
    bytesUsed > 0 && finalRequesterId
      ? adminClient.rpc('increment_bandwidth', { p_user_id: finalRequesterId, p_bytes: bytesUsed })
      : Promise.resolve(),

    // Credit provider bytes (non-relay only — desktop uses flushStats)
    bytesUsed > 0 && finalProviderId && !isRelay
      ? adminClient.rpc('increment_bytes_shared', { p_user_id: finalProviderId, p_bytes: bytesUsed })
      : Promise.resolve(),

    // Finalize accountability row
    adminClient.rpc('finalize_session_accountability', {
      p_session_id: sessionId,
      p_provider_id: finalProviderId,
      p_provider_country: finalCountry,
      p_bytes_used: bytesUsed,
      p_target_host: targetHost ?? null,
    }),

    // Persist peer affinity — save provider userId as preferred for this requester+country
    // This survives relay restarts and scales across multiple relay instances
    finalRequesterId && finalProviderId && finalCountry
      ? adminClient.rpc('set_preferred_provider', {
          p_user_id: finalRequesterId,
          p_country: finalCountry,
          p_provider_user_id: finalProviderId,
        })
      : Promise.resolve(),
  ])

  return NextResponse.json({ success: true })
}
