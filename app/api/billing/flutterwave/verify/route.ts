import { NextResponse } from 'next/server'
import { isSuccessfulFlutterwaveCharge, verifyFlutterwaveTransaction } from '@/lib/flutterwave'
import { getRequestUser } from '@/lib/request-auth'
import { adminClient } from '@/lib/supabase/admin'
import { settleWalletTopUp } from '@/lib/wallet'

async function resolvePayload(req: Request) {
  if (req.method === 'GET') {
    const { searchParams } = new URL(req.url)
    return {
      transactionId: searchParams.get('transaction_id') ?? searchParams.get('transactionId'),
      txRef: searchParams.get('tx_ref') ?? searchParams.get('txRef'),
    }
  }

  const body = await req.json().catch(() => ({}))
  return {
    transactionId: body.transactionId ?? body.transaction_id ?? null,
    txRef: body.txRef ?? body.tx_ref ?? null,
  }
}

async function handleVerify(req: Request) {
  const user = await getRequestUser(req)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { transactionId, txRef } = await resolvePayload(req)
  if (!transactionId) {
    return NextResponse.json({ error: 'transactionId is required' }, { status: 400 })
  }

  const verified = await verifyFlutterwaveTransaction(transactionId)
  const resolvedTxRef = String(verified.data?.tx_ref ?? txRef ?? '').trim()
  if (!resolvedTxRef) {
    return NextResponse.json({ error: 'Missing tx_ref from Flutterwave verification' }, { status: 400 })
  }

  const { data: payment } = await adminClient
    .from('payment_transactions')
    .select('user_id, tx_ref, amount_usd, status')
    .eq('tx_ref', resolvedTxRef)
    .maybeSingle()

  if (!payment || payment.user_id !== user.id) {
    return NextResponse.json({ error: 'Payment transaction not found' }, { status: 404 })
  }

  if (!isSuccessfulFlutterwaveCharge(verified)) {
    await adminClient
      .from('payment_transactions')
      .update({ status: 'failed', raw_response: verified })
      .eq('tx_ref', resolvedTxRef)
    return NextResponse.json({ error: 'Payment is not successful yet' }, { status: 409 })
  }

  const verifiedAmount = Number(verified.data?.amount ?? 0)
  if (verifiedAmount < Number(payment.amount_usd ?? 0)) {
    return NextResponse.json({ error: 'Verified amount is lower than expected' }, { status: 409 })
  }

  const settled = await settleWalletTopUp({
    userId: payment.user_id,
    txRef: resolvedTxRef,
    transactionId,
    amountUsd: Number(payment.amount_usd ?? 0),
    localAmount: verifiedAmount,
    localCurrency: verified.data?.currency ?? 'USD',
    rawResponse: verified,
  })

  return NextResponse.json({
    ok: true,
    txRef: resolvedTxRef,
    alreadyApplied: settled.alreadyApplied,
    walletBalanceUsd: settled.walletBalanceUsd,
  })
}

export async function GET(req: Request) {
  return handleVerify(req)
}

export async function POST(req: Request) {
  return handleVerify(req)
}
