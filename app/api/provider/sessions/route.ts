import { NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { getRequestUser } from '@/lib/request-auth'

export async function GET(req: Request) {
  const user = await getRequestUser(req)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const q = (searchParams.get('q') ?? '').trim().toLowerCase()
  const limit = Math.min(200, Math.max(1, Number.parseInt(searchParams.get('limit') ?? '100', 10) || 100))

  const { data: sessions, error } = await adminClient
    .from('sessions')
    .select('id, user_id, provider_id, provider_kind, provider_device_id, provider_base_device_id, target_country, target_host, target_hosts, relay_endpoint, status, bytes_used, disconnect_reason, started_at, ended_at')
    .eq('provider_id', user.id)
    .order('started_at', { ascending: false })
    .limit(limit)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const filteredSessions = q
    ? (sessions ?? []).filter((session) =>
        String(session.target_host ?? '').toLowerCase().includes(q)
        || String(session.target_country ?? '').toLowerCase().includes(q),
      )
    : (sessions ?? [])

  const requesterIds = [...new Set(filteredSessions.map((session) => session.user_id).filter(Boolean))]
  const { data: requesters } = requesterIds.length > 0
    ? await adminClient
        .from('profiles')
        .select('id, username, country_code, trust_score')
        .in('id', requesterIds)
    : { data: [] as Array<{ id: string; username: string | null; country_code: string; trust_score: number }> }

  const requesterMap = new Map((requesters ?? []).map((row) => [row.id, row]))
  return NextResponse.json({
    sessions: filteredSessions.map((session) => ({
      ...session,
      requester: requesterMap.get(session.user_id) ?? null,
    })),
  })
}
