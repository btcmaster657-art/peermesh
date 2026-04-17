'use client'

import { useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

export default function AuthForm() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const supabase = createClient()

  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [username, setUsername] = useState('')
  const [countryCode, setCountryCode] = useState('RW')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const extId = searchParams.get('ext_id')

  useEffect(() => {
    setMode((searchParams.get('mode') as 'login' | 'signup') || 'login')
  }, [searchParams])

  // If already signed in and ext_id present, write token and wait for desktop to pick it up
  useEffect(() => {
    if (!extId) return
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) return
      await fetch('/api/extension-auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ext_id: extId }),
      })
      // Give the desktop app 6s to poll and pick up the token before redirecting
      setTimeout(() => router.push('/dashboard'), 6000)
    })
  }, [extId])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      if (mode === 'signup') {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { username, country_code: countryCode } },
        })
        if (error) throw error

        // If email confirmation is off, signUp returns a session directly
        // If not, sign in immediately to get a session
        let session = data.session
        if (!session) {
          const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({ email, password })
          if (signInError) throw signInError
          session = signInData.session
        }
        if (session) {
          await supabase.auth.setSession(session)
        }
        router.push('/verify/phone')
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) throw error

        const { data: profile } = await supabase
          .from('profiles')
          .select('is_verified, phone_number')
          .eq('id', data.user.id)
          .single()

        if (!profile?.phone_number) return router.push('/verify/phone')
        if (!profile?.is_verified) return router.push('/verify/payment')

        if (extId) {
          await fetch('/api/extension-auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ext_id: extId }),
          })
        }
        router.push('/dashboard')
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
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

  return (
    <main className="flex flex-1 items-center justify-center px-6 py-20">
      <div style={{ width: '100%', maxWidth: '400px' }}>
        <div style={{ fontFamily: 'var(--font-geist-mono)', color: 'var(--accent)', fontSize: '13px', letterSpacing: '4px', marginBottom: '32px', textAlign: 'center' }}>
          PEERMESH
        </div>

        <div style={{ display: 'flex', background: 'var(--surface)', borderRadius: '10px', padding: '4px', marginBottom: '28px', border: '1px solid var(--border)' }}>
          {(['login', 'signup'] as const).map(m => (
            <button
              key={m}
              onClick={() => setMode(m)}
              style={{
                flex: 1, padding: '10px', borderRadius: '7px', border: 'none', cursor: 'pointer',
                fontFamily: 'var(--font-geist-mono)', fontSize: '12px', letterSpacing: '0.5px',
                background: mode === m ? 'var(--accent)' : 'transparent',
                color: mode === m ? '#000' : 'var(--muted)',
                fontWeight: mode === m ? 700 : 400,
                transition: 'all 0.2s',
              }}
            >
              {m === 'login' ? 'SIGN IN' : 'SIGN UP'}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {mode === 'signup' && (
            <>
              <input style={inputStyle} placeholder="Username" value={username} onChange={e => setUsername(e.target.value)} required />
              <select style={{ ...inputStyle, cursor: 'pointer' }} value={countryCode} onChange={e => setCountryCode(e.target.value)}>
                {[['RW','Rwanda'],['NG','Nigeria'],['KE','Kenya'],['ZA','South Africa'],['GB','United Kingdom'],['US','United States'],['DE','Germany'],['CA','Canada'],['AU','Australia'],['BR','Brazil'],['JP','Japan'],['GH','Ghana']].map(([code, name]) => (
                  <option key={code} value={code}>{name}</option>
                ))}
              </select>
            </>
          )}

          <input style={inputStyle} type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} required />
          <input style={inputStyle} type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} required minLength={8} />

          {error && (
            <p style={{ color: 'var(--danger)', fontSize: '13px', padding: '10px 14px', background: 'rgba(255,68,102,0.1)', borderRadius: '8px', border: '1px solid rgba(255,68,102,0.2)' }}>
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            style={{
              padding: '14px', background: loading ? 'var(--muted)' : 'var(--accent)', color: '#000',
              border: 'none', borderRadius: '10px', fontFamily: 'var(--font-geist-mono)',
              fontSize: '13px', fontWeight: 700, letterSpacing: '0.5px',
              cursor: loading ? 'not-allowed' : 'pointer', marginTop: '4px',
            }}
          >
            {loading ? 'LOADING...' : mode === 'login' ? 'SIGN IN' : 'CREATE ACCOUNT'}
          </button>
        </form>
      </div>
    </main>
  )
}
