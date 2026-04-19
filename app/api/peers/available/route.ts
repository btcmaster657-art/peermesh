import { NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  // Always clean up stale providers before counting — fixes stale is_sharing
  try { await adminClient.rpc('cleanup_stale_providers') } catch {}

  const cutoff = new Date(Date.now() - 45_000).toISOString()

  let query = adminClient
    .from('provider_devices')
    .select('country_code, user_id, device_id')
    .gt('last_heartbeat', cutoff)

  const { data, error } = await query

  if (error || !data) return NextResponse.json({ peers: [] })

  // Aggregate live devices — exclude the current user's devices
  const counts: Record<string, number> = {}
  for (const row of data) {
    if (user && row.user_id === user.id) continue
    counts[row.country_code] = (counts[row.country_code] ?? 0) + 1
  }

  const peers = Object.entries(counts).map(([country, count]) => ({ country, count }))

  return NextResponse.json({ peers })
}
