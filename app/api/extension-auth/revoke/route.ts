import { NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { revokeDeviceSession, revokeUserDeviceSessions, resolveBearerUser } from '@/lib/device-sessions'
import { createClient } from '@/lib/supabase/server'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS })
}

export async function GET(req: Request) {
  const ext_id = new URL(req.url).searchParams.get('ext_id')
  if (!ext_id) return NextResponse.json({ error: 'Missing ext_id' }, { status: 400, headers: CORS })
  await adminClient.from('extension_auth_tokens').update({ used: true, refresh_token: null }).eq('ext_id', ext_id)
  return NextResponse.json({ ok: true }, { headers: CORS })
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const ext_id = body.ext_id ?? new URL(req.url).searchParams.get('ext_id') ?? null
  const userId = typeof body.userId === 'string' ? body.userId : null
  const deviceSessionId = typeof body.deviceSessionId === 'string' ? body.deviceSessionId : null

  let callerId: string | null = null
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (token) {
    callerId = (await resolveBearerUser(token)).userId
  }
  if (!callerId) {
    const supabase = await createClient()
    callerId = (await supabase.auth.getUser()).data.user?.id ?? null
  }

  if (ext_id) {
    await adminClient
      .from('extension_auth_tokens')
      .update({ used: true, refresh_token: null })
      .eq('ext_id', ext_id)
  }

  if (deviceSessionId && callerId) {
    const { data: session } = await adminClient
      .from('device_sessions')
      .select('user_id')
      .eq('id', deviceSessionId)
      .maybeSingle<{ user_id: string }>()

    if (session?.user_id === callerId) {
      await revokeDeviceSession(deviceSessionId)
    }
  }

  if (userId && callerId && callerId === userId) {
    await revokeUserDeviceSessions(userId)
    await adminClient
      .from('device_codes')
      .update({ status: 'revoked', refresh_token: null })
      .eq('user_id', userId)
      .in('status', ['pending', 'approved'])
  }

  return NextResponse.json({ ok: true }, { headers: CORS })
}
