import { adminClient } from '@/lib/supabase/admin'

export type WalletTopUpSettlementInput = {
  userId: string
  txRef: string
  transactionId?: string | number | null
  amountUsd: number
  localAmount?: number | null
  localCurrency?: string | null
  rawResponse?: Record<string, unknown> | null
}

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100
}

export async function getWalletSummary(userId: string) {
  const [{ data: profile, error: profileError }, { data: ledger }, { data: payments }, { data: payouts }] = await Promise.all([
    adminClient
      .from('profiles')
      .select('role, contribution_credits_bytes, wallet_balance_usd, wallet_pending_payout_usd, payout_currency')
      .eq('id', userId)
      .single(),
    adminClient
      .from('wallet_ledger')
      .select('id, kind, amount_usd, currency, reference, metadata, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(10),
    adminClient
      .from('payment_transactions')
      .select('id, tx_ref, status, amount_usd, local_amount, local_currency, checkout_url, created_at, verified_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(10),
    adminClient
      .from('provider_payouts')
      .select('id, amount_usd, destination_currency, destination_amount, fx_rate, status, created_at, processed_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(10),
  ])

  if (profileError || !profile) {
    throw new Error(profileError?.message ?? 'Could not load wallet summary')
  }

  return {
    profile,
    ledger: ledger ?? [],
    payments: payments ?? [],
    payouts: payouts ?? [],
  }
}

export async function settleWalletTopUp(input: WalletTopUpSettlementInput) {
  const txRef = input.txRef.trim()
  const amountUsd = roundCurrency(Number(input.amountUsd) || 0)
  if (!txRef || amountUsd <= 0) {
    throw new Error('Invalid wallet settlement payload')
  }

  const reference = `payment:${txRef}`
  const { data: transaction } = await adminClient
    .from('payment_transactions')
    .select('id, status')
    .eq('tx_ref', txRef)
    .maybeSingle()

  if (!transaction?.id) {
    throw new Error(`Unknown payment transaction: ${txRef}`)
  }

  await adminClient
    .from('payment_transactions')
    .update({
      status: 'successful',
      flutterwave_transaction_id: input.transactionId != null ? String(input.transactionId) : null,
      local_amount: input.localAmount ?? null,
      local_currency: input.localCurrency ?? null,
      raw_response: input.rawResponse ?? {},
      verified_at: new Date().toISOString(),
    })
    .eq('id', transaction.id)

  const { data: existingLedger } = await adminClient
    .from('wallet_ledger')
    .select('id')
    .eq('reference', reference)
    .maybeSingle()

  if (existingLedger?.id) {
    const { data: profile } = await adminClient
      .from('profiles')
      .select('wallet_balance_usd')
      .eq('id', input.userId)
      .single()
    return {
      alreadyApplied: true,
      walletBalanceUsd: Number(profile?.wallet_balance_usd ?? 0),
    }
  }

  const { data: profile, error: profileError } = await adminClient
    .from('profiles')
    .select('wallet_balance_usd')
    .eq('id', input.userId)
    .single()

  if (profileError || !profile) {
    throw new Error(profileError?.message ?? 'Could not load wallet balance')
  }

  const nextBalanceUsd = roundCurrency(Number(profile.wallet_balance_usd ?? 0) + amountUsd)
  const { error: ledgerError } = await adminClient
    .from('wallet_ledger')
    .insert({
      user_id: input.userId,
      kind: 'payment',
      amount_usd: amountUsd,
      currency: 'USD',
      reference,
      metadata: input.rawResponse ?? {},
    })

  if (ledgerError) {
    if (ledgerError.message.toLowerCase().includes('duplicate')) {
      return {
        alreadyApplied: true,
        walletBalanceUsd: Number(profile.wallet_balance_usd ?? 0),
      }
    }
    throw ledgerError
  }

  await adminClient
    .from('profiles')
    .update({ wallet_balance_usd: nextBalanceUsd })
    .eq('id', input.userId)

  return {
    alreadyApplied: false,
    walletBalanceUsd: nextBalanceUsd,
  }
}
