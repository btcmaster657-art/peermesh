'use client'

import { useState, useEffect } from 'react'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

const mono = "'Courier New', monospace"

// ── Device Activation Screen ──────────────────────────────────────────────────
function ActivateScreen() {
  const searchParams = useSearchParams()
  const [code, setCode] = useState(() => {
    const raw = (searchParams.get('code') ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
    return raw.length >= 4 ? `${raw.slice(0, 4)}-${raw.slice(4, 8)}` : raw
  })
  const [status, setStatus] = useState<'checking' | 'redirect' | 'idle' | 'loading' | 'approved' | 'denied' | 'error'>('checking')
  const [error, setError] = useState('')

  // Check if user is already logged in; if not, redirect to sign-in then back
  useEffect(() => {
    const supabase = createClient()
    supabase.auth.getSession().then(({ data: { session } }) => {
      setStatus(session ? 'idle' : 'redirect')
    }).catch(() => setStatus('redirect'))
  }, [])

  useEffect(() => {
    if ((status as string) === 'redirect') {
      window.location.href = `/auth?mode=login&source=activate&activate=1`
    }
  }, [status])

  function handleCodeChange(val: string) {
    const clean = val.toUpperCase().replace(/[^A-Z0-9]/g, '')
    if (clean.length <= 4) setCode(clean)
    else setCode(`${clean.slice(0, 4)}-${clean.slice(4, 8)}`)
  }

  const codeReady = code.replace(/[^A-Z0-9]/g, '').length === 8

  async function handleAction(action: 'approve' | 'deny') {
    setStatus('loading')
    setError('')
    try {
      const res = await fetch('/api/extension-auth', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_code: code.toUpperCase().trim(), action }),
      })
      const data = await res.json()
      if (res.status === 401) { window.location.href = `/auth?mode=login&source=activate&activate=1`; return }
      if (!res.ok) { setError(data.error ?? 'Something went wrong'); setStatus('error'); return }
      setStatus(action === 'approve' ? 'approved' : 'denied')
    } catch {
      setError('Network error — please try again')
      setStatus('error')
    }
  }

  const card: React.CSSProperties = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '12px', padding: '24px', width: '100%', maxWidth: '400px' }

  if (status === 'checking' || (status as string) === 'redirect') return (
    <div style={{ ...card, textAlign: 'center' }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <span style={{ display: 'inline-block', width: '20px', height: '20px', border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
    </div>
  )

  if (status === 'approved') return (
    <div style={{ ...card, textAlign: 'center' }}>
      <div style={{ fontSize: '40px', marginBottom: '12px' }}>✅</div>
      <div style={{ fontFamily: mono, color: 'var(--accent)', fontSize: '13px', marginBottom: '8px', letterSpacing: '1px' }}>AUTHORIZED</div>
      <div style={{ fontSize: '13px', color: 'var(--muted)' }}>You can close this tab. The app is now signed in.</div>
    </div>
  )

  if (status === 'denied') return (
    <div style={{ ...card, textAlign: 'center' }}>
      <div style={{ fontSize: '40px', marginBottom: '12px' }}>🚫</div>
      <div style={{ fontFamily: mono, color: '#ff6060', fontSize: '13px', marginBottom: '8px', letterSpacing: '1px' }}>REQUEST DENIED</div>
      <div style={{ fontSize: '13px', color: 'var(--muted)' }}>The sign-in request was rejected.</div>
    </div>
  )

  return (
    <div style={card}>
      <div style={{ fontFamily: mono, color: 'var(--accent)', fontSize: '12px', letterSpacing: '4px', marginBottom: '20px', textAlign: 'center' }}>PEERMESH</div>
      <div style={{ fontSize: '15px', fontWeight: 600, marginBottom: '6px', textAlign: 'center' }}>Authorize App</div>
      <div style={{ fontSize: '13px', color: 'var(--muted)', marginBottom: '24px', textAlign: 'center' }}>Enter the code shown in your PeerMesh app or CLI</div>
      <input
        value={code}
        onChange={e => handleCodeChange(e.target.value)}
        placeholder="XXXX-XXXX"
        maxLength={9}
        autoFocus
        style={{ width: '100%', padding: '12px 16px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text)', fontFamily: mono, fontSize: '20px', letterSpacing: '4px', textAlign: 'center', marginBottom: '16px', boxSizing: 'border-box' }}
      />
      {error && <div style={{ color: '#ff6060', fontSize: '12px', marginBottom: '12px', textAlign: 'center' }}>{error}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
        <button onClick={() => handleAction('deny')} disabled={!codeReady || status === 'loading'}
          style={{ padding: '12px', background: 'none', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--muted)', cursor: !codeReady || status === 'loading' ? 'not-allowed' : 'pointer', fontFamily: mono, fontSize: '11px' }}>
          DENY
        </button>
        <button onClick={() => handleAction('approve')} disabled={!codeReady || status === 'loading'}
          style={{ padding: '12px', background: codeReady ? 'var(--accent)' : 'var(--surface)', border: `1px solid ${codeReady ? 'transparent' : 'var(--border)'}`, borderRadius: '8px', color: codeReady ? '#000' : 'var(--muted)', cursor: !codeReady || status === 'loading' ? 'not-allowed' : 'pointer', fontFamily: mono, fontSize: '11px', fontWeight: 700, transition: 'all 0.15s' }}>
          {status === 'loading' ? 'AUTHORIZING...' : 'AUTHORIZE'}
        </button>
      </div>
    </div>
  )
}

export default function ExtensionPageClient() {
  const searchParams = useSearchParams()
  const isActivate = searchParams.get('activate') === '1' || !!searchParams.get('code')
  const urlExtId = searchParams.get('ext_id') ?? ''

  const [authChecked, setAuthChecked] = useState(false)
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [step, setStep] = useState<'idle' | 'downloading' | 'guide' | 'done'>('idle')
  const [desktopDownloading, setDesktopDownloading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [toast, setToast] = useState('')
  const [authed, setAuthed] = useState(false)
  const [sending, setSending] = useState(false)

  function showToast(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(''), 2500)
  }

  useEffect(() => {
    if (isActivate) return

    if (window.location.hash === '#share') {
      document.title = 'PeerMesh — Install to Share'
    }

    // If ext_id present, check auth so we can auto sign-in to the extension
    if (urlExtId) {
      const supabase = createClient()
      supabase.auth.getSession().then(({ data: { session } }) => {
        setIsLoggedIn(!!session)
        setAuthChecked(true)
      }).catch(() => { setIsLoggedIn(false); setAuthChecked(true) })
    } else {
      setAuthChecked(true)
    }

    // Detect extension presence
    const interval = setInterval(() => {
      if (document.querySelector('[data-peermesh-extension]')) {
        setStep('done')
        clearInterval(interval)
      }
    }, 1000)
    return () => clearInterval(interval)
  }, [isActivate])

  // Auto sign-in to extension once auth is confirmed and ext_id is present
  // Only runs after authChecked so we never call it before knowing login state
  useEffect(() => {
    if (!urlExtId || isActivate || !authChecked || !isLoggedIn) return
    sendAuthToExtension()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlExtId, authChecked, isLoggedIn])

  async function handleDownload() {
    setStep('downloading')
    const a = document.createElement('a')
    a.href = '/api/extension-download'
    a.download = 'peermesh-extension.zip'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => setStep('guide'), 800)
  }

  async function copyUrl() {
    const text = 'chrome://extensions'
    let success = false

    if (navigator.clipboard && window.isSecureContext) {
      try { await navigator.clipboard.writeText(text); success = true } catch {}
    }

    if (!success) {
      try {
        const el = document.createElement('textarea')
        el.value = text
        el.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0'
        document.body.appendChild(el)
        el.focus()
        el.select()
        el.setSelectionRange(0, text.length)
        success = document.execCommand('copy')
        document.body.removeChild(el)
      } catch {}
    }

    if (success) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
      showToast('✓ Copied! Paste it in your Chrome address bar')
    } else {
      showToast('Could not copy — please select and copy manually')
    }
  }

  async function sendAuthToExtension() {
    setSending(true)
    try {
      const extId = urlExtId || document.querySelector<HTMLElement>('[data-peermesh-extension]')?.dataset.extId
      if (!extId) throw new Error('Extension not detected — open this page from the PeerMesh extension popup')
      const res = await fetch('/api/extension-auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ext_id: extId }),
      })
      if (res.status === 401) {
        window.location.href = `/auth?mode=login&source=extension&ext_id=${extId}`
        return
      }
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Something went wrong')
      setAuthed(true)
      setStep('done')
      showToast('✓ Signed in to extension!')
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed — make sure you are signed in')
    } finally {
      setSending(false)
    }
  }

  const card: React.CSSProperties = {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: '12px',
    padding: '20px',
    marginBottom: '16px',
  }

  // ── Auth gate — only block when ext_id is present and auth hasn't resolved ──
  if (!isActivate && urlExtId && !authChecked) {
    return (
      <main className="flex flex-1 items-center justify-center">
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
          <span style={{ display: 'inline-block', width: '20px', height: '20px', border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
          <div style={{ fontFamily: mono, color: 'var(--muted)', fontSize: '11px', letterSpacing: '2px' }}>CHECKING AUTH...</div>
        </div>
      </main>
    )
  }

  if (!isActivate && urlExtId && authChecked && !isLoggedIn) {
    if (typeof window !== 'undefined') {
      window.location.href = `/auth?mode=login&source=extension&ext_id=${urlExtId}`
    }
    return (
      <main className="flex flex-1 items-center justify-center">
        <div style={{ fontFamily: mono, color: 'var(--muted)', fontSize: '12px', letterSpacing: '2px' }}>REDIRECTING...</div>
      </main>
    )
  }

  return (
    <>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes slideup { from { opacity: 0; transform: translateX(-50%) translateY(10px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }
      `}</style>

      {isActivate ? (
        <main className="flex flex-1 items-center justify-center" style={{ padding: '24px' }}>
          <ActivateScreen />
        </main>
      ) : (
        <main style={{ maxWidth: '520px', margin: '0 auto', width: '100%', padding: '40px 20px' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px', marginBottom: '28px' }}>
          {step !== 'guide' && (
            <a href="/dashboard" style={{ color: 'var(--muted)', fontFamily: mono, fontSize: '11px', textDecoration: 'none', letterSpacing: '0.5px' }}>← BACK</a>
          )}
          <span style={{ fontFamily: mono, color: 'var(--accent)', fontSize: '12px', letterSpacing: '4px' }}>PEERMESH</span>
        </div>

        {/* ── Done ── */}
        {step === 'done' && (
          <div style={{ ...card, border: '1px solid var(--accent)', background: 'var(--accent-dim)', textAlign: 'center' }}>
            <div style={{ fontSize: '32px', marginBottom: '12px' }}>✓</div>
            <div style={{ fontFamily: mono, color: 'var(--accent)', fontSize: '13px', marginBottom: '8px', letterSpacing: '1px' }}>EXTENSION INSTALLED</div>
            <p style={{ color: 'var(--muted)', fontSize: '13px', lineHeight: 1.7, marginBottom: authed ? '16px' : '16px' }}>
              Click the PeerMesh icon in your Chrome toolbar to start browsing.
            </p>
            {!authed && (
              <button
                onClick={sendAuthToExtension}
                disabled={sending}
                style={{ padding: '11px 20px', background: 'var(--accent)', color: '#000', border: 'none', borderRadius: '8px', fontFamily: mono, fontSize: '11px', fontWeight: 700, cursor: sending ? 'not-allowed' : 'pointer', letterSpacing: '0.5px', marginBottom: '10px' }}
              >
                {sending ? 'SIGNING IN...' : 'SIGN IN TO EXTENSION'}
              </button>
            )}
            <div>
              <a href="/dashboard" style={{ fontFamily: mono, fontSize: '10px', color: 'var(--muted)', textDecoration: 'none', letterSpacing: '0.5px' }}>← BACK TO DASHBOARD</a>
            </div>
          </div>
        )}

        {/* ── Guide ── */}
        {step === 'guide' && (
          <div>
            <button
              onClick={() => setStep('idle')}
              style={{ background: 'none', border: 'none', color: 'var(--muted)', fontFamily: mono, fontSize: '11px', cursor: 'pointer', padding: '0 0 20px 0', letterSpacing: '0.5px' }}
            >
              ← BACK
            </button>
            <h2 style={{ fontSize: '20px', fontWeight: 700, marginBottom: '8px' }}>3 steps to finish</h2>
            <p style={{ color: 'var(--muted)', fontSize: '13px', marginBottom: '20px', lineHeight: 1.6 }}>
              ZIP downloaded to your Downloads folder. Now:
            </p>

            {[
              { icon: '📦', title: 'Unzip the downloaded file', desc: 'Find peermesh-extension.zip in your Downloads. Right-click it → Extract All (Windows) or double-click (Mac). You\'ll get a folder called peermesh-extension.' },
              { icon: '🔧', title: 'Open Chrome Extensions & enable Developer Mode', desc: 'Copy the URL below and paste it in your Chrome address bar. Toggle "Developer mode" in the top-right corner.' },
              { icon: '📂', title: 'Click "Load unpacked" → select the folder', desc: 'Click "Load unpacked", then select the peermesh-extension folder you just unzipped. The PeerMesh icon will appear in your toolbar.' },
            ].map((s, i) => (
              <div key={i} style={{ display: 'flex', gap: '14px', ...card }}>
                <div style={{ fontSize: '24px', flexShrink: 0 }}>{s.icon}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, marginBottom: '4px', fontSize: '13px' }}>{s.title}</div>
                  <div style={{ color: 'var(--muted)', fontSize: '12px', lineHeight: 1.6 }}>{s.desc}</div>
                  {i === 2 && (
                    <a href="/dashboard" style={{ display: 'inline-block', marginTop: '12px', padding: '8px 16px', background: 'var(--accent)', color: '#000', borderRadius: '7px', fontFamily: mono, fontSize: '10px', fontWeight: 700, textDecoration: 'none', letterSpacing: '0.5px' }}>
                      GO TO DASHBOARD →
                    </a>
                  )}
                </div>
              </div>
            ))}

            {/* Copyable URL */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '8px', padding: '10px 14px', marginBottom: '16px' }}>
              <code style={{ flex: 1, fontFamily: mono, fontSize: '13px', color: 'var(--accent)', userSelect: 'all' }}>
                chrome://extensions
              </code>
              <button
                onClick={copyUrl}
                style={{ padding: '6px 12px', background: copied ? 'var(--accent)' : 'transparent', color: copied ? '#000' : 'var(--muted)', border: `1px solid ${copied ? 'var(--accent)' : 'var(--border)'}`, borderRadius: '6px', fontFamily: mono, fontSize: '10px', cursor: 'pointer', transition: 'all 0.2s', whiteSpace: 'nowrap', fontWeight: copied ? 700 : 400 }}
              >
                {copied ? '✓ COPIED' : 'COPY'}
              </button>
            </div>

            <button
              onClick={handleDownload}
              style={{ width: '100%', padding: '12px 14px', background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)', borderRadius: '8px', fontFamily: mono, fontSize: '11px', cursor: 'pointer' }}
            >
              RE-DOWNLOAD
            </button>
          </div>
        )}

        {/* ── Default ── */}
        {(step === 'idle' || step === 'downloading') && (
          <div>
            <h1 style={{ fontSize: '26px', fontWeight: 700, lineHeight: 1.2, marginBottom: '12px', letterSpacing: '-0.02em' }}>
              Browse any site through<br />
              <span style={{ color: 'var(--accent)' }}>a real peer's connection</span>
            </h1>
            <p style={{ color: 'var(--muted)', fontSize: '14px', lineHeight: 1.7, marginBottom: '28px' }}>
              YouTube, Google, Netflix — everything works. Your entire browser routes through the peer's real IP.
            </p>

            <div style={{ ...card, marginBottom: '20px' }}>
              <div style={{ fontFamily: mono, fontSize: '10px', color: 'var(--accent)', letterSpacing: '1px', marginBottom: '10px' }}>
                FULL-BROWSER SHARING
              </div>
              <p style={{ color: 'var(--muted)', fontSize: '12px', lineHeight: 1.7, marginBottom: '12px' }}>
                The extension is the control surface. The desktop helper is required when you want to share your own connection for full-browser traffic.
              </p>
              <button
                onClick={async () => {
                  setDesktopDownloading(true)
                  const a = document.createElement('a')
                  a.href = '/api/desktop-download'
                  a.download = ''
                  document.body.appendChild(a)
                  a.click()
                  document.body.removeChild(a)
                  setTimeout(() => setDesktopDownloading(false), 2000)
                }}
                disabled={desktopDownloading}
                style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '8px', padding: '10px 14px', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: '8px', fontFamily: mono, fontSize: '11px', letterSpacing: '0.5px', cursor: desktopDownloading ? 'not-allowed' : 'pointer' }}
              >
                {desktopDownloading ? (
                  <><span style={{ display: 'inline-block', width: '10px', height: '10px', border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />DOWNLOADING...</>
                ) : 'DOWNLOAD DESKTOP HELPER'}
              </button>
            </div>

            <button
              onClick={handleDownload}
              disabled={step === 'downloading'}
              style={{ width: '100%', padding: '14px', background: 'var(--accent)', color: '#000', border: 'none', borderRadius: '10px', fontFamily: mono, fontSize: '12px', fontWeight: 700, cursor: step === 'downloading' ? 'not-allowed' : 'pointer', letterSpacing: '0.5px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}
            >
              {step === 'downloading' ? (
                <>
                  <span style={{ display: 'inline-block', width: '12px', height: '12px', border: '2px solid rgba(0,0,0,0.3)', borderTopColor: '#000', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
                  DOWNLOADING...
                </>
              ) : '↓ DOWNLOAD & INSTALL EXTENSION'}
            </button>

            <p style={{ marginTop: '10px', color: 'var(--muted)', fontSize: '11px', textAlign: 'center' }}>
              ~30 seconds to install · Chrome only
            </p>

            <div style={{ marginTop: '24px', ...card }}>
              <div style={{ fontFamily: mono, fontSize: '10px', color: 'var(--muted)', letterSpacing: '1px', marginBottom: '12px' }}>WHAT YOU GET</div>
              {[
                ['🌍', 'Browse from 12+ countries instantly'],
                ['🎬', 'YouTube, Google, Netflix — everything works'],
                ['🔒', 'Verified peers — cryptographic accountability'],
                ['⚡', 'One click connect, one click disconnect'],
                ['💸', 'Free — share your connection to earn access'],
              ].map(([icon, text]) => (
                <div key={text as string} style={{ display: 'flex', gap: '10px', marginBottom: '8px', fontSize: '13px' }}>
                  <span>{icon}</span>
                  <span style={{ color: 'var(--muted)' }}>{text}</span>
                </div>
              ))}
            </div>
          </div>
        )}

      </main>

      )}

      {/* Toast */}
      {!isActivate && toast && (
        <div style={{
          position: 'fixed',
          bottom: '28px',
          left: '50%',
          transform: 'translateX(-50%)',
          background: '#1e1e2a',
          border: '1px solid var(--accent)',
          color: 'var(--text)',
          padding: '12px 22px',
          borderRadius: '10px',
          fontSize: '13px',
          fontFamily: mono,
          whiteSpace: 'nowrap',
          zIndex: 9999,
          animation: 'slideup 0.2s ease',
          boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
          pointerEvents: 'none',
        }}>
          {toast}
        </div>
      )}
    </>
  )
}
