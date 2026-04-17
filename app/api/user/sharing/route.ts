import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'
import { verifyDesktopToken } from '@/lib/desktop-token'

const RELAY_SECRET = process.env.RELAY_SECRET ?? ''

async function resolveUserId(req: Request, bodyUserId?: string): Promise<string | null> {
  // Relay-secret path (server-to-server, no user token needed)
  const relaySecret = req.headers.get('x-relay-secret') ?? ''
  if (RELAY_SECRET && relaySecret === RELAY_SECRET) return bodyUserId ?? null

  // Cookie session (web dashboard)
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (user) return user.id

  // Bearer token (desktop app)
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!token) return null

  const fromDesktop = verifyDesktopToken(token)
  if (fromDesktop) return fromDesktop

  const { data } = await adminClient.auth.getUser(token)
  return data.user?.id ?? null
}

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { isSharing } = await req.json()
  if (typeof isSharing !== 'boolean') {
    return NextResponse.json({ error: 'isSharing must be boolean' }, { status: 400 })
  }

  await adminClient.from('profiles').update({ is_sharing: isSharing }).eq('id', user.id)
  return NextResponse.json({ success: true, isSharing })
}

// ── PUT: provider heartbeat ───────────────────────────────────────────────────
// Accepts x-relay-secret (relay → DB) or Authorization: Bearer <token> (desktop)
export async function PUT(req: Request) {
  const body = await req.json().catch(() => ({}))
  const { device_id, country, user_id } = body

  if (!device_id || !country) {
    return NextResponse.json({ error: 'device_id and country required' }, { status: 400 })
  }

  const userId = await resolveUserId(req, user_id)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { error: rpcError } = await adminClient.rpc('upsert_provider_heartbeat', {
    p_user_id: userId,
    p_device_id: device_id,
    p_country: country,
  })

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

  return NextResponse.json({ ok: true })
}
