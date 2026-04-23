import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { issueDesktopToken } from '@/lib/desktop-token'

export async function GET() {
  const supabase = await createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  return NextResponse.json({
    token: issueDesktopToken(session.user.id),
    userId: session.user.id,
  })
}
