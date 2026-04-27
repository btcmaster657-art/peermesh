import { randomUUID } from 'crypto'
import { NextResponse } from 'next/server'
import { createFlutterwaveCheckout, getFlutterwaveTransferRate } from '@/lib/flutterwave'
import { getRequestUser } from '@/lib/request-auth'
import { adminClient } from '@/lib/supabase/admin'

function resolveAppUrl(req: Request): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? new URL(req.url).origin
}

export async function POST(req: Request) {
  const user = await getRequestUser(req)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const amountUsd = Math.round((Number(body.amountUsd) || 0) * 100) / 100
  if (!Number.isFinite(amountUsd) || amountUsd < 1) {
    return NextResponse.json({ error: 'Minimum top-up is $1.00' }, { status: 400 })
  }

  const { data: profile, error: profileError } = await adminClient
    .from('profiles')
    .select('username, role, payout_currency')
    .eq('id', user.id)
    .single()

  if (profileError || !profile) {
    return NextResponse.json({ error: profileError?.message ?? 'Could not load profile' }, { status: 500 })
  }

  const txRef = `pm_${user.id.slice(0, 8)}_${Date.now()}_${randomUUID().slice(0, 6)}`
  const redirectUrl = `${resolveAppUrl(req)}/verify/payment`
  const destinationCurrency = (profile.payout_currency ?? 'NGN').toUpperCase()

  let localAmount: number | null = null
  let localCurrency: string | null = null
  try {
    const rate = await getFlutterwaveTransferRate('USD', destinationCurrency, amountUsd)
    localAmount = Number(rate.data.destination.amount ?? 0)
    localCurrency = destinationCurrency
  } catch {}

  const checkout = await createFlutterwaveCheckout({
    txRef,
    amountUsd,
    customerEmail: user.email ?? `${user.id}@peermesh.local`,
    customerName: profile.username ?? user.email?.split('@')[0] ?? 'PeerMesh user',
    redirectUrl,
    meta: {
      userId: user.id,
      role: profile.role,
      purpose: 'wallet_topup',
    },
  })

  await adminClient
    .from('payment_transactions')
    .insert({
      user_id: user.id,
      provider: 'flutterwave',
      tx_ref: txRef,
      flutterwave_transaction_id: checkout.data?.id != null ? String(checkout.data.id) : null,
      checkout_url: checkout.data?.link ?? null,
      status: 'pending',
      amount_usd: amountUsd,
      local_amount: localAmount,
      local_currency: localCurrency,
      raw_response: checkout,
    })

  return NextResponse.json({
    txRef,
    checkoutUrl: checkout.data?.link ?? null,
    localAmount,
    localCurrency,
  })
}
