import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS })
}

// POST /api/extension-auth — called by website after sign-in to write a one-time token
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401, headers: CORS })

  const { ext_id } = await req.json()
  if (!ext_id || typeof ext_id !== 'string' || ext_id.length < 10) {
    return NextResponse.json({ error: 'Invalid ext_id' }, { status: 400, headers: CORS })
  }

  // Upsert: replace any existing token for this ext_id
  await adminClient.from('extension_auth_tokens').upsert({
    ext_id,
    user_id: session.user.id,
    token: session.access_token,
    used: false,
    expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  }, { onConflict: 'ext_id' })

  return NextResponse.json({ ok: true }, { headers: CORS })
}

// GET /api/extension-auth?ext_id=<uuid> — called by extension to exchange for user data
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const ext_id = searchParams.get('ext_id')

  if (!ext_id) {
    return NextResponse.json({ error: 'Missing ext_id' }, { status: 400, headers: CORS })
  }

  const { data: row } = await adminClient
    .from('extension_auth_tokens')
    .select('*')
    .eq('ext_id', ext_id)
    .eq('used', false)
    .gt('expires_at', new Date().toISOString())
    .single()

  if (!row) return NextResponse.json({ pending: true }, { headers: CORS })

  const { data: { user } } = await adminClient.auth.admin.getUserById(row.user_id)
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404, headers: CORS })

  const { data: profile } = await adminClient
    .from('profiles')
    .select('username, country_code, trust_score, is_verified, total_bytes_shared, total_bytes_used, is_sharing')
    .eq('id', row.user_id)
    .single()

  if (!profile?.is_verified) {
    return NextResponse.json({ error: 'Account not verified' }, { status: 403, headers: CORS })
  }

  return NextResponse.json({
    user: {
      id: user.id,
      email: user.email,
      token: row.token,
      username: profile.username,
      country: profile.country_code,
      trustScore: profile.trust_score,
      totalShared: profile.total_bytes_shared,
      totalUsed: profile.total_bytes_used,
      isSharing: profile.is_sharing,
    },
  }, { headers: CORS })
}
