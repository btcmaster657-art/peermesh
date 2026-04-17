import { NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  // Clean up stale providers (heartbeat > 45s ago) before counting
  try { await adminClient.rpc('cleanup_stale_providers') } catch {}

  // Count distinct live devices per country, excluding current user
  const cutoff = new Date(Date.now() - 45_000).toISOString()

  let query = adminClient
    .from('provider_devices')
    .select('country_code, user_id')
    .gt('last_heartbeat', cutoff)

  const { data, error } = await query

  if (error || !data) return NextResponse.json({ peers: [] })

  // Aggregate — exclude current user, deduplicate by user_id per country
  const seen = new Set<string>()
  const counts: Record<string, number> = {}
  for (const row of data) {
    if (user && row.user_id === user.id) continue
    const key = `${row.country_code}:${row.user_id}`
    if (seen.has(key)) continue
    seen.add(key)
    counts[row.country_code] = (counts[row.country_code] ?? 0) + 1
  }

  const peers = Object.entries(counts).map(([country, count]) => ({ country, count }))

  return NextResponse.json({ peers })
}
