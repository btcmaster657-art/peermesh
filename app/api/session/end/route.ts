import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'

const RELAY_SECRET = process.env.RELAY_SECRET ?? ''

// ── PATCH: relay assigns provider to session ──────────────────────────────────
// Called by relay on agent_ready. No user auth — uses relay secret instead.
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

  return NextResponse.json({ ok: true })
}

// ── POST: end session ─────────────────────────────────────────────────────────
export async function POST(req: Request) {
  const supabase = await createClient()
  let user = (await supabase.auth.getUser()).data.user

  // Also accept Bearer token (extension has no cookie session)
  if (!user) {
    const auth = req.headers.get('authorization') ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    if (token) user = (await adminClient.auth.getUser(token)).data.user ?? null
  }
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { sessionId, bytesUsed = 0 } = await req.json()
  if (!sessionId) return NextResponse.json({ error: 'sessionId is required' }, { status: 400 })

  // Fetch session to get provider info before ending it
  const { data: session } = await adminClient
    .from('sessions')
    .select('provider_id, target_country')
    .eq('id', sessionId)
    .eq('user_id', user.id)
    .single()

  // End the session
  const { error } = await adminClient
    .from('sessions')
    .update({
      status: 'ended',
      ended_at: new Date().toISOString(),
      bytes_used: bytesUsed,
    })
    .eq('id', sessionId)
    .eq('user_id', user.id)

  if (error) return NextResponse.json({ error: 'Session not found' }, { status: 404 })

  // Update requester bandwidth usage
  if (bytesUsed > 0) {
    await adminClient.rpc('increment_bandwidth', {
      p_user_id: user.id,
      p_bytes: bytesUsed,
    })

    // Credit the provider's bytes shared
    const providerId = session?.provider_id
    if (providerId) {
      await adminClient.rpc('increment_bytes_shared', {
        p_user_id: providerId,
        p_bytes: bytesUsed,
      })
    }
  }

  return NextResponse.json({ success: true })
}
