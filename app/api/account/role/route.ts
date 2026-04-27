import { NextResponse } from 'next/server'
import { getRequestUser } from '@/lib/request-auth'
import { normalizePeerMeshRole } from '@/lib/roles'
import { adminClient } from '@/lib/supabase/admin'

export async function POST(req: Request) {
  const user = await getRequestUser(req)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const requestedRole = normalizePeerMeshRole(body.role)

  const { data: profile, error: profileError } = await adminClient
    .from('profiles')
    .select('role, is_sharing')
    .eq('id', user.id)
    .single<{ role: string | null; is_sharing: boolean | null }>()

  if (profileError || !profile) {
    return NextResponse.json({ error: profileError?.message ?? 'Profile not found' }, { status: 404 })
  }

  if (profile.role === requestedRole) {
    return NextResponse.json({ ok: true, role: requestedRole })
  }

  if (requestedRole === 'client' && profile.is_sharing) {
    return NextResponse.json({
      error: 'Stop sharing before switching to Client.',
    }, { status: 409 })
  }

  const { error: updateError } = await adminClient
    .from('profiles')
    .update({ role: requestedRole })
    .eq('id', user.id)

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true, role: requestedRole })
}
