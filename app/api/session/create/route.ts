import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'
import { isUserTrusted } from '@/lib/traffic-filter'

const RELAY_ENDPOINTS = (process.env.RELAY_ENDPOINTS ?? 'ws://localhost:8080').split(',')

// Simple round-robin index
let relayIndex = 0
function pickRelay(): string {
  const endpoint = RELAY_ENDPOINTS[relayIndex % RELAY_ENDPOINTS.length]
  relayIndex++
  return endpoint
}

function issueAccountabilityReceipt(payload: {
  sessionId: string
  requesterId: string
  country: string
  timestamp: number
}): string {
  // In production: sign with RS256 private key via jose
  // For now: base64-encoded JSON — replace with JWT signing when RELAY_PRIVATE_KEY is set
  return Buffer.from(JSON.stringify(payload)).toString('base64')
}

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

  const { country } = await req.json()
  if (!country) return NextResponse.json({ error: 'country is required' }, { status: 400 })

  // Check profile trust + verification
  const { data: profile } = await adminClient
    .from('profiles')
    .select('trust_score, is_verified, is_premium, bandwidth_used_month, bandwidth_limit')
    .eq('id', user.id)
    .single()

  if (!profile?.is_verified) {
    return NextResponse.json({ error: 'Account not verified' }, { status: 403 })
  }
  if (!isUserTrusted(profile.trust_score)) {
    return NextResponse.json({ error: 'Account suspended due to low trust score' }, { status: 403 })
  }
  if (profile.bandwidth_used_month >= profile.bandwidth_limit) {
    return NextResponse.json({ error: 'Monthly bandwidth limit reached. Upgrade to premium.' }, { status: 403 })
  }

  const relay = pickRelay()

  // Opportunistically clean up sessions stuck in active > 2h
  try { await adminClient.rpc('cleanup_stale_sessions') } catch {}

  // Create session row
  const { data: session, error: sessionError } = await adminClient
    .from('sessions')
    .insert({
      user_id: user.id,
      target_country: country,
      relay_endpoint: relay,
      status: 'active',
    })
    .select('id')
    .single()

  if (sessionError || !session) {
    return NextResponse.json({ error: 'Failed to create session' }, { status: 500 })
  }

  // Issue accountability receipt
  const receipt = issueAccountabilityReceipt({
    sessionId: session.id,
    requesterId: user.id,
    country,
    timestamp: Date.now(),
  })

  // Store in accountability log
  await adminClient.from('session_accountability').insert({
    session_id: session.id,
    requester_id: user.id,
    provider_country: country,
    signed_receipt: receipt,
  })

  // Update session with receipt
  await adminClient
    .from('sessions')
    .update({ signed_receipt: receipt })
    .eq('id', session.id)

  return NextResponse.json({
    sessionId: session.id,
    relayEndpoint: relay,
    receipt,
  })
}
