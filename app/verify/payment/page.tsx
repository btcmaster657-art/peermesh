'use client'

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { formatBytes } from '@/lib/utils'

type WalletSummary = {
  profile: {
    role: string
    contribution_credits_bytes: number
    wallet_balance_usd: number
    wallet_pending_payout_usd: number
    payout_currency: string | null
  }
  ledger: Array<{
    id: string
    kind: string
    amount_usd: number
    currency: string
    reference: string | null
    created_at: string
  }>
  payments: Array<{
    id: string
    tx_ref: string
    status: string
    amount_usd: number
    local_amount: number | null
    local_currency: string | null
    created_at: string
    verified_at: string | null
  }>
  payoutPreview?: {
    destination_currency: string
    rate?: number
    destination_amount?: number
    error?: string
  } | null
}

type QuoteResponse = {
  quote: {
    estimatedUsd: number
    constraints: Array<{ code: string; message: string }>
    tier: string
    bandwidthGb: number
    rpm: number
    periodHours: number
    sessionMode: string
  }
}

const cardStyle: React.CSSProperties = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: '12px',
  padding: '16px',
}

function PaymentVerifyPageClient() {
  const supabase = createClient()
  const searchParams = useSearchParams()
  const [summary, setSummary] = useState<WalletSummary | null>(null)
  const [quote, setQuote] = useState<QuoteResponse['quote'] | null>(null)
  const [amountUsd, setAmountUsd] = useState('10')
  const [tier, setTier] = useState('standard')
  const [bandwidthGb, setBandwidthGb] = useState(1)
  const [rpm, setRpm] = useState(60)
  const [periodHours, setPeriodHours] = useState(1)
  const [sessionMode, setSessionMode] = useState<'rotating' | 'sticky'>('rotating')
  const [loading, setLoading] = useState(true)
  const [funding, setFunding] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const callbackStatus = searchParams.get('status')
  const callbackTransactionId = searchParams.get('transaction_id') ?? searchParams.get('transactionId')
  const callbackTxRef = searchParams.get('tx_ref') ?? searchParams.get('txRef')

  const contributionLabel = useMemo(() => {
    const bytes = Number(summary?.profile.contribution_credits_bytes ?? 0)
    return formatBytes(bytes)
  }, [summary?.profile.contribution_credits_bytes])

  const getAccessToken = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token ?? null
  }, [supabase])

  const loadSummary = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const token = await getAccessToken()
      const res = await fetch('/api/billing/wallet', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not load wallet')
      setSummary(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load wallet')
    } finally {
      setLoading(false)
    }
  }, [getAccessToken])

  const loadQuote = useCallback(async () => {
    try {
      const token = await getAccessToken()
      const res = await fetch('/api/billing/quote', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ tier, bandwidthGb, rpm, periodHours, sessionMode }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not calculate quote')
      setQuote(data.quote)
    } catch (err) {
      setQuote(null)
      setError(err instanceof Error ? err.message : 'Could not calculate quote')
    }
  }, [bandwidthGb, getAccessToken, periodHours, rpm, sessionMode, tier])

  const verifyReturnedPayment = useCallback(async () => {
    if (!callbackTransactionId || verifying) return
    setVerifying(true)
    setError('')
    setNotice('Verifying wallet top-up...')
    try {
      const token = await getAccessToken()
      const res = await fetch('/api/billing/flutterwave/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          transactionId: callbackTransactionId,
          txRef: callbackTxRef,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Payment verification failed')
      setNotice(`Wallet funded successfully. New balance: $${Number(data.walletBalanceUsd ?? 0).toFixed(2)}`)
      await loadSummary()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Payment verification failed')
      setNotice('')
    } finally {
      setVerifying(false)
    }
  }, [callbackTransactionId, callbackTxRef, getAccessToken, loadSummary, verifying])

  async function handleFundWallet() {
    setFunding(true)
    setError('')
    setNotice('')
    try {
      const numericAmount = Math.round((Number(amountUsd) || 0) * 100) / 100
      const token = await getAccessToken()
      const res = await fetch('/api/billing/flutterwave/checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ amountUsd: numericAmount }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not start checkout')
      if (!data.checkoutUrl) throw new Error('Flutterwave did not return a checkout URL')
      window.location.href = data.checkoutUrl
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start checkout')
      setFunding(false)
    }
  }

  useEffect(() => {
    loadSummary()
  }, [loadSummary])

  useEffect(() => {
    loadQuote()
  }, [loadQuote])

  useEffect(() => {
    if (callbackStatus === 'successful' && callbackTransactionId) {
      verifyReturnedPayment()
      return
    }
    if (callbackStatus === 'cancelled') {
      setNotice('Flutterwave checkout was cancelled before payment completed.')
    }
  }, [callbackStatus, callbackTransactionId, callbackTxRef, verifyReturnedPayment])

  return (
    <main className="flex flex-1 justify-center px-6 py-16">
      <div style={{ width: '100%', maxWidth: '760px', display: 'grid', gap: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
          <div>
            <div style={{ fontFamily: 'var(--font-geist-mono)', color: 'var(--accent)', fontSize: '12px', letterSpacing: '3px', marginBottom: '6px' }}>
              PEERMESH BILLING
            </div>
            <h1 style={{ fontSize: '24px', fontWeight: 600, margin: 0 }}>Wallet and API usage</h1>
          </div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <Link href="/dashboard" style={{ padding: '9px 12px', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text)', textDecoration: 'none', fontFamily: 'var(--font-geist-mono)', fontSize: '11px' }}>
              DASHBOARD
            </Link>
            <Link href="/api-docs" style={{ padding: '9px 12px', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text)', textDecoration: 'none', fontFamily: 'var(--font-geist-mono)', fontSize: '11px' }}>
              API DOCS
            </Link>
          </div>
        </div>

        <div style={{ ...cardStyle, background: 'rgba(0,255,136,0.05)', border: '1px solid rgba(0,255,136,0.25)' }}>
          <div style={{ fontSize: '13px', color: 'var(--muted)', lineHeight: 1.7 }}>
            Email confirmation is enough to sign in. Wallet funding is optional and only needed for paid usage when you are not actively sharing. Contribution credits are always spent before paid balance.
          </div>
        </div>

        {error && (
          <div style={{ ...cardStyle, borderColor: 'rgba(255,96,96,0.35)', background: 'rgba(255,96,96,0.08)', color: '#ff8080', fontSize: '13px' }}>
            {error}
          </div>
        )}

        {notice && (
          <div style={{ ...cardStyle, borderColor: 'rgba(0,255,136,0.35)', background: 'rgba(0,255,136,0.08)', color: 'var(--accent)', fontSize: '13px' }}>
            {notice}
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px' }}>
          <div style={cardStyle}>
            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--muted)', letterSpacing: '1px', marginBottom: '8px' }}>USD WALLET</div>
            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '28px', color: 'var(--accent)' }}>
              {loading ? '...' : `$${Number(summary?.profile.wallet_balance_usd ?? 0).toFixed(2)}`}
            </div>
          </div>
          <div style={cardStyle}>
            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--muted)', letterSpacing: '1px', marginBottom: '8px' }}>CONTRIBUTION CREDITS</div>
            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '20px', color: 'var(--accent)' }}>{loading ? '...' : contributionLabel}</div>
          </div>
          <div style={cardStyle}>
            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--muted)', letterSpacing: '1px', marginBottom: '8px' }}>PENDING PAYOUT</div>
            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '20px', color: 'var(--accent)' }}>
              {loading ? '...' : `$${Number(summary?.profile.wallet_pending_payout_usd ?? 0).toFixed(2)}`}
            </div>
            {summary?.payoutPreview?.destination_amount != null && (
              <div style={{ fontSize: '12px', color: 'var(--muted)', marginTop: '8px' }}>
                ≈ {summary.payoutPreview.destination_amount.toFixed(2)} {summary.payoutPreview.destination_currency}
              </div>
            )}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 1fr)', gap: '16px' }}>
          <div style={cardStyle}>
            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--accent)', letterSpacing: '1px', marginBottom: '12px' }}>FUND WALLET</div>
            <div style={{ display: 'grid', gap: '10px' }}>
              <label style={{ fontSize: '12px', color: 'var(--muted)' }}>
                Amount in USD
                <input
                  value={amountUsd}
                  onChange={(e) => setAmountUsd(e.target.value.replace(/[^\d.]/g, ''))}
                  style={{ width: '100%', marginTop: '6px', padding: '10px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontFamily: 'var(--font-geist-mono)', boxSizing: 'border-box' }}
                />
              </label>
              <button
                onClick={handleFundWallet}
                disabled={funding || verifying}
                style={{ padding: '12px 14px', borderRadius: '8px', border: 'none', background: 'var(--accent)', color: '#000', fontFamily: 'var(--font-geist-mono)', fontWeight: 700, cursor: funding || verifying ? 'not-allowed' : 'pointer', opacity: funding || verifying ? 0.7 : 1 }}
              >
                {funding ? 'OPENING FLUTTERWAVE...' : 'PAY WITH FLUTTERWAVE'}
              </button>
              <div style={{ fontSize: '12px', color: 'var(--muted)', lineHeight: 1.7 }}>
                All top-ups settle into your PeerMesh USD wallet. Provider payouts stay in USD internally and can be converted to your payout currency when disbursed.
              </div>
            </div>
          </div>

          <div style={cardStyle}>
            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--accent)', letterSpacing: '1px', marginBottom: '12px' }}>API USAGE ESTIMATE</div>
            <div style={{ display: 'grid', gap: '10px' }}>
              <label style={{ fontSize: '12px', color: 'var(--muted)' }}>
                Tier
                <select value={tier} onChange={(e) => setTier(e.target.value)} style={{ width: '100%', marginTop: '6px', padding: '10px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }}>
                  <option value="standard">Standard</option>
                  <option value="advanced">Advanced</option>
                  <option value="enterprise">Enterprise</option>
                  <option value="contributor">Contributor</option>
                </select>
              </label>
              <label style={{ fontSize: '12px', color: 'var(--muted)' }}>
                Bandwidth (GB)
                <input type="number" min={0.05} max={1000} step={0.05} value={bandwidthGb} onChange={(e) => setBandwidthGb(Number(e.target.value) || 1)} style={{ width: '100%', marginTop: '6px', padding: '10px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }} />
              </label>
              <label style={{ fontSize: '12px', color: 'var(--muted)' }}>
                RPM
                <input type="number" min={1} max={2400} step={1} value={rpm} onChange={(e) => setRpm(Number(e.target.value) || 60)} style={{ width: '100%', marginTop: '6px', padding: '10px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }} />
              </label>
              <label style={{ fontSize: '12px', color: 'var(--muted)' }}>
                Duration (hours)
                <input type="number" min={1} max={720} step={1} value={periodHours} onChange={(e) => setPeriodHours(Number(e.target.value) || 1)} style={{ width: '100%', marginTop: '6px', padding: '10px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }} />
              </label>
              <label style={{ fontSize: '12px', color: 'var(--muted)' }}>
                Session mode
                <select value={sessionMode} onChange={(e) => setSessionMode(e.target.value === 'sticky' ? 'sticky' : 'rotating')} style={{ width: '100%', marginTop: '6px', padding: '10px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }}>
                  <option value="rotating">Rotating</option>
                  <option value="sticky">Sticky</option>
                </select>
              </label>
              <div style={{ paddingTop: '6px', borderTop: '1px solid var(--border)' }}>
                <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '22px', color: 'var(--accent)' }}>
                  {quote ? `$${quote.estimatedUsd.toFixed(2)}` : '...'}
                </div>
                <div style={{ fontSize: '12px', color: 'var(--muted)', marginTop: '4px' }}>
                  Estimated cost for {quote?.tier ?? tier} usage.
                </div>
                {(quote?.constraints ?? []).length > 0 && (
                  <div style={{ marginTop: '8px', display: 'grid', gap: '6px' }}>
                    {quote?.constraints.map((constraint) => (
                      <div key={constraint.code} style={{ fontSize: '12px', color: constraint.code.includes('verification') ? '#ffcc66' : '#ff8080' }}>
                        {constraint.message}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        <div style={cardStyle}>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--accent)', letterSpacing: '1px', marginBottom: '12px' }}>RECENT PAYMENTS</div>
          <div style={{ display: 'grid', gap: '8px' }}>
            {(summary?.payments ?? []).length === 0 && (
              <div style={{ fontSize: '12px', color: 'var(--muted)' }}>No wallet top-ups yet.</div>
            )}
            {(summary?.payments ?? []).map((payment) => (
              <div key={payment.id} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '10px', alignItems: 'center', padding: '10px 0', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                <div>
                  <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: 'var(--text)' }}>{payment.tx_ref}</div>
                  <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '4px' }}>{new Date(payment.created_at).toLocaleString()}</div>
                </div>
                <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: payment.status === 'successful' ? 'var(--accent)' : '#ffcc66' }}>
                  {payment.status.toUpperCase()}
                </div>
                <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: 'var(--text)' }}>
                  ${Number(payment.amount_usd ?? 0).toFixed(2)}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </main>
  )
}

export default function PaymentVerifyPage() {
  return (
    <Suspense fallback={<main className="flex flex-1 items-center justify-center px-6 py-20"><div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: 'var(--muted)' }}>LOADING BILLING...</div></main>}>
      <PaymentVerifyPageClient />
    </Suspense>
  )
}
