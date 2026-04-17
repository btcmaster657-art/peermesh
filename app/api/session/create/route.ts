import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'
import { isUserTrusted } from '@/lib/traffic-filter'
import { createHmac } from 'crypto'

const RELAY_ENDPOINTS = (process.env.RELAY_ENDPOINTS ?? 'ws://localhost:8080').split(',')
const RECEIPT_SECRET = process.env.RELAY_SECRET ?? process.env.RECEIPT_SECRET ?? 'dev-secret'

let relayIndex = 0
function pickRelay(): string {
  const endpoint = RELAY_ENDPOINTS[relayIndex % RELAY_ENDPOINTS.length]
  relayIndex++
  return endpoint
}

export function issueAccountabilityReceipt(payload: {
  sessionId: string
  requesterId: string
  country: string
  timestamp: number
}): string {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = createHmac('sha256', RECEIPT_SECRET).update(data).digest('base64url')
  return `${data}.${sig}`
}

export function verifyAccountabilityReceipt(receipt: string): {
  valid: boolean
  payload?: { sessionId: string; requesterId: string; country: string; timestamp: number }
} {
  try {
    const [data, sig] = receipt.split('.')
    const expected = createHmac('sha256', RECEIPT_SECRET).update(data).digest('base64url')
    if (sig !== expected) return { valid: false }
    return { valid: true, payload: JSON.parse(Buffer.from(data, 'base64url').toString()) }
  } catch {
    return { valid: false }
  }
}

export async function POST(req: Request) {
  const supabase = await createClient()
  let user = (await supabase.auth.getUser()).data.user

  if (!user) {
    const auth = req.headers.get('authorization') ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    if (token) user = (await adminClient.auth.getUser(token)).data.user ?? null
  }
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { country } = await req.json()
  if (!country) return NextResponse.json({ error: 'country is required' }, { status: 400 })

  const { data: profile } = await adminClient
    .from('profiles')
    .select('trust_score, is_verified, is_premium, bandwidth_used_month, bandwidth_limit, preferred_providers')
    .eq('id', user.id)
    .single()

  if (!profile?.is_verified)
    return NextResponse.json({ error: 'Account not verified' }, { status: 403 })
  if (!isUserTrusted(profile.trust_score))
    return NextResponse.json({ error: 'Account suspended due to low trust score' }, { status: 403 })
  if (profile.bandwidth_used_month >= profile.bandwidth_limit)
    return NextResponse.json({ error: 'Monthly bandwidth limit reached. Upgrade to premium.' }, { status: 403 })

  const relay = pickRelay()
  try { await adminClient.rpc('cleanup_stale_sessions') } catch {}

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

  if (sessionError || !session)
    return NextResponse.json({ error: 'Failed to create session' }, { status: 500 })

  const receipt = issueAccountabilityReceipt({
    sessionId: session.id,
    requesterId: user.id,
    country,
    timestamp: Date.now(),
  })

  await adminClient.from('session_accountability').insert({
    session_id: session.id,
    requester_id: user.id,
    provider_country: country,
    bytes_used: 0,
    signed_receipt: receipt,
  })

  await adminClient
    .from('sessions')
    .update({ signed_receipt: receipt })
    .eq('id', session.id)

  // Read preferred provider for this country from DB — passed to relay for affinity matching
  const preferredProviderUserId = (profile.preferred_providers as Record<string, string>)?.[country] ?? null

  return NextResponse.json({
    sessionId: session.id,
    relayEndpoint: relay,
    receipt,
    preferredProviderUserId,
  })
}
