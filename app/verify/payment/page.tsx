'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

const BYPASS = process.env.NEXT_PUBLIC_BYPASS_VERIFICATION === 'true'

export default function PaymentVerifyPage() {
  const router = useRouter()
  const supabase = createClient()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleVerify(bypass = false) {
    setError('')
    setLoading(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch('/api/verify/payment', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(session ? { 'Authorization': `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ bypass }),
      })
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      router.push('/dashboard')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Payment failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="flex flex-1 items-center justify-center px-6 py-20">
      <div style={{ width: '100%', maxWidth: '400px' }}>
        <div style={{ fontFamily: 'var(--font-geist-mono)', color: 'var(--accent)', fontSize: '13px', letterSpacing: '4px', marginBottom: '32px', textAlign: 'center' }}>
          PEERMESH
        </div>

        {/* Progress */}
        <div style={{ display: 'flex', gap: '8px', marginBottom: '32px' }}>
          {['Phone', 'Payment', 'Done'].map((label, i) => (
            <div key={label} style={{ flex: 1, textAlign: 'center' }}>
              <div style={{ height: '3px', borderRadius: '2px', background: i <= 1 ? 'var(--accent)' : 'var(--border)', marginBottom: '6px' }} />
              <span style={{ fontSize: '10px', fontFamily: 'var(--font-geist-mono)', color: i <= 1 ? 'var(--accent)' : 'var(--muted)', letterSpacing: '0.5px' }}>
                {label.toUpperCase()}
              </span>
            </div>
          ))}
        </div>

        <h2 style={{ fontSize: '20px', fontWeight: 600, marginBottom: '8px' }}>One-time verification</h2>
        <p style={{ color: 'var(--muted)', fontSize: '13px', marginBottom: '28px', lineHeight: 1.6 }}>
          A $1 charge confirms your identity and protects every peer in the network.
          Your card is saved for optional premium upgrades — no auto-charges.
        </p>

        {/* What you get */}
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '10px', padding: '16px', marginBottom: '24px' }}>
          {[
            ['✓', 'Full access to peer network'],
            ['✓', 'Browse from 20+ countries'],
            ['✓', '5GB free bandwidth/month'],
            ['✓', 'Accountability receipt — your IP is protected'],
          ].map(([icon, text]) => (
            <div key={text} style={{ display: 'flex', gap: '10px', marginBottom: '10px', fontSize: '13px' }}>
              <span style={{ color: 'var(--accent)', fontFamily: 'var(--font-geist-mono)' }}>{icon}</span>
              <span style={{ color: 'var(--text)' }}>{text}</span>
            </div>
          ))}
        </div>

        {error && (
          <p style={{ color: 'var(--danger)', fontSize: '13px', marginBottom: '16px', padding: '10px 14px', background: 'rgba(255,68,102,0.1)', borderRadius: '8px', border: '1px solid rgba(255,68,102,0.2)' }}>
            {error}
          </p>
        )}

        {BYPASS ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style={{ padding: '10px 14px', background: 'rgba(255,170,0,0.1)', border: '1px solid rgba(255,170,0,0.3)', borderRadius: '8px', fontSize: '12px', color: '#ffaa00', fontFamily: 'var(--font-geist-mono)', textAlign: 'center' }}>
              TEST MODE — no real charge
            </div>
            <button
              onClick={() => handleVerify(true)}
              disabled={loading}
              style={{
                width: '100%',
                padding: '14px',
                background: loading ? 'var(--muted)' : 'var(--accent)',
                color: '#000',
                border: 'none',
                borderRadius: '10px',
                fontFamily: 'var(--font-geist-mono)',
                fontSize: '13px',
                fontWeight: 700,
                letterSpacing: '0.5px',
                cursor: loading ? 'not-allowed' : 'pointer',
              }}
            >
              {loading ? 'ACTIVATING...' : 'SKIP — ACTIVATE TEST ACCOUNT'}
            </button>
          </div>
        ) : (
          <button
            onClick={() => handleVerify(false)}
            disabled={loading}
            style={{
              width: '100%',
              padding: '14px',
              background: loading ? 'var(--muted)' : 'var(--accent)',
              color: '#000',
              border: 'none',
              borderRadius: '10px',
              fontFamily: 'var(--font-geist-mono)',
              fontSize: '13px',
              fontWeight: 700,
              letterSpacing: '0.5px',
              cursor: loading ? 'not-allowed' : 'pointer',
            }}
          >
            {loading ? 'PROCESSING...' : 'PAY $1 AND ACTIVATE'}
          </button>
        )}

        <p style={{ marginTop: '16px', color: 'var(--muted)', fontSize: '11px', textAlign: 'center', lineHeight: 1.6 }}>
          Secured by Stripe. Cancel premium anytime. $1 is non-refundable.
        </p>
      </div>
    </main>
  )
}
