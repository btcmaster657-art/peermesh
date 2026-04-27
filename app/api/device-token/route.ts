import { NextResponse } from 'next/server'
import { createDeviceSession } from '@/lib/device-sessions'
import { createClient } from '@/lib/supabase/server'

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!user.email_confirmed_at) {
    return NextResponse.json({ error: 'Confirm your email before issuing a desktop token.' }, { status: 403 })
  }

  const issued = await createDeviceSession({
    userId: user.id,
    actor: 'dashboard',
  })

  return NextResponse.json({
    token: issued.token,
    refreshToken: issued.refreshToken,
    deviceSessionId: issued.deviceSessionId,
    refreshExpiresAt: issued.refreshExpiresAt,
    userId: user.id,
  })
}
