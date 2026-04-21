import { NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { randomInt } from 'crypto'

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://peermesh-beta.vercel.app'

function generate6DigitToken(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

export async function POST(req: Request) {
  const { email } = await req.json().catch(() => ({}))
  if (!email || typeof email !== 'string') {
    return NextResponse.json({ error: 'Email is required' }, { status: 400 })
  }

  const normalizedEmail = email.trim().toLowerCase()

  // Look up user — don't reveal whether email exists
  const { data: user } = await adminClient.auth.admin.listUsers()
  const matchedUser = user?.users?.find(u => u.email?.toLowerCase() === normalizedEmail)

  if (matchedUser) {
    const token = generate6DigitToken()
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString()

    // Invalidate previous unused tokens for this email+type
    await adminClient
      .from('auth_tokens')
      .update({ used: true })
      .eq('email', normalizedEmail)
      .eq('type', 'forgot_password')
      .eq('used', false)

    await adminClient.from('auth_tokens').insert({
      user_id:    matchedUser.id,
      email:      normalizedEmail,
      token,
      type:       'forgot_password',
      expires_at: expiresAt,
    })

    // Send email via Supabase (uses configured SMTP)
    await fetch(`${APP_URL}/api/auth/send-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to:      normalizedEmail,
        subject: 'Reset your PeerMesh password',
        html:    await buildForgotEmail(token),
      }),
    }).catch(() => {})
  }

  // Always return success to prevent email enumeration
  return NextResponse.json({ success: true })
}

async function buildForgotEmail(token: string): Promise<string> {
  const res = await fetch(`${APP_URL}/template/forgot?token=${token}`)
  if (res.ok) return res.text()
  return `<p>Your PeerMesh password reset code is: <strong>${token}</strong>. It expires in 15 minutes.</p>`
}
