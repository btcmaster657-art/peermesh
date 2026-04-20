import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'
import { isUserTrusted } from '@/lib/traffic-filter'
import { createHmac } from 'crypto'
import { isPrivateShareActive, normalizePrivateShareCode } from '@/lib/private-sharing'
import { pickRelay, getRelayFallbackList, relayHttpUrl, RELAY_ENDPOINTS } from '@/lib/relay-endpoints'

const RECEIPT_SECRET = process.env.RELAY_SECRET ?? process.env.RECEIPT_SECRET ?? 'dev-secret'

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

  const body = await req.json().catch(() => ({}))
  const hasPrivateCode = body.privateCode !== undefined
  const privateCode = normalizePrivateShareCode(body.privateCode)
  let country = typeof body.country === 'string' ? body.country.trim().toUpperCase() : ''
  if (!country && !hasPrivateCode) {
    return NextResponse.json({ error: 'country or privateCode is required' }, { status: 400 })
  }
  if (hasPrivateCode && !privateCode) {
    return NextResponse.json({ error: 'Private code must be exactly 9 digits' }, { status: 400 })
  }

  const { data: profile } = await adminClient
    .from('profiles')
    .select('trust_score, is_verified, is_premium, is_sharing, bandwidth_used_month, bandwidth_limit, preferred_providers')
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
  if (!profile.is_premium && !profile.is_sharing) {
    return NextResponse.json({ error: 'FREE TIER — Enable sharing above to connect, or upgrade to premium to browse without sharing.' }, { status: 403 })
  }

  const [relay, fallbackList] = await Promise.all([pickRelay(), getRelayFallbackList()])
  try { await adminClient.rpc('cleanup_stale_sessions') } catch {}

  let preferredProviderUserId = (profile.preferred_providers as Record<string, string>)?.[country] ?? null
  let privateProviderUserId: string | null = null
  let privateBaseDeviceId: string | null = null

  if (hasPrivateCode) {
    const { data: privateShare, error: privateShareError } = await adminClient
      .from('private_share_devices')
      .select('user_id, base_device_id, enabled, expires_at')
      .eq('share_code', privateCode)
      .maybeSingle()

    if (privateShareError) {
      return NextResponse.json({ error: 'Could not validate private share code' }, { status: 500 })
    }
    if (!privateShare || !isPrivateShareActive(privateShare.enabled, privateShare.expires_at)) {
      return NextResponse.json({ error: 'Private share code is invalid or expired' }, { status: 404 })
    }
    if (privateShare.user_id === user.id) {
      return NextResponse.json({ error: 'You cannot connect to your own private share code' }, { status: 400 })
    }

    // Check all relays in parallel for the private provider — relay is authoritative, DB heartbeat can lag
    let relayOnline = false
    let relayCountry: string | null = null
    const qs = new URLSearchParams({ baseDeviceId: privateShare.base_device_id, providerUserId: privateShare.user_id })
    const secret = process.env.RELAY_SECRET ?? ''
    await Promise.all(RELAY_ENDPOINTS.map(async (wsUrl) => {
      if (relayOnline) return
      try {
        const r = await fetch(`${relayHttpUrl(wsUrl)}/check-private?${qs}`, {
          headers: { 'x-relay-secret': secret },
          signal: AbortSignal.timeout(3000),
        })
        if (r.ok) {
          const d = await r.json()
          if (d.online) { relayOnline = true; relayCountry = d.country ?? null }
        }
      } catch {}
    }))

    if (!relayOnline) {
      return NextResponse.json({ error: 'Private share is currently offline' }, { status: 409 })
    }

    if (relayCountry) country = relayCountry
    privateProviderUserId = privateShare.user_id
    privateBaseDeviceId = privateShare.base_device_id
    preferredProviderUserId = privateShare.user_id
  }

  if (!country) return NextResponse.json({ error: 'country is required' }, { status: 400 })

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

  return NextResponse.json({
    sessionId: session.id,
    relayEndpoint: relay,
    relayFallbackList: fallbackList,
    receipt,
    country,
    preferredProviderUserId,
    privateProviderUserId,
    privateBaseDeviceId,
  })
}
