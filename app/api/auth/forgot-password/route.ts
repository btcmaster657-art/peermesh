import { NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'

export async function POST(req: Request) {
  const { email } = await req.json().catch(() => ({}))
  if (!email || typeof email !== 'string') {
    return new NextResponse(JSON.stringify({ error: 'Email is required' }), { 
      status: 400,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    })
  }

  const normalizedEmail = email.trim().toLowerCase()

  // generateLink triggers Supabase to send the Reset Password email using the
  // template configured in the dashboard (Authentication → Email Templates →
  // Reset password). The template must use {{ .Token }} for the OTP code.
  // We intentionally ignore errors so we never reveal whether the email exists.
  await adminClient.auth.admin.generateLink({
    type: 'recovery',
    email: normalizedEmail,
  }).catch(() => {})

  return new NextResponse(JSON.stringify({ success: true }), { 
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  })
}
