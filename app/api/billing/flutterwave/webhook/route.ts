import { NextResponse } from 'next/server'
import {
  isSuccessfulFlutterwaveCharge,
  verifyFlutterwaveTransaction,
  verifyFlutterwaveWebhookSignature,
} from '@/lib/flutterwave'
import { adminClient } from '@/lib/supabase/admin'
import { settleWalletTopUp } from '@/lib/wallet'

export async function POST(req: Request) {
  const rawBody = await req.text()
  const secretHash = process.env.FLW_SECRET_HASH ?? process.env.FLUTTERWAVE_WEBHOOK_SECRET_HASH ?? ''
  const signature = req.headers.get('flutterwave-signature') ?? req.headers.get('verif-hash')

  if (!verifyFlutterwaveWebhookSignature(rawBody, signature, secretHash, { allowPlainSecret: true })) {
    return new NextResponse('Invalid signature', { status: 401 })
  }

  let payload: {
    type?: string
    data?: {
      id?: string | number
      tx_ref?: string
    }
  }
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return new NextResponse('Invalid payload', { status: 400 })
  }

  const transactionId = payload.data?.id
  const txRef = String(payload.data?.tx_ref ?? '').trim()
  if (!transactionId || !txRef) {
    return NextResponse.json({ ok: true, ignored: true })
  }

  const verified = await verifyFlutterwaveTransaction(transactionId)
  if (!isSuccessfulFlutterwaveCharge(verified)) {
    return NextResponse.json({ ok: true, ignored: true })
  }

  const { data: payment } = await adminClient
    .from('payment_transactions')
    .select('user_id, amount_usd')
    .eq('tx_ref', txRef)
    .maybeSingle()

  if (!payment?.user_id) {
    return NextResponse.json({ ok: true, ignored: true })
  }

  if (Number(verified.data?.amount ?? 0) < Number(payment.amount_usd ?? 0)) {
    return NextResponse.json({ ok: true, ignored: true })
  }

  await settleWalletTopUp({
    userId: payment.user_id,
    txRef,
    transactionId,
    amountUsd: Number(payment.amount_usd ?? 0),
    localAmount: Number(verified.data?.amount ?? 0),
    localCurrency: verified.data?.currency ?? 'USD',
    rawResponse: verified,
  })

  return NextResponse.json({ ok: true })
}
