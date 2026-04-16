import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { isSharing } = await req.json()
  if (typeof isSharing !== 'boolean') {
    return NextResponse.json({ error: 'isSharing must be boolean' }, { status: 400 })
  }

  await adminClient
    .from('profiles')
    .update({ is_sharing: isSharing })
    .eq('id', user.id)

  return NextResponse.json({ success: true, isSharing })
}
