import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'
import { isUserTrusted } from '@/lib/traffic-filter'
import { resolveBearerUser } from '@/lib/device-sessions'
import { createHmac } from 'crypto'
import { isPrivateShareActive, normalizePrivateShareCode } from '@/lib/private-sharing'
import { getRelayFallbackList, relayHttpUrl, RELAY_ENDPOINTS } from '@/lib/relay-endpoints'
import { buildOccupiedProviderDeviceSet, filterAvailableProviderDevices } from '@/lib/provider-capacity'
import { getConnectionAccessRequirement } from '@/lib/account-access'

function getReceiptSecret(): string {
  const secret = process.env.RECEIPT_SECRET ?? process.env.RELAY_SECRET ?? ''
  if (!secret) {
    throw new Error('RECEIPT_SECRET is not configured')
  }
  return secret
}

export function issueAccountabilityReceipt(payload: {
  sessionId: string
  requesterId: string
  country: string
  timestamp: number
}): string {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = createHmac('sha256', getReceiptSecret()).update(data).digest('base64url')
  return `${data}.${sig}`
}

export function verifyAccountabilityReceipt(receipt: string): {
  valid: boolean
  payload?: { sessionId: string; requesterId: string; country: string; timestamp: number }
} {
  try {
    const [data, sig] = receipt.split('.')
    const expected = createHmac('sha256', getReceiptSecret()).update(data).digest('base64url')
    if (sig !== expected) return { valid: false }
    return { valid: true, payload: JSON.parse(Buffer.from(data, 'base64url').toString()) }
  } catch {
    return { valid: false }
  }
}

function toBaseDeviceId(deviceKey: string): string {
  const match = /^(.*)_slot_\d+$/.exec(deviceKey)
  return match?.[1] ?? deviceKey
}

function orderRelayCandidates(
  candidates: string[],
  orderedRelays: string[],
  preferredRelays: string[] = [],
): string[] {
  const dedupedCandidates = [...new Set(candidates.filter(Boolean))]
  if (dedupedCandidates.length === 0) return []

  const candidateSet = new Set(dedupedCandidates)
  const preferredSet = new Set(preferredRelays.filter(relay => candidateSet.has(relay)))

  return [
    ...orderedRelays.filter(relay => preferredSet.has(relay)),
    ...orderedRelays.filter(relay => candidateSet.has(relay) && !preferredSet.has(relay)),
    ...dedupedCandidates.filter(relay => !orderedRelays.includes(relay) && preferredSet.has(relay)),
    ...dedupedCandidates.filter(relay => !orderedRelays.includes(relay) && !preferredSet.has(relay)),
  ]
}

