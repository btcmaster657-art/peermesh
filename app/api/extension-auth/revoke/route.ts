import { NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { verifyDesktopToken } from '@/lib/desktop-token'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS })
}

// GET /api/extension-auth/revoke?ext_id=<uuid>  (uninstall hook)
export async function GET(req: Request) {
  const ext_id = new URL(req.url).searchParams.get('ext_id')
  if (!ext_id) return NextResponse.json({ error: 'Missing ext_id' }, { status: 400, headers: CORS })
  await adminClient.from('extension_auth_tokens').update({ used: true }).eq('ext_id', ext_id)
  return NextResponse.json({ ok: true }, { headers: CORS })
}

// POST /api/extension-auth/revoke
// Body options:
//   { ext_id }           — extension uninstall / sign-out (marks token used)
//   { userId }           — desktop/CLI manual sign-out (sets device_codes.status=revoked)
//   { ext_id, userId }   — both
// Auth: Bearer desktop token OR Supabase session (userId must match)
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const ext_id = body.ext_id ?? new URL(req.url).searchParams.get('ext_id') ?? null
  const userId = body.userId ?? null

  // Resolve the caller's identity to prevent spoofed revocations
  let callerId: string | null = null
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (token) {
    callerId = verifyDesktopToken(token) ?? null
  }
  if (!callerId) {
    const supabase = await createClient()
    callerId = (await supabase.auth.getUser()).data.user?.id ?? null
  }

  // Revoke extension_auth_tokens row
  if (ext_id) {
    await adminClient.from('extension_auth_tokens').update({ used: true }).eq('ext_id', ext_id)
  }

  // Revoke device_codes for this user — only if caller is the same user
  if (userId && callerId && callerId === userId) {
    await adminClient
      .from('device_codes')
      .update({ status: 'revoked' })
      .eq('user_id', userId)
      .in('status', ['pending', 'approved'])
  }

  return NextResponse.json({ ok: true }, { headers: CORS })
}
