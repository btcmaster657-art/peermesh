'use client'

import { useState, useEffect } from 'react'

const STORE_URL = 'https://chrome.google.com/webstore/detail/peermesh/YOUR_EXTENSION_ID'
const mono = "'Courier New', monospace"

export default function ExtensionPageClient() {
  const [step, setStep] = useState<'idle' | 'downloading' | 'guide' | 'done'>('idle')
  const [copied, setCopied] = useState(false)
  const [toast, setToast] = useState('')
  const [authed, setAuthed] = useState(false)
  const [sending, setSending] = useState(false)

  function showToast(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(''), 2500)
  }

  useEffect(() => {
    // Auto-detect if coming from share toggle
    if (window.location.hash === '#share') {
      document.title = 'PeerMesh — Install to Share'
    }
    const interval = setInterval(() => {
      if (document.querySelector('[data-peermesh-extension]')) {
        setStep('done')
        clearInterval(interval)
      }
    }, 1000)
    return () => clearInterval(interval)
  }, [])

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
      const res = await fetch('/api/extension-auth')
      const data = await res.json()
      if (data.error) throw new Error(data.error)
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

  return (
    <>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes slideup { from { opacity: 0; transform: translateX(-50%) translateY(10px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }
      `}</style>

      <main style={{ maxWidth: '520px', margin: '0 auto', width: '100%', padding: '40px 20px' }}>

        <div style={{ fontFamily: mono, color: 'var(--accent)', fontSize: '12px', letterSpacing: '4px', marginBottom: '28px' }}>
          PEERMESH
        </div>

        {/* ── Done ── */}
        {step === 'done' && (
          <div style={{ ...card, border: '1px solid var(--accent)', background: 'var(--accent-dim)', textAlign: 'center' }}>
            <div style={{ fontSize: '32px', marginBottom: '12px' }}>✓</div>
            <div style={{ fontFamily: mono, color: 'var(--accent)', fontSize: '13px', marginBottom: '8px', letterSpacing: '1px' }}>
              EXTENSION INSTALLED
            </div>
            <p style={{ color: 'var(--muted)', fontSize: '13px', lineHeight: 1.7, marginBottom: authed ? 0 : '16px' }}>
              Click the PeerMesh icon in your Chrome toolbar to start browsing.
            </p>
            {!authed && (
              <button
                onClick={sendAuthToExtension}
                disabled={sending}
                style={{ padding: '11px 20px', background: 'var(--accent)', color: '#000', border: 'none', borderRadius: '8px', fontFamily: mono, fontSize: '11px', fontWeight: 700, cursor: sending ? 'not-allowed' : 'pointer', letterSpacing: '0.5px' }}
              >
                {sending ? 'SIGNING IN...' : 'SIGN IN TO EXTENSION'}
              </button>
            )}
          </div>
        )}

        {/* ── Guide ── */}
        {step === 'guide' && (
          <div>
            <h2 style={{ fontSize: '20px', fontWeight: 700, marginBottom: '8px' }}>3 steps to finish</h2>
            <p style={{ color: 'var(--muted)', fontSize: '13px', marginBottom: '20px', lineHeight: 1.6 }}>
              ZIP downloaded to your Downloads folder. Now:
            </p>

            {[
              { icon: '📦', title: 'Unzip the downloaded file', desc: 'Find peermesh-extension.zip in your Downloads. Right-click it → Extract All (Windows) or double-click (Mac). You’ll get a folder called peermesh-extension.' },
              { icon: '🔧', title: 'Open Chrome Extensions & enable Developer Mode', desc: 'Copy the URL below and paste it in your Chrome address bar. Toggle "Developer mode" in the top-right corner.' },
              { icon: '📂', title: 'Click “Load unpacked” → select the folder', desc: 'Click “Load unpacked”, then select the peermesh-extension folder you just unzipped. The PeerMesh icon will appear in your toolbar.' },
            ].map((s, i) => (
              <div key={i} style={{ display: 'flex', gap: '14px', ...card }}>
                <div style={{ fontSize: '24px', flexShrink: 0 }}>{s.icon}</div>
                <div>
                  <div style={{ fontWeight: 600, marginBottom: '4px', fontSize: '13px' }}>{s.title}</div>
                  <div style={{ color: 'var(--muted)', fontSize: '12px', lineHeight: 1.6 }}>{s.desc}</div>
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

            <div style={{ display: 'flex', gap: '10px' }}>
              <button
                onClick={() => setStep('done')}
                style={{ flex: 1, padding: '12px', background: 'var(--accent)', color: '#000', border: 'none', borderRadius: '8px', fontFamily: mono, fontSize: '11px', fontWeight: 700, cursor: 'pointer', letterSpacing: '0.5px' }}
              >
                I INSTALLED IT ✓
              </button>
              <button
                onClick={handleDownload}
                style={{ padding: '12px 14px', background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)', borderRadius: '8px', fontFamily: mono, fontSize: '11px', cursor: 'pointer' }}
              >
                RE-DOWNLOAD
              </button>
            </div>
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
              <a
                href="/api/desktop-download"
                style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '10px 14px', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: '8px', textDecoration: 'none', fontFamily: mono, fontSize: '11px', letterSpacing: '0.5px' }}
              >
                DOWNLOAD DESKTOP HELPER
              </a>
            </div>

            <a
              href={STORE_URL}
              target="_blank"
              rel="noopener noreferrer"
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px', padding: '15px', background: 'var(--accent)', color: '#000', borderRadius: '10px', fontFamily: mono, fontSize: '13px', fontWeight: 700, textDecoration: 'none', letterSpacing: '0.5px', marginBottom: '10px' }}
            >
              🧩 ADD TO CHROME — FREE
            </a>

            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', margin: '14px 0' }}>
              <div style={{ flex: 1, height: '1px', background: 'var(--border)' }} />
              <span style={{ color: 'var(--muted)', fontSize: '11px', fontFamily: mono }}>OR</span>
              <div style={{ flex: 1, height: '1px', background: 'var(--border)' }} />
            </div>

            <button
              onClick={handleDownload}
              disabled={step === 'downloading'}
              style={{ width: '100%', padding: '14px', background: 'transparent', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: '10px', fontFamily: mono, fontSize: '12px', cursor: step === 'downloading' ? 'not-allowed' : 'pointer', letterSpacing: '0.5px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}
            >
              {step === 'downloading' ? (
                <>
                  <span style={{ display: 'inline-block', width: '12px', height: '12px', border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
                  DOWNLOADING...
                </>
              ) : '↓ DOWNLOAD & INSTALL MANUALLY'}
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

      {/* Toast */}
      {toast && (
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
