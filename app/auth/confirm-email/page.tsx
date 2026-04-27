'use client'

import { Suspense, useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

function ConfirmEmailPageClient() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [token,   setToken]   = useState('')
  const [loading, setLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [error,   setError]   = useState('')
  const [done,    setDone]    = useState(false)
  const [resent,  setResent]  = useState(false)
  const extId = searchParams.get('ext_id')
  const activate = searchParams.get('activate') === '1'

  // Auto-send on mount
  useEffect(() => { sendCode() }, [])

  async function finishConfirmedRoute() {
    if (extId) {
      await fetch('/api/extension-auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ext_id: extId }),
      }).catch(() => {})
      router.push(`/extension?ext_id=${extId}`)
      return
    }
    if (activate) {
      router.push('/extension?activate=1')
      return
    }
    router.push('/dashboard')
  }

  async function sendCode() {
    setSending(true)
    setResent(false)
    try {
      await fetch('/api/auth/confirm-email', { method: 'POST' })
      setResent(true)
    } catch {}
    finally { setSending(false) }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await fetch('/api/auth/confirm-email', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Invalid code'); return }
      setDone(true)
      setTimeout(() => { void finishConfirmedRoute() }, 800)
    } catch {
      setError('Network error — please try again')
    } finally {
      setLoading(false)
    }
  }

  if (done) {
    return (
      <main className="flex flex-1 items-center justify-center px-6 py-20">
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '32px', marginBottom: '16px' }}>✅</div>
          <div style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text)', marginBottom: '8px' }}>Email confirmed</div>
          <p style={{ color: 'var(--muted)', fontSize: '13px' }}>Opening your dashboard...</p>
        </div>
      </main>
    )
  }

  return (
    <main className="flex flex-1 items-center justify-center px-6 py-20">
      <div style={{ width: '100%', maxWidth: '400px' }}>
        <div style={{ fontFamily: 'var(--font-geist-mono)', color: 'var(--accent)', fontSize: '13px', letterSpacing: '4px', marginBottom: '32px', textAlign: 'center' }}>
          PEERMESH
        </div>

        <div style={{ fontSize: '18px', fontWeight: 600, color: 'var(--text)', marginBottom: '8px' }}>Confirm your email</div>
        <p style={{ color: 'var(--muted)', fontSize: '13px', lineHeight: 1.7, marginBottom: '24px' }}>
          {sending ? 'Sending code...' : resent ? 'We sent a 6-digit code to your email. It expires in 15 minutes.' : 'Enter the 6-digit code from your email.'}
        </p>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <input
            style={{ width: '100%', padding: '16px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text)', fontFamily: 'var(--font-geist-mono)', fontSize: '28px', letterSpacing: '12px', textAlign: 'center', outline: 'none', boxSizing: 'border-box' }}
            type="text" inputMode="numeric" maxLength={6} placeholder="000000" autoFocus
            value={token} onChange={e => setToken(e.target.value.replace(/\D/g, '').slice(0, 6))} required
          />

          {error && (
            <p style={{ color: 'var(--danger)', fontSize: '12px', padding: '10px 14px', background: 'rgba(255,68,102,0.1)', borderRadius: '8px', border: '1px solid rgba(255,68,102,0.2)', margin: 0 }}>
              {error}
            </p>
          )}

          <button
            type="submit" disabled={loading || token.length < 6}
            style={{ padding: '13px', background: (loading || token.length < 6) ? 'var(--muted)' : 'var(--accent)', color: '#000', border: 'none', borderRadius: '10px', fontFamily: 'var(--font-geist-mono)', fontSize: '12px', fontWeight: 700, letterSpacing: '0.5px', cursor: (loading || token.length < 6) ? 'not-allowed' : 'pointer' }}
          >
            {loading ? 'VERIFYING...' : 'CONFIRM EMAIL'}
          </button>
        </form>

        <div style={{ marginTop: '16px', textAlign: 'center' }}>
          <button
            onClick={sendCode} disabled={sending}
            style={{ background: 'none', border: 'none', color: 'var(--muted)', fontSize: '12px', cursor: sending ? 'not-allowed' : 'pointer', fontFamily: 'var(--font-geist-mono)' }}
          >
            {sending ? 'Sending...' : 'Resend code'}
          </button>
        </div>
      </div>
    </main>
  )
}

export default function ConfirmEmailPage() {
  return (
    <Suspense fallback={
      <main className="flex flex-1 items-center justify-center px-6 py-20">
        <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '12px', color: 'var(--muted)' }}>
          LOADING...
        </div>
      </main>
    }>
      <ConfirmEmailPageClient />
    </Suspense>
  )
}
