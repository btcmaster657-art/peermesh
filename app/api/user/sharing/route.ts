import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'
import { verifyDesktopToken } from '@/lib/desktop-token'

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { isSharing } = await req.json()
  if (typeof isSharing !== 'boolean') {
    return NextResponse.json({ error: 'isSharing must be boolean' }, { status: 400 })
  }

  await adminClient
    .from('profiles')
    .update({ is_sharing: isSharing })
    .eq('id', user.id)

  return NextResponse.json({ success: true, isSharing })
}

// ── PUT: desktop heartbeat ────────────────────────────────────────────────────
export async function PUT(req: Request) {
  const body = await req.json().catch(() => ({}))
  const { device_id, country } = body

  if (!device_id || !country) {
    return NextResponse.json({ error: 'device_id and country required' }, { status: 400 })
  }

  let userId: string | null = null

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (user) {
    userId = user.id
  } else {
    const auth = req.headers.get('authorization') ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    if (token) {
      // Try desktop token first (fast, no network)
      const desktopUserId = verifyDesktopToken(token)
      if (desktopUserId) {
        userId = desktopUserId
      } else {
        // Fall back to supabase token
        const { data } = await adminClient.auth.getUser(token)
        userId = data.user?.id ?? null
      }
    }
  }

  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  await adminClient.rpc('upsert_provider_heartbeat', {
    p_user_id: userId,
    p_device_id: device_id,
    p_country: country,
  })

  return NextResponse.json({ ok: true })
}

// ── DELETE: device stopped sharing ───────────────────────────────────────────
export async function DELETE(req: Request) {
  const body = await req.json().catch(() => ({}))
  const { device_id } = body

  if (!device_id) return NextResponse.json({ error: 'device_id required' }, { status: 400 })

  let userId: string | null = null

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (user) {
    userId = user.id
  } else {
    const auth = req.headers.get('authorization') ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    if (token) {
      const desktopUserId = verifyDesktopToken(token)
      if (desktopUserId) {
        userId = desktopUserId
      } else {
        const { data } = await adminClient.auth.getUser(token)
        userId = data.user?.id ?? null
      }
    }
  }

  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  await adminClient.rpc('remove_provider_device', {
    p_user_id: userId,
    p_device_id: device_id,
  })

  return NextResponse.json({ ok: true })
}
