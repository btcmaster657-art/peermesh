import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { sessionId, reason, reportSubject } = await req.json()
  if (!sessionId || !reason) {
    return NextResponse.json({ error: 'sessionId and reason are required' }, { status: 400 })
  }
  const subject = reportSubject === 'requester' ? 'requester' : 'provider'

  const { data: session } = await adminClient
    .from('sessions')
    .select('provider_id, user_id')
    .eq('id', sessionId)
    .single()

  const reportedUserId = subject === 'requester'
    ? (session?.user_id ?? null)
    : (session?.provider_id ?? null)

  // Insert report
  await adminClient.from('abuse_reports').insert({
    reporter_id: user.id,
    reported_user_id: reportedUserId,
    reported_session_id: sessionId,
    report_subject: subject,
    reason,
  })

  // Dock trust score on the reported account.
  if (reportedUserId) {
    await adminClient.rpc('update_trust_score', {
      p_user_id: reportedUserId,
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
