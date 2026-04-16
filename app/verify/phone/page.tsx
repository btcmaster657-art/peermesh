'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

const BYPASS = process.env.NEXT_PUBLIC_BYPASS_VERIFICATION === 'true'

export default function PhoneVerifyPage() {
  const router = useRouter()
  const supabase = createClient()
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [step, setStep] = useState<'phone' | 'code'>('phone')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function sendCode(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      console.log('session on phone page:', session?.access_token?.slice(0, 20))
      if (!session) {
        setError('Session expired — please sign in again')
        setLoading(false)
        return
      }
      const res = await fetch('/api/verify/phone', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(session ? { 'Authorization': `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ action: 'send', phone }),
      })
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      setStep('code')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to send code')
    } finally {
      setLoading(false)
    }
  }

  async function verifyCode(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch('/api/verify/phone', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(session ? { 'Authorization': `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ action: 'verify', phone, code }),
      })
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      router.push('/verify/payment')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Invalid code')
    } finally {
      setLoading(false)
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '12px 14px',
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: '8px',
    color: 'var(--text)',
    fontSize: '14px',
    outline: 'none',
  }

  const primaryBtn: React.CSSProperties = {
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
              <div style={{ height: '3px', borderRadius: '2px', background: i === 0 ? 'var(--accent)' : 'var(--border)', marginBottom: '6px' }} />
              <span style={{ fontSize: '10px', fontFamily: 'var(--font-geist-mono)', color: i === 0 ? 'var(--accent)' : 'var(--muted)', letterSpacing: '0.5px' }}>
                {label.toUpperCase()}
              </span>
            </div>
          ))}
        </div>

        <h2 style={{ fontSize: '20px', fontWeight: 600, marginBottom: '8px' }}>
          {step === 'phone' ? 'Verify your phone' : 'Enter the code'}
        </h2>
        <p style={{ color: 'var(--muted)', fontSize: '13px', marginBottom: '24px', lineHeight: 1.6 }}>
          {step === 'phone'
            ? 'We\'ll send a one-time code to confirm your number.'
            : `Code sent to ${phone}. ${BYPASS ? 'In test mode, use 123456.' : ''}`}
        </p>

        {step === 'phone' ? (
          <form onSubmit={sendCode} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <input
              style={inputStyle}
              type="tel"
              placeholder="+250 700 000 000"
              value={phone}
              onChange={e => setPhone(e.target.value)}
              required
            />
            {error && <p style={{ color: 'var(--danger)', fontSize: '13px' }}>{error}</p>}
            <button type="submit" disabled={loading} style={primaryBtn}>
              {loading ? 'SENDING...' : 'SEND CODE'}
            </button>
          </form>
        ) : (
          <form onSubmit={verifyCode} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <input
              style={{ ...inputStyle, textAlign: 'center', fontSize: '24px', letterSpacing: '8px', fontFamily: 'var(--font-geist-mono)' }}
              type="text"
              placeholder="000000"
              value={code}
              onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              maxLength={6}
              required
            />
            {error && <p style={{ color: 'var(--danger)', fontSize: '13px' }}>{error}</p>}
            <button type="submit" disabled={loading} style={primaryBtn}>
              {loading ? 'VERIFYING...' : 'VERIFY CODE'}
            </button>
            <button type="button" onClick={() => setStep('phone')} style={{ background: 'none', border: 'none', color: 'var(--muted)', fontSize: '13px', cursor: 'pointer', padding: '8px' }}>
              ← Change number
            </button>
          </form>
        )}
      </div>
    </main>
  )
}
