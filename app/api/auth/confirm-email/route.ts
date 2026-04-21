import { NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { randomInt } from 'crypto'

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://peermesh-beta.vercel.app'

function generate6DigitToken(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

// POST — send confirmation token to the signed-in user's email
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user?.email) {
    return new NextResponse(JSON.stringify({ error: 'Unauthorized' }), { 
      status: 401,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    })
  }

  const token = generate6DigitToken()
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString()

  // Invalidate previous unused tokens
  await adminClient
    .from('auth_tokens')
    .update({ used: true })
    .eq('email', user.email)
    .eq('type', 'confirm_email')
    .eq('used', false)

  await adminClient.from('auth_tokens').insert({
    user_id:    user.id,
    email:      user.email,
    token,
    type:       'confirm_email',
    expires_at: expiresAt,
  })

  await fetch(`${APP_URL}/api/auth/send-email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to:      user.email,
      subject: 'Confirm your PeerMesh email',
      html:    await buildConfirmEmail(token),
    }),
  }).catch(() => {})

  return new NextResponse(JSON.stringify({ success: true }), { 
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  })
}

// PUT — verify the token
export async function PUT(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.email) return new NextResponse(JSON.stringify({ error: 'Unauthorized' }), { 
    status: 401,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  })

  const { token } = await req.json().catch(() => ({}))
  if (!token) return new NextResponse(JSON.stringify({ error: 'token is required' }), { 
    status: 400,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  })

  const { data: row } = await adminClient
    .from('auth_tokens')
    .select('id, expires_at, used')
    .eq('email', user.email)
    .eq('token', token)
    .eq('type', 'confirm_email')
    .eq('used', false)
    .maybeSingle()

  if (!row) return new NextResponse(JSON.stringify({ error: 'Invalid or expired code' }), { 
    status: 400,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  })
  if (new Date(row.expires_at) < new Date()) {
    return new NextResponse(JSON.stringify({ error: 'Code has expired — request a new one' }), { 
      status: 400,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    })
  }

  await adminClient.from('auth_tokens').update({ used: true }).eq('id', row.id)
  // Mark email confirmed in Supabase auth
  await adminClient.auth.admin.updateUserById(user.id, { email_confirm: true })

  return new NextResponse(JSON.stringify({ success: true }), { 
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  })
}

async function buildConfirmEmail(token: string): Promise<string> {
  const res = await fetch(`${APP_URL}/template/signup?token=${token}`)
  if (res.ok) return res.text()
  return `<p>Your PeerMesh email confirmation code is: <strong>${token}</strong>. It expires in 15 minutes.</p>`
}
