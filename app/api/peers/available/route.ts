import { NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  // Build peer counts excluding the current user
  const query = adminClient
    .from('profiles')
    .select('country_code')
    .eq('is_sharing', true)
    .eq('is_verified', true)

  if (user) query.neq('id', user.id)

  const { data, error } = await query

  if (error || !data) return NextResponse.json({ peers: [] })

  // Aggregate counts
  const counts: Record<string, number> = {}
  data.forEach(row => {
    counts[row.country_code] = (counts[row.country_code] ?? 0) + 1
  })

  const peers = Object.entries(counts).map(([country, count]) => ({ country, count }))

  return NextResponse.json({ peers })
}
