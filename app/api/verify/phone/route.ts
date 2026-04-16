import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'

const BYPASS = process.env.NEXT_PUBLIC_BYPASS_VERIFICATION === 'true'

async function getUser(req: Request) {
  // Try cookie-based session first
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (user) return user

  // Fallback: Bearer token in Authorization header
  const authHeader = req.headers.get('authorization')
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7)
    const { data: { user: tokenUser } } = await adminClient.auth.getUser(token)
    return tokenUser ?? null
  }

  return null
}

export async function POST(req: Request) {
  const body = await req.json()
  const user = await getUser(req)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { action, phone, code } = body

  if (action === 'send') {
    await adminClient.from('profiles').update({ phone_number: phone }).eq('id', user.id)

    if (BYPASS) {
      return NextResponse.json({ success: true, bypass: true })
    }
    // TODO: await twilioClient.verify.v2.services(TWILIO_SERVICE_SID).verifications.create({ to: phone, channel: 'sms' })
    return NextResponse.json({ success: true })
  }

  if (action === 'verify') {
    if (BYPASS) {
      if (code !== '123456') return NextResponse.json({ error: 'Use 123456 in test mode' }, { status: 400 })
      return NextResponse.json({ success: true, bypass: true })
    }
    // TODO: check Twilio verification
    return NextResponse.json({ success: true })
  }

  return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
}
