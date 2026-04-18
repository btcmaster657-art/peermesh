import { NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS })
}

// GET /api/extension-auth/revoke?ext_id=<uuid>
export async function GET(req: Request) {
  const ext_id = new URL(req.url).searchParams.get('ext_id')
  if (!ext_id) return NextResponse.json({ error: 'Missing ext_id' }, { status: 400, headers: CORS })
  await adminClient.from('extension_auth_tokens').update({ used: true }).eq('ext_id', ext_id)
  return NextResponse.json({ ok: true }, { headers: CORS })
}

// POST /api/extension-auth/revoke  body: { ext_id }
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const ext_id = body.ext_id ?? new URL(req.url).searchParams.get('ext_id')
  if (!ext_id) return NextResponse.json({ error: 'Missing ext_id' }, { status: 400, headers: CORS })
  await adminClient.from('extension_auth_tokens').update({ used: true }).eq('ext_id', ext_id)
  return NextResponse.json({ ok: true }, { headers: CORS })
}
