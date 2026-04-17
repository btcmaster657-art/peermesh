import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'
import { verifyDesktopToken } from '@/lib/desktop-token'

const RELAY_SECRET = process.env.RELAY_SECRET ?? ''

async function resolveUserId(req: Request, bodyUserId?: string): Promise<string | null> {
  const relaySecret = req.headers.get('x-relay-secret') ?? ''
  if (RELAY_SECRET && relaySecret === RELAY_SECRET) return bodyUserId ?? null

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (user) return user.id

  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!token) return null

  const fromDesktop = verifyDesktopToken(token)
  if (fromDesktop) return fromDesktop

  const { data } = await adminClient.auth.getUser(token)
  return data.user?.id ?? null
}

// ── GET: fetch fresh profile stats (extension polls this) ──────────────────
export async function GET(req: Request) {
  const userId = await resolveUserId(req)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data, error } = await adminClient
    .from('profiles')
    .select('total_bytes_shared, total_bytes_used, bandwidth_used_month, bandwidth_limit, trust_score, is_sharing')
    .eq('id', userId)
    .single()

  if (error || !data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(data)
}

// ── POST: set is_sharing flag OR increment bytes (desktop provider) ───────────
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))

  // Desktop bandwidth report: { bytes: number }
  if (typeof body.bytes === 'number' && body.bytes > 0) {
    const userId = await resolveUserId(req)
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    await adminClient.rpc('increment_bytes_shared', { p_user_id: userId, p_bytes: body.bytes })
    return NextResponse.json({ ok: true })
  }

  // Web dashboard: { isSharing: boolean }
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  if (typeof body.isSharing !== 'boolean') {
    return NextResponse.json({ error: 'isSharing must be boolean' }, { status: 400 })
  }

  await adminClient.from('profiles').update({ is_sharing: body.isSharing }).eq('id', user.id)
  return NextResponse.json({ success: true, isSharing: body.isSharing })
}

// ── PUT: provider heartbeat ───────────────────────────────────────────────────
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
