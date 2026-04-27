import { NextResponse } from 'next/server'
import { verifyDesktopToken } from '@/lib/desktop-token'
import { adminClient } from '@/lib/supabase/admin'

const RELAY_SECRET = process.env.RELAY_SECRET ?? ''

type RequesterSessionRow = {
  id: string
  user_id: string
  status: string
  target_country: string | null
  provider_id: string | null
  provider_base_device_id: string | null
}

async function resolveTokenUserId(token: string): Promise<{ userId: string | null; tokenKind: 'supabase' | 'desktop' | null }> {
  const desktopUserId = verifyDesktopToken(token)
  if (desktopUserId) return { userId: desktopUserId, tokenKind: 'desktop' }

  try {
    const { data } = await adminClient.auth.getUser(token)
    return {
      userId: data.user?.id ?? null,
      tokenKind: data.user?.id ? 'supabase' : null,
    }
  } catch {
    return { userId: null, tokenKind: null }
  }
}

export async function POST(req: Request) {
  const secret = req.headers.get('x-relay-secret') ?? ''
  if (!RELAY_SECRET || secret !== RELAY_SECRET) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const token = typeof body.token === 'string' ? body.token.trim() : ''
  const expectedUserId = typeof body.userId === 'string' ? body.userId.trim() : ''
  const role = body.role === 'provider' ? 'provider' : body.role === 'requester' ? 'requester' : null

  if (!token || !role) {
    return NextResponse.json({ error: 'token and role are required' }, { status: 400 })
  }

  const { userId, tokenKind } = await resolveTokenUserId(token)
  if (!userId || !tokenKind) {
    return NextResponse.json({ error: 'Invalid relay auth token' }, { status: 401 })
  }

  if (expectedUserId && expectedUserId !== userId) {
    return NextResponse.json({ error: 'Relay auth token does not match the claimed user' }, { status: 403 })
  }

  const { data: profile, error: profileError } = await adminClient
    .from('profiles')
    .select('trust_score')
    .eq('id', userId)
    .maybeSingle()

  if (profileError || !profile) {
    return NextResponse.json({ error: 'Profile not found' }, { status: 404 })
  }

  if (role === 'provider') {
    return NextResponse.json({
      ok: true,
      userId,
      tokenKind,
      trustScore: Number(profile.trust_score ?? 50),
    })
  }

  const dbSessionId = typeof body.dbSessionId === 'string' ? body.dbSessionId.trim() : ''
  if (!dbSessionId) {
    return NextResponse.json({ error: 'dbSessionId is required for requesters' }, { status: 400 })
  }

  const { data: session, error: sessionError } = await adminClient
    .from('sessions')
    .select('id, user_id, status, target_country, provider_id, provider_base_device_id')
    .eq('id', dbSessionId)
    .maybeSingle()

  if (sessionError || !session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  }

  const sessionRow = session as RequesterSessionRow

  if (sessionRow.user_id !== userId) {
    return NextResponse.json({ error: 'Session does not belong to this user' }, { status: 403 })
  }

  if (!['pending', 'active'].includes(sessionRow.status)) {
    return NextResponse.json({ error: 'Session is no longer active' }, { status: 409 })
  }

  const requestedCountry = typeof body.country === 'string' ? body.country.trim().toUpperCase() : ''
  if (requestedCountry && sessionRow.target_country && requestedCountry !== sessionRow.target_country) {
    return NextResponse.json({ error: 'Requested country does not match the authorized session' }, { status: 403 })
  }

  const requestedPrivateProviderUserId = typeof body.privateProviderUserId === 'string'
    ? body.privateProviderUserId.trim()
    : ''
  const requestedPrivateBaseDeviceId = typeof body.privateBaseDeviceId === 'string'
    ? body.privateBaseDeviceId.trim()
    : ''

  const authorizedPrivateProviderUserId = sessionRow.provider_id ?? ''
  const authorizedPrivateBaseDeviceId = sessionRow.provider_base_device_id ?? ''
  const sessionIsPrivate = !!authorizedPrivateProviderUserId || !!authorizedPrivateBaseDeviceId

  if (sessionIsPrivate) {
    if (
      (requestedPrivateProviderUserId && requestedPrivateProviderUserId !== authorizedPrivateProviderUserId)
      || (requestedPrivateBaseDeviceId && requestedPrivateBaseDeviceId !== authorizedPrivateBaseDeviceId)
    ) {
      return NextResponse.json({ error: 'Private routing claim does not match the authorized session' }, { status: 403 })
    }
  } else if (requestedPrivateProviderUserId || requestedPrivateBaseDeviceId) {
    return NextResponse.json({ error: 'Private routing was not authorized for this session' }, { status: 403 })
  }

  return NextResponse.json({
    ok: true,
    userId,
    tokenKind,
    trustScore: Number(profile.trust_score ?? 50),
    country: sessionRow.target_country ?? requestedCountry,
    privateProviderUserId: authorizedPrivateProviderUserId || null,
    privateBaseDeviceId: authorizedPrivateBaseDeviceId || null,
  })
}
