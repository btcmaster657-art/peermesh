import { NextResponse } from 'next/server'
import { getRequestUser } from '@/lib/request-auth'
import { syncProviderPayoutTransfer } from '@/lib/wallet'

export async function POST(req: Request) {
  const user = await getRequestUser(req)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const transferId = typeof body.transferId === 'string' ? body.transferId.trim() : ''
  if (!transferId) {
    return NextResponse.json({ error: 'transferId is required' }, { status: 400 })
  }

  try {
    const payout = await syncProviderPayoutTransfer({
      userId: user.id,
      transferId,
    })

    return NextResponse.json({ payout })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not verify payout' },
      { status: 400 },
    )
  }
}
