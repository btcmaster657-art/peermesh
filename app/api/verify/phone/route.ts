import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'
import {
  checkPhoneVerificationCode,
  isPhoneVerificationBypassEnabled,
  isTwilioVerifyConfigured,
  normalizePhoneNumber,
  sendPhoneVerificationCode,
} from '@/lib/phone-verification'

const BYPASS = isPhoneVerificationBypassEnabled()

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
    const normalizedPhone = typeof phone === 'string' ? normalizePhoneNumber(phone) : null
    if (!normalizedPhone) {
      return NextResponse.json({ error: 'Phone number must be in E.164 format, for example +14155550123' }, { status: 400 })
    }

    await adminClient
      .from('profiles')
      .update({
        phone_number: normalizedPhone,
        is_verified: false,
        verified_at: null,
      })
      .eq('id', user.id)

    if (BYPASS) {
      return NextResponse.json({ success: true, bypass: true })
    }

    if (!isTwilioVerifyConfigured()) {
      return NextResponse.json({ error: 'Phone verification is not configured on the server' }, { status: 503 })
    }

    const sent = await sendPhoneVerificationCode(normalizedPhone)
    if (!sent.ok) {
      return NextResponse.json({ error: sent.error ?? 'Could not send verification code' }, { status: sent.status >= 400 ? sent.status : 502 })
    }

    return NextResponse.json({ success: true })
  }

  if (action === 'verify') {
    const normalizedCode = typeof code === 'string' ? code.replace(/\D/g, '').slice(0, 10) : ''
    if (!normalizedCode) {
      return NextResponse.json({ error: 'Verification code is required' }, { status: 400 })
    }

    const { data: profile } = await adminClient
      .from('profiles')
      .select('phone_number')
      .eq('id', user.id)
      .maybeSingle<{ phone_number: string | null }>()

    const storedPhone = typeof profile?.phone_number === 'string'
      ? normalizePhoneNumber(profile.phone_number)
      : null
    if (!storedPhone) {
      return NextResponse.json({ error: 'Send a verification code before confirming it' }, { status: 400 })
    }

    if (BYPASS) {
      if (normalizedCode !== '123456') return NextResponse.json({ error: 'Use 123456 in test mode' }, { status: 400 })
      await adminClient
        .from('profiles')
        .update({ is_verified: true, verified_at: new Date().toISOString() })
        .eq('id', user.id)
      return NextResponse.json({ success: true, bypass: true })
    }

    if (!isTwilioVerifyConfigured()) {
      return NextResponse.json({ error: 'Phone verification is not configured on the server' }, { status: 503 })
    }

    const checked = await checkPhoneVerificationCode(storedPhone, normalizedCode)
    if (!checked.ok) {
      return NextResponse.json({ error: checked.error ?? 'Could not verify code' }, { status: checked.status >= 400 ? checked.status : 502 })
    }
    if (!checked.approved) {
      return NextResponse.json({ error: 'Verification code is invalid or expired' }, { status: 400 })
    }

    await adminClient
      .from('profiles')
        .update({ is_verified: true, verified_at: new Date().toISOString() })
      .eq('id', user.id)
    return NextResponse.json({ success: true })
  }

  return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
}
