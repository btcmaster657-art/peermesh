import { NextResponse } from 'next/server'
import { getFlutterwaveTransferRate } from '@/lib/flutterwave'
import { getRequestUser } from '@/lib/request-auth'
import { getWalletSummary } from '@/lib/wallet'

export async function GET(req: Request) {
  const user = await getRequestUser(req)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const summary = await getWalletSummary(user.id)
  const { searchParams } = new URL(req.url)
  const destinationCurrency = (searchParams.get('currency') ?? summary.profile.payout_currency ?? '').trim().toUpperCase()

  let payoutPreview = null
  if (destinationCurrency && destinationCurrency !== 'USD' && Number(summary.profile.wallet_pending_payout_usd ?? 0) > 0) {
    try {
      const rate = await getFlutterwaveTransferRate(
        'USD',
        destinationCurrency,
        Number(summary.profile.wallet_pending_payout_usd ?? 0),
      )
      payoutPreview = {
        destination_currency: destinationCurrency,
        rate: Number(rate.data.rate ?? 0),
        destination_amount: Number(rate.data.destination.amount ?? 0),
      }
    } catch (error) {
      payoutPreview = {
        destination_currency: destinationCurrency,
        error: error instanceof Error ? error.message : 'Could not load payout FX rate',
      }
    }
  }

  return NextResponse.json({
    profile: summary.profile,
    ledger: summary.ledger,
    payments: summary.payments,
    payouts: summary.payouts,
    payoutPreview,
  })
}
