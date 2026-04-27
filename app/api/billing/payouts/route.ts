import { NextResponse } from 'next/server'
import { getRequestUser } from '@/lib/request-auth'
import { requestProviderPayout } from '@/lib/wallet'

export async function POST(req: Request) {
  const user = await getRequestUser(req)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const payout = await requestProviderPayout({ userId: user.id })
    return NextResponse.json({ payout })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not create payout' },
      { status: 400 },
    )
  }
}
