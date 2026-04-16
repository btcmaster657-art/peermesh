import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { sessionId, bytesUsed = 0 } = await req.json()
  if (!sessionId) return NextResponse.json({ error: 'sessionId is required' }, { status: 400 })

  // End the session
  const { error } = await adminClient
    .from('sessions')
    .update({
      status: 'ended',
      ended_at: new Date().toISOString(),
      bytes_used: bytesUsed,
    })
    .eq('id', sessionId)
    .eq('user_id', user.id)

  if (error) return NextResponse.json({ error: 'Session not found' }, { status: 404 })

  // Update profile bandwidth usage
  if (bytesUsed > 0) {
    await adminClient.rpc('increment_bandwidth', {
      p_user_id: user.id,
      p_bytes: bytesUsed,
    })
  }

  return NextResponse.json({ success: true })
}
