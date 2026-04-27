import { NextResponse } from 'next/server'
import { createDeviceSession } from '@/lib/device-sessions'
import { createClient } from '@/lib/supabase/server'

export async function GET() {
  const supabase = await createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!session.user.email_confirmed_at) {
    return NextResponse.json({ error: 'Confirm your email before issuing a desktop token.' }, { status: 403 })
  }

  const issued = await createDeviceSession({
    userId: session.user.id,
    actor: 'dashboard',
  })

  return NextResponse.json({
    token: issued.token,
    refreshToken: issued.refreshToken,
    deviceSessionId: issued.deviceSessionId,
    refreshExpiresAt: issued.refreshExpiresAt,
    userId: session.user.id,
  })
}
