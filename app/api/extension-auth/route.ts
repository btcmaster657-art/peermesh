import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS })
}

export async function GET(req: Request) {
  const supabase = await createClient()

  // Try cookie session first
  let session = (await supabase.auth.getSession()).data.session

  // Fallback: Bearer token (for extension popup calling cross-origin)
  if (!session) {
    const auth = req.headers.get('authorization')
    if (auth?.startsWith('Bearer ')) {
      const { data } = await supabase.auth.getUser(auth.slice(7))
      if (data.user) {
        // Re-fetch session via admin
        const { data: s } = await adminClient.auth.admin.getUserById(data.user.id)
        if (s.user) {
          // Build a minimal session-like object
          session = { user: data.user, access_token: auth.slice(7) } as any
        }
      }
    }
  }

  if (!session) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401, headers: CORS })
  }

  const { data: profile } = await adminClient
    .from('profiles')
    .select('username, country_code, trust_score, is_verified, total_bytes_shared, total_bytes_used, is_sharing')
    .eq('id', session.user.id)
    .single()

  if (!profile?.is_verified) {
    return NextResponse.json({ error: 'Account not verified' }, { status: 403, headers: CORS })
  }

  return NextResponse.json({
    user: {
      id: session.user.id,
      email: session.user.email,
      token: session.access_token,
      username: profile.username,
      country: profile.country_code,
      trustScore: profile.trust_score,
      totalShared: profile.total_bytes_shared,
      totalUsed: profile.total_bytes_used,
      isSharing: profile.is_sharing,
    },
  }, { headers: CORS })
}
