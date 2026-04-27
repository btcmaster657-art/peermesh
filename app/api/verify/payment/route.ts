import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'

const BYPASS = process.env.NEXT_PUBLIC_BYPASS_VERIFICATION === 'true'

async function getUser(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (user) return user

  const authHeader = req.headers.get('authorization')
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7)
    const { data: { user: tokenUser } } = await adminClient.auth.getUser(token)
    return tokenUser ?? null
  }

  return null
}

export async function POST(req: Request) {
  const body = await req.json()
  const user = await getUser(req)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { bypass } = body

  if (bypass && BYPASS) {
    return NextResponse.json({ success: true, bypass: true })
  }

  return NextResponse.json({ error: 'Use /api/billing/flutterwave/checkout for wallet funding.' }, { status: 410 })
}
