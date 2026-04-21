import { NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'

export async function POST(req: Request) {
  const { email, token, password } = await req.json().catch(() => ({}))

  if (!email || !token || !password) {
    return new NextResponse(JSON.stringify({ error: 'email, token and password are required' }), { 
      status: 400,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    })
  }
  if (typeof password !== 'string' || password.length < 8) {
    return new NextResponse(JSON.stringify({ error: 'Password must be at least 8 characters' }), { 
      status: 400,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    })
  }

  const normalizedEmail = email.trim().toLowerCase()

  const { data: row } = await adminClient
    .from('auth_tokens')
    .select('id, user_id, expires_at, used')
    .eq('email', normalizedEmail)
    .eq('token', token)
    .eq('type', 'forgot_password')
    .eq('used', false)
    .maybeSingle()

  if (!row) {
    return new NextResponse(JSON.stringify({ error: 'Invalid or expired code' }), { 
      status: 400,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    })
  }
  if (new Date(row.expires_at) < new Date()) {
    return new NextResponse(JSON.stringify({ error: 'Code has expired — request a new one' }), { 
      status: 400,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    })
  }

  // Mark token used
  await adminClient.from('auth_tokens').update({ used: true }).eq('id', row.id)

  // Update password via admin API
  const { error } = await adminClient.auth.admin.updateUserById(row.user_id, { password })
  if (error) {
    return new NextResponse(JSON.stringify({ error: 'Could not update password' }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    })
  }

  return new NextResponse(JSON.stringify({ success: true }), { 
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  })
}
