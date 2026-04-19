import { NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'

export async function GET(req: Request) {
  // Try cookie-based auth first, then Bearer token — both optional
  const supabase = await createClient()
  let user = (await supabase.auth.getUser()).data.user
  if (!user) {
    const auth = req.headers.get('authorization') ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    if (token) user = (await adminClient.auth.getUser(token)).data.user ?? null
  }

  // Always clean up stale providers before counting — fixes stale is_sharing
  try { await adminClient.rpc('cleanup_stale_providers') } catch {}

  const cutoff = new Date(Date.now() - 45_000).toISOString()

  let query = adminClient
    .from('provider_devices')
    .select('country_code, user_id, device_id')
    .gt('last_heartbeat', cutoff)

  const { data, error } = await query

  if (error || !data) return NextResponse.json({ peers: [] })

  // Fetch private-share-enabled base device IDs so we can exclude their slots from public counts
  const { data: privateDevices } = await adminClient
    .from('private_share_devices')
    .select('user_id, base_device_id')
    .eq('enabled', true)

  const privateSlotPrefixes = new Set<string>(
    (privateDevices ?? []).map(d => `${d.user_id}::${d.base_device_id}`)
  )

  function isPrivateSlot(userId: string, deviceId: string): boolean {
    // Check if this device_id is the base device or a slot of a private-enabled base device
    for (const entry of privateSlotPrefixes) {
      const [uid, baseId] = entry.split('::')
      if (uid !== userId) continue
      if (deviceId === baseId || deviceId.startsWith(`${baseId}_slot_`)) return true
    }
    return false
  }

  // Aggregate live devices — exclude the current user's devices and private-only slots
  const counts: Record<string, number> = {}
  for (const row of data) {
    if (user && row.user_id === user.id) continue
    if (isPrivateSlot(row.user_id, row.device_id)) continue
    counts[row.country_code] = (counts[row.country_code] ?? 0) + 1
  }

  const peers = Object.entries(counts).map(([country, count]) => ({ country, count }))

  return NextResponse.json({ peers })
}