export async function POST(req: Request) {
  const supabase = await createClient()
  const sessionUser = (await supabase.auth.getUser()).data.user ?? null
  let userId = sessionUser?.id ?? null
  let emailConfirmed = !!sessionUser?.email_confirmed_at

  if (!userId) {
    const auth = req.headers.get('authorization') ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    if (token) {
      const resolved = await resolveBearerUser(token)
      if (resolved.authKind === 'supabase') {
        const tokenUser = (await adminClient.auth.getUser(token)).data.user ?? null
        userId = tokenUser?.id ?? null
        emailConfirmed = !!tokenUser?.email_confirmed_at
      } else if (resolved.authKind === 'desktop') {
        userId = resolved.userId
        emailConfirmed = !!resolved.userId
      }
    }
  }
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!emailConfirmed) {
    return NextResponse.json({
      error: 'Confirm your email before connecting.',
      code: 'email_confirmation_required',
      nextStep: '/auth/confirm-email',
    }, { status: 403 })
  }

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
    .select('trust_score, is_verified, is_sharing, bandwidth_used_month, bandwidth_limit, preferred_providers, wallet_balance_usd, contribution_credits_bytes')
    .eq('id', userId)
    .single()

  const activeProfile = profile
  if (!activeProfile) {
    return NextResponse.json({ error: 'Profile not found' }, { status: 404 })
  }
  const accessRequirement = getConnectionAccessRequirement(activeProfile, {
    mode: hasPrivateCode ? 'private' : 'public',
  })
  if (!accessRequirement.ok) {
    return NextResponse.json({
      error: accessRequirement.error,
      code: accessRequirement.code,
      nextStep: accessRequirement.nextStep,
    }, { status: 403 })
  }
  if (!isUserTrusted(activeProfile.trust_score)) {
    return NextResponse.json({ error: 'Account suspended due to low trust score' }, { status: 403 })
  }
  if (activeProfile.bandwidth_used_month >= activeProfile.bandwidth_limit) {
    return NextResponse.json({ error: 'Monthly bandwidth limit reached. Wait for reset or fund your USD wallet for higher usage.' }, { status: 403 })
  }

  // Query live provider devices for this country to build a targeted relay list.
  // provider_devices.relay_url tells us exactly which relay each slot is on.
  // We exclude the requester's own devices. Private share paths skip this DB lookup.
  const cutoff = new Date(Date.now() - 45_000).toISOString()
  const orderedRelays = await getRelayFallbackList()

  let providerRelayUrls: string[] = []
  let preferredProviderUserId = (activeProfile.preferred_providers as Record<string, string>)?.[country] ?? null
  let privateProviderUserId: string | null = null
  let privateBaseDeviceId: string | null = null

  if (!hasPrivateCode) {
    const { data: liveProviders } = await adminClient
      .from('provider_devices')
      .select('user_id, relay_url, device_id, country_code')
      .eq('country_code', country)
      .neq('user_id', userId)
      .gt('last_heartbeat', cutoff)
      .not('relay_url', 'is', null)

    const providerUserIds = [...new Set((liveProviders ?? []).map(row => row.user_id).filter(Boolean) as string[])]
    let publicProviders = liveProviders ?? []

    if (providerUserIds.length > 0) {
      const { data: privateRows } = await adminClient
        .from('private_share_devices')
        .select('user_id, base_device_id, enabled, expires_at')
        .in('user_id', providerUserIds)

      const activePrivateRows = (privateRows ?? []).filter(row =>
        isPrivateShareActive(row.enabled, row.expires_at),
      )

      publicProviders = (liveProviders ?? []).filter((row) => {
        return !activePrivateRows.some((privateRow) => {
          if (privateRow.user_id !== row.user_id) return false
          if (privateRow.base_device_id === row.device_id) return true
          return !privateRow.base_device_id.includes('_slot_')
            && row.device_id?.startsWith(`${privateRow.base_device_id}_slot_`)
        })
      })
    }

    const publicDeviceIds = publicProviders.map((row) => row.device_id).filter(Boolean)
    if (publicDeviceIds.length > 0) {
      const { data: activeSessions } = await adminClient
        .from('sessions')
        .select('provider_device_id')
        .eq('status', 'active')
        .in('provider_device_id', publicDeviceIds)
      const occupiedDevices = buildOccupiedProviderDeviceSet(activeSessions)
      publicProviders = filterAvailableProviderDevices(publicProviders, occupiedDevices)
    }

    const rawRelayUrls = [...new Set(publicProviders.map(row => row.relay_url).filter(Boolean) as string[])]
    const hasAnyProvider = publicProviders.length > 0

    if (!hasAnyProvider) {
      return NextResponse.json({ error: `No peers available in ${country}` }, { status: 409 })
    }

    if (rawRelayUrls.length > 0) {
      const preferredRelayUrls = publicProviders
        .filter(row => row.user_id === preferredProviderUserId && !!row.relay_url)
        .map(row => row.relay_url as string)
      providerRelayUrls = orderRelayCandidates(rawRelayUrls, orderedRelays, preferredRelayUrls)
    } else {
      // Providers exist but some older rows may not have relay_url yet.
      providerRelayUrls = orderedRelays
    }
  }

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
    if (privateShare.user_id === userId) {
      return NextResponse.json({ error: 'You cannot connect to your own private share code' }, { status: 400 })
    }

    // Check all relays in parallel for the private provider - the relay is authoritative.
    const privateDeviceKey = privateShare.base_device_id
    const privateBaseKey = toBaseDeviceId(privateDeviceKey)
    const onlineRelays: string[] = []
    let relayCountry: string | null = null
    const secret = process.env.RELAY_SECRET ?? ''

    await Promise.all(RELAY_ENDPOINTS.map(async (wsUrl) => {
      try {
        const qs = new URLSearchParams({
          providerUserId: privateShare.user_id,
          deviceId: privateDeviceKey,
          baseDeviceId: privateBaseKey,
        })
        const r = await fetch(`${relayHttpUrl(wsUrl)}/check-private?${qs}`, {
          headers: { 'x-relay-secret': secret },
          signal: AbortSignal.timeout(3000),
        })
        if (!r.ok) return
        const d = await r.json()
        if (d.online) {
          onlineRelays.push(wsUrl)
          relayCountry = d.country ?? relayCountry ?? null
        }
      } catch {}
    }))

    if (onlineRelays.length === 0) {
      return NextResponse.json({ error: 'Private share is currently offline' }, { status: 409 })
    }

    if (relayCountry) country = relayCountry
    preferredProviderUserId = privateShare.user_id
    privateProviderUserId = privateShare.user_id
    privateBaseDeviceId = privateDeviceKey
    providerRelayUrls = orderRelayCandidates(RELAY_ENDPOINTS, orderedRelays, onlineRelays)
  }

  if (!country) return NextResponse.json({ error: 'country is required' }, { status: 400 })

  const fallbackList = providerRelayUrls.length > 0 ? providerRelayUrls : orderedRelays
  const relay = fallbackList[0]

  try { await adminClient.rpc('cleanup_stale_sessions') } catch {}

  const { data: session, error: sessionError } = await adminClient
    .from('sessions')
    .insert({
      user_id: userId,
      provider_id: privateProviderUserId,
      provider_base_device_id: privateBaseDeviceId,
      target_country: country,
      relay_endpoint: relay,
      status: 'pending',
    })
    .select('id')
    .single()

  if (sessionError || !session) {
    return NextResponse.json({ error: 'Failed to create session' }, { status: 500 })
  }

  const receipt = issueAccountabilityReceipt({
    sessionId: session.id,
    requesterId: userId,
    country,
    timestamp: Date.now(),
  })

  // Store the signed receipt on the session row itself - sessions is the single source of truth.
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
