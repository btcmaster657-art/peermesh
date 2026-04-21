'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import Link from 'next/link'

type Country = { code: string; name: string; flag: string; region: string }

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '12px 14px',
  background: 'var(--surface)', border: '1px solid var(--border)',
  borderRadius: '8px', color: 'var(--text)', fontSize: '14px', outline: 'none',
  boxSizing: 'border-box',
}

const PAGE_SIZE = 50

export default function AuthForm() {
  const searchParams = useSearchParams()
  const router       = useRouter()
  const supabase     = createClient()

  const [mode, setMode]           = useState<'login' | 'signup'>('login')
  const [email, setEmail]         = useState('')
  const [password, setPassword]   = useState('')
  const [username, setUsername]   = useState('')
  const [countryCode, setCountryCode] = useState('RW')
  const [error, setError]         = useState('')
  const [loading, setLoading]     = useState(false)

  // Country picker state
  const [countries, setCountries]       = useState<Country[]>([])
  const [countryPage, setCountryPage]   = useState(1)
  const [countryPages, setCountryPages] = useState(1)
  const [countryLoading, setCountryLoading] = useState(false)
  const [countryError, setCountryError]     = useState(false)
  const [countrySearch, setCountrySearch]   = useState('')

  const extId    = searchParams.get('ext_id')
  const activate = searchParams.get('activate') === '1' || searchParams.get('source') === 'activate'

  useEffect(() => {
    setMode((searchParams.get('mode') as 'login' | 'signup') || 'login')
  }, [searchParams])

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) return
      if (activate) { router.push('/extension?activate=1'); return }
      if (extId) {
        await fetch('/api/extension-auth', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ext_id: extId }),
        })
        router.push(`/extension?ext_id=${extId}`)
        return
      }
      router.push('/dashboard')
    })
  }, [extId, activate])

  const loadCountries = useCallback(async (page = 1, search = '') => {
    setCountryLoading(true)
    setCountryError(false)
    try {
      const qs = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) })
      if (search) qs.set('q', search)
      const res = await fetch(`/api/countries?${qs}`)
      if (!res.ok) throw new Error('failed')
      const data = await res.json()
      setCountries(data.countries ?? [])
      setCountryPages(data.pages ?? 1)
      setCountryPage(page)
      // Use IP-detected country as default on first load
      if (page === 1 && !search && data.detectedCountry) {
        const detected = (data.countries as Country[]).find(c => c.code === data.detectedCountry)
        if (detected) setCountryCode(detected.code)
      }
    } catch {
      setCountryError(true)
    } finally {
      setCountryLoading(false)
    }
  }, [])

  // Load countries when signup mode is shown
  useEffect(() => {
    if (mode === 'signup' && countries.length === 0) loadCountries(1, '')
  }, [mode, countries.length, loadCountries])

  // Debounced search
  useEffect(() => {
    if (mode !== 'signup') return
    const t = setTimeout(() => loadCountries(1, countrySearch), 300)
    return () => clearTimeout(t)
  }, [countrySearch, mode, loadCountries])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      if (mode === 'signup') {
        const { data, error } = await supabase.auth.signUp({
          email, password,
          options: { data: { username, country_code: countryCode } },
        })
        if (error) throw error

        let session = data.session
        if (!session) {
          const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({ email, password })
          if (signInError) throw signInError
          session = signInData.session
        }
        if (session) await supabase.auth.setSession(session)

        // Send email confirmation token
        await fetch('/api/auth/confirm-email', { method: 'POST' }).catch(() => {})
        router.push('/auth/confirm-email')
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) throw error

        // Check if email is confirmed
        const { data: { user } } = await supabase.auth.getUser()
        if (!user?.email_confirmed_at) {
          return router.push('/auth/confirm-email')
        }

        const { data: profile } = await supabase
          .from('profiles').select('is_verified, phone_number').eq('id', data.user.id).single()

        if (!profile?.phone_number) return router.push('/verify/phone')
        if (!profile?.is_verified)  return router.push('/verify/payment')

        if (extId) {
          await fetch('/api/extension-auth', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ext_id: extId }),
          })
          router.push(`/extension?ext_id=${extId}`)
        } else if (activate) {
          router.push('/extension?activate=1')
        } else {
          router.push('/dashboard')
        }
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
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

        <div style={{ display: 'flex', background: 'var(--surface)', borderRadius: '10px', padding: '4px', marginBottom: '28px', border: '1px solid var(--border)' }}>
          {(['login', 'signup'] as const).map(m => (
            <button key={m} onClick={() => setMode(m)} style={{ flex: 1, padding: '10px', borderRadius: '7px', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-geist-mono)', fontSize: '12px', letterSpacing: '0.5px', background: mode === m ? 'var(--accent)' : 'transparent', color: mode === m ? '#000' : 'var(--muted)', fontWeight: mode === m ? 700 : 400, transition: 'all 0.2s' }}>
              {m === 'login' ? 'SIGN IN' : 'SIGN UP'}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {mode === 'signup' && (
            <>
              <input style={inputStyle} placeholder="Username" value={username} onChange={e => setUsername(e.target.value)} required />

              {/* Country picker */}
              <div>
                <input
                  style={{ ...inputStyle, marginBottom: '6px' }}
                  placeholder="Search country..."
                  value={countrySearch}
                  onChange={e => setCountrySearch(e.target.value)}
                />
                {countryLoading ? (
                  <div style={{ padding: '10px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--muted)', fontSize: '12px', fontFamily: 'var(--font-geist-mono)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ display: 'inline-block', width: '10px', height: '10px', border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
                    Loading countries...
                    <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
                  </div>
                ) : countryError ? (
                  <div style={{ padding: '10px', background: 'rgba(255,68,102,0.08)', border: '1px solid rgba(255,68,102,0.25)', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ color: '#ff6060', fontSize: '12px' }}>Could not load countries</span>
                    <button type="button" onClick={() => loadCountries(countryPage, countrySearch)} style={{ background: 'none', border: 'none', color: 'var(--accent)', fontSize: '11px', cursor: 'pointer', fontFamily: 'var(--font-geist-mono)' }}>RETRY</button>
                  </div>
                ) : (
                  <>
                    <select
                      style={{ ...inputStyle, cursor: 'pointer' }}
                      value={countryCode}
                      onChange={e => setCountryCode(e.target.value)}
                    >
                      {countries.map(c => (
                        <option key={c.code} value={c.code}>{c.flag} {c.name}</option>
                      ))}
                    </select>
                    {countryPages > 1 && (
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '6px' }}>
                        <button type="button" disabled={countryPage <= 1} onClick={() => loadCountries(countryPage - 1, countrySearch)} style={{ background: 'none', border: '1px solid var(--border)', color: countryPage <= 1 ? 'var(--muted)' : 'var(--text)', borderRadius: '6px', padding: '4px 10px', fontSize: '11px', cursor: countryPage <= 1 ? 'not-allowed' : 'pointer', fontFamily: 'var(--font-geist-mono)' }}>← PREV</button>
                        <span style={{ fontSize: '11px', color: 'var(--muted)', fontFamily: 'var(--font-geist-mono)' }}>{countryPage} / {countryPages}</span>
                        <button type="button" disabled={countryPage >= countryPages} onClick={() => loadCountries(countryPage + 1, countrySearch)} style={{ background: 'none', border: '1px solid var(--border)', color: countryPage >= countryPages ? 'var(--muted)' : 'var(--text)', borderRadius: '6px', padding: '4px 10px', fontSize: '11px', cursor: countryPage >= countryPages ? 'not-allowed' : 'pointer', fontFamily: 'var(--font-geist-mono)' }}>NEXT →</button>
                      </div>
                    )}
                  </>
                )}
              </div>
            </>
          )}

          <input style={inputStyle} type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} required />
          <input style={inputStyle} type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} required minLength={8} />

          {mode === 'login' && (
            <div style={{ textAlign: 'right', marginTop: '-4px' }}>
              <Link href="/auth/forgot-password" style={{ color: 'var(--muted)', fontSize: '12px', fontFamily: 'var(--font-geist-mono)', textDecoration: 'none' }}>
                Forgot password?
              </Link>
            </div>
          )}

          {error && (
            <p style={{ color: 'var(--danger)', fontSize: '13px', padding: '10px 14px', background: 'rgba(255,68,102,0.1)', borderRadius: '8px', border: '1px solid rgba(255,68,102,0.2)', margin: 0 }}>
              {error}
            </p>
          )}

          <button
            type="submit" disabled={loading}
            style={{ padding: '14px', background: loading ? 'var(--muted)' : 'var(--accent)', color: '#000', border: 'none', borderRadius: '10px', fontFamily: 'var(--font-geist-mono)', fontSize: '13px', fontWeight: 700, letterSpacing: '0.5px', cursor: loading ? 'not-allowed' : 'pointer', marginTop: '4px' }}
          >
            {loading ? 'LOADING...' : mode === 'login' ? 'SIGN IN' : 'CREATE ACCOUNT'}
          </button>
        </form>
      </div>
    </main>
  )
}
