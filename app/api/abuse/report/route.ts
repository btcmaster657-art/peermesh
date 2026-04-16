import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { sessionId, reason } = await req.json()
  if (!sessionId || !reason) {
    return NextResponse.json({ error: 'sessionId and reason are required' }, { status: 400 })
  }

  // Insert report
  await adminClient.from('abuse_reports').insert({
    reporter_id: user.id,
    reported_session_id: sessionId,
    reason,
  })

  // Get session to find provider
  const { data: session } = await adminClient
    .from('sessions')
    .select('provider_id')
    .eq('id', sessionId)
    .single()

  // Dock provider trust score
  if (session?.provider_id) {
    await adminClient.rpc('update_trust_score', {
      p_user_id: session.provider_id,
      delta: -10,
    })
  }

  // Flag the session
  await adminClient
    .from('sessions')
    .update({ status: 'flagged' })
    .eq('id', sessionId)

  return NextResponse.json({ success: true })
}
