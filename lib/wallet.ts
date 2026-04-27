import { adminClient } from '@/lib/supabase/admin'
import {
  calculateProviderRevenueShareUsd,
  estimateApiUsageCost,
  settleUserUsage,
  type ApiKeyTier,
  type ApiSessionMode,
} from '@/lib/billing'

export type WalletTopUpSettlementInput = {
  userId: string
  txRef: string
  transactionId?: string | number | null
  amountUsd: number
  localAmount?: number | null
  localCurrency?: string | null
  rawResponse?: Record<string, unknown> | null
}

export type SessionUsageSettlementInput = {
  requesterId: string
  providerUserId?: string | null
  sessionId: string
  bytesUsed: number
  source: 'user' | 'api_key'
  apiKeyId?: string | null
  apiRequestId?: string | null
  tier?: ApiKeyTier | null
  requestedRpm?: number | null
  requestedPeriodHours?: number | null
  requestedSessionMode?: ApiSessionMode | null
  durationMinutes?: number | null
}

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100
}

function roundCurrency4(value: number): number {
  return Math.round(value * 10_000) / 10_000
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

export async function settleSessionUsage(input: SessionUsageSettlementInput) {
  const bytesUsed = Math.max(0, Math.floor(Number(input.bytesUsed) || 0))
  if (!input.requesterId || !input.sessionId || bytesUsed <= 0) {
    return {
      walletDebitUsd: 0,
      providerPayoutUsd: 0,
      platformRevenueUsd: 0,
      grossChargeUsd: 0,
      shortfallUsd: 0,
      contributionCreditsSpentBytes: 0,
      apiUsageRecorded: false,
    }
  }

  const { data: requesterProfile, error: requesterError } = await adminClient
    .from('profiles')
    .select('bandwidth_used_month, bandwidth_limit, is_premium, contribution_credits_bytes, wallet_balance_usd')
    .eq('id', input.requesterId)
    .single<{
      bandwidth_used_month: number | null
      bandwidth_limit: number | null
      is_premium: boolean | null
      contribution_credits_bytes: number | null
      wallet_balance_usd: number | null
    }>()

  if (requesterError || !requesterProfile) {
    throw new Error(requesterError?.message ?? 'Could not load requester billing state')
  }

  let grossChargeUsd = 0
  let walletDebitUsd = 0
  let shortfallUsd = 0
  let providerPayoutUsd = 0
  let platformRevenueUsd = 0
  let contributionCreditsSpentBytes = 0

  if (input.source === 'api_key') {
    const tier = input.tier ?? 'standard'
    const requestedRpm = Math.max(1, Math.floor(Number(input.requestedRpm) || 60))
    const requestedPeriodHours = Math.max(1, Math.floor(Number(input.requestedPeriodHours) || 1))
    const requestedSessionMode = input.requestedSessionMode === 'sticky' ? 'sticky' : 'rotating'
    grossChargeUsd = roundCurrency4(estimateApiUsageCost({
      tier,
      bandwidthGb: bytesUsed / (1024 ** 3),
      rpm: requestedRpm,
      periodHours: requestedPeriodHours,
      sessionMode: requestedSessionMode,
    }))
    walletDebitUsd = roundCurrency(Math.min(Number(requesterProfile.wallet_balance_usd ?? 0), grossChargeUsd))
    shortfallUsd = roundCurrency(Math.max(0, grossChargeUsd - walletDebitUsd))
    providerPayoutUsd = calculateProviderRevenueShareUsd(walletDebitUsd)
    platformRevenueUsd = roundCurrency(Math.max(0, walletDebitUsd - providerPayoutUsd))
  } else {
    const usage = settleUserUsage({
      bytesUsed,
      bandwidthUsedMonth: Number(requesterProfile.bandwidth_used_month ?? 0),
      bandwidthLimit: Number(requesterProfile.bandwidth_limit ?? 0),
      isPremium: requesterProfile.is_premium === true,
      contributionCreditsBytes: Number(requesterProfile.contribution_credits_bytes ?? 0),
      walletBalanceUsd: Number(requesterProfile.wallet_balance_usd ?? 0),
    })
    grossChargeUsd = usage.grossChargeUsd
    walletDebitUsd = usage.walletDebitUsd
    shortfallUsd = usage.shortfallUsd
    providerPayoutUsd = usage.providerPayoutUsd
    platformRevenueUsd = usage.platformRevenueUsd
    contributionCreditsSpentBytes = usage.creditBytes
  }

  const nextWalletBalanceUsd = roundCurrency(Math.max(0, Number(requesterProfile.wallet_balance_usd ?? 0) - walletDebitUsd))
  const nextContributionCreditsBytes = Math.max(
    0,
    Number(requesterProfile.contribution_credits_bytes ?? 0) - contributionCreditsSpentBytes,
  )

  if (walletDebitUsd > 0 || contributionCreditsSpentBytes > 0) {
    const { error: updateRequesterError } = await adminClient
      .from('profiles')
      .update({
        wallet_balance_usd: nextWalletBalanceUsd,
        contribution_credits_bytes: nextContributionCreditsBytes,
      })
      .eq('id', input.requesterId)

    if (updateRequesterError) {
      throw new Error(updateRequesterError.message)
    }
  }

  if (walletDebitUsd > 0) {
    await adminClient
      .from('wallet_ledger')
      .insert({
        user_id: input.requesterId,
        kind: 'debit',
        amount_usd: walletDebitUsd,
        currency: 'USD',
        reference: `session:${input.sessionId}`,
        metadata: {
          source: input.source,
          sessionId: input.sessionId,
          bytesUsed,
          grossChargeUsd,
          shortfallUsd,
        },
      })
  }

  if (input.providerUserId && providerPayoutUsd > 0) {
    const { data: providerProfile, error: providerError } = await adminClient
      .from('profiles')
      .select('wallet_pending_payout_usd, payout_currency')
      .eq('id', input.providerUserId)
      .single<{
        wallet_pending_payout_usd: number | null
        payout_currency: string | null
      }>()

    if (providerError || !providerProfile) {
      throw new Error(providerError?.message ?? 'Could not load provider payout state')
    }

    const nextPendingPayoutUsd = roundCurrency(
      Number(providerProfile.wallet_pending_payout_usd ?? 0) + providerPayoutUsd,
    )

    await adminClient
      .from('profiles')
      .update({ wallet_pending_payout_usd: nextPendingPayoutUsd })
      .eq('id', input.providerUserId)

    await adminClient
      .from('provider_payouts')
      .insert({
        user_id: input.providerUserId,
        amount_usd: providerPayoutUsd,
        destination_currency: providerProfile.payout_currency ?? 'USD',
        status: 'pending',
        metadata: {
          sessionId: input.sessionId,
          requesterId: input.requesterId,
          source: input.source,
          bytesUsed,
          grossChargeUsd,
          platformRevenueUsd,
        },
      })
  }

  let apiUsageRecorded = false
  if (input.source === 'api_key' && input.apiKeyId) {
    await adminClient
      .from('api_usage')
      .insert({
        api_key_id: input.apiKeyId,
        user_id: input.requesterId,
        session_id: input.sessionId,
        request_id: input.apiRequestId ?? null,
        bandwidth_bytes: bytesUsed,
        rpm_requested: Math.max(0, Math.floor(Number(input.requestedRpm) || 0)),
        session_mode: input.requestedSessionMode === 'sticky' ? 'sticky' : 'rotating',
        duration_minutes: Math.max(0, Math.floor(Number(input.durationMinutes) || 0)),
        estimated_cost_usd: grossChargeUsd,
        collected_cost_usd: walletDebitUsd,
        shortfall_cost_usd: shortfallUsd,
      })
    apiUsageRecorded = true
  }

  return {
    walletDebitUsd,
    providerPayoutUsd,
    platformRevenueUsd,
    grossChargeUsd,
    shortfallUsd,
    contributionCreditsSpentBytes,
    apiUsageRecorded,
  }
}
