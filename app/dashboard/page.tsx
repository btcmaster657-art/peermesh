'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { checkDesktop, syncDesktopAuth, startDesktopSharing, stopDesktopSharing } from '@/lib/agent-client'
import { COUNTRIES, formatBytes, getFlagForCountry } from '@/lib/utils'
import type { Profile, PeerAvailability } from '@/lib/types'
import type { DesktopState } from '@/lib/agent-client'

const RELAY = process.env.NEXT_PUBLIC_RELAY_ENDPOINT ?? 'ws://localhost:8080'

export default function Dashboard() {
  const router = useRouter()
  const supabase = createClient()
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const [profile, setProfile] = useState<Profile | null>(null)
  const [peerCounts, setPeerCounts] = useState<Record<string, number>>({})
  const [selectedCountry, setSelectedCountry] = useState<string | null>(null)
  const [isSharing, setIsSharing] = useState(false)
  const [desktop, setDesktop] = useState<DesktopState | null>(null)
  const [desktopChecked, setDesktopChecked] = useState(false)
  const [sharingStats, setSharingStats] = useState({ bytesServed: 0, requestsHandled: 0 })
  const [connecting, setConnecting] = useState(false)
  const [shareToggling, setShareToggling] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [shareError, setShareError] = useState<string | null>(null)
  const [connectError, setConnectError] = useState<string | null>(null)
  const [isOnline, setIsOnline] = useState(true)
  const [latestDesktopVersion, setLatestDesktopVersion] = useState<string | null>(null)
  const [latestExtVersion, setLatestExtVersion] = useState<string | null>(null)
  const [extInstalled, setExtInstalled] = useState(false)
  const [extVersion, setExtVersion] = useState<string | null>(null)

  // ── Network status ──────────────────────────────────────────────────────────
  useEffect(() => {
    const onOnline = () => setIsOnline(true)
    const onOffline = () => setIsOnline(false)
    setIsOnline(navigator.onLine)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    return () => { window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline) }
  }, [])

  // ── Load profile ────────────────────────────────────────────────────────────
  useEffect(() => {
    async function load() {
      try {
        const { data: { user }, error: authError } = await supabase.auth.getUser()
        if (authError) throw new Error('Could not verify session — please refresh')
        if (!user) { router.push('/auth?mode=login'); return }

        const { data, error: profileError } = await supabase.from('profiles').select('*').eq('id', user.id).single<Profile>()
        if (profileError) throw new Error('Could not load your profile — please refresh')
        if (!data?.is_verified) { router.push('/verify/payment'); return }

        setProfile(data)
        setLoading(false)

        fetch('/api/version').then(r => r.json()).then(v => {
          setLatestDesktopVersion(v.desktop ?? null)
          setLatestExtVersion(v.extension ?? null)
        }).catch(() => {})

        const dt = await checkDesktop()
        setDesktop(dt)
        setDesktopChecked(true)
        startPolling()

        if (dt.available) {
          const { data: { session } } = await supabase.auth.getSession()
          if (session) {
            await syncDesktopAuth({
              token: session.access_token,
              userId: user.id,
              country: data.country_code,
              trust: data.trust_score,
            })
          }
          const desktopSharing = dt.running || dt.shareEnabled
          setIsSharing(desktopSharing)
          if (dt.stats) setSharingStats({ bytesServed: dt.stats.bytesServed, requestsHandled: dt.stats.requestsHandled })
        } else if (data.is_sharing) {
          await fetch('/api/user/sharing', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ isSharing: false }),
          }).catch(() => {})
        }
      } catch (err: unknown) {
        setLoadError(err instanceof Error ? err.message : 'Something went wrong — please refresh')
        setLoading(false)
      }
    }
    load()
    return () => stopPolling()
  }, [])

  // ── Load peer counts ────────────────────────────────────────────────────────
  useEffect(() => {
    const el = document.querySelector<HTMLElement>('[data-peermesh-extension]')
    if (el) {
      setExtInstalled(true)
      setExtVersion(el.dataset.extVersion ?? null)
    }
  }, [])

  useEffect(() => {
    fetch('/api/peers/available')
      .then(r => r.json())
      .then(({ peers }: { peers: PeerAvailability[] }) => {
        const counts: Record<string, number> = {}
        peers.forEach(p => { counts[p.country] = p.count })
        setPeerCounts(counts)
      })
      .catch(() => {})
  }, [])

  // ── Poll desktop state + refresh profile from DB ──────────────────────────
  function startPolling() {
    if (pollRef.current) return
    let tick = 0
    pollRef.current = setInterval(async () => {
      tick++
      const dt = await checkDesktop()
      setDesktop(dt)
      if (dt.available) {
        const desktopSharing = dt.running || dt.shareEnabled
        setIsSharing(desktopSharing)
        if (dt.stats) setSharingStats({ bytesServed: dt.stats.bytesServed, requestsHandled: dt.stats.requestsHandled })
        if (!desktopSharing) {
          await fetch('/api/user/sharing', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ isSharing: false }),
          }).catch(() => {})
        }
      } else {
        setIsSharing(false)
      }
      // Refresh profile from DB every 10s to pick up bytes/bandwidth changes
      if (tick % 3 === 0) {
        const { data: { user } } = await supabase.auth.getUser()
        if (user) {
          const { data } = await supabase.from('profiles').select('*').eq('id', user.id).single<Profile>()
          if (data) setProfile(data)
        }
      }
      // Refresh peer counts every 30s so country grid stays live
      if (tick % 10 === 0) {
        fetch('/api/peers/available')
          .then(r => r.json())
          .then(({ peers }: { peers: PeerAvailability[] }) => {
            const counts: Record<string, number> = {}
            peers.forEach(p => { counts[p.country] = p.count })
            setPeerCounts(counts)
          })
          .catch(() => {})
      }
    }, 3000)
  }

  function stopPolling() {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
  }

  // ── Share toggle ────────────────────────────────────────────────────────────
  const handleShareToggle = useCallback(async () => {
    if (!profile || shareToggling) return
    setShareError(null)
    setShareToggling(true)

    if (isSharing) {
      setIsSharing(false)
      await stopDesktopSharing()
      await fetch('/api/user/sharing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isSharing: false }),
      }).catch(() => {})
      setShareToggling(false)
      return
    }

    if (!navigator.onLine) {
      setShareError('No internet connection — check your network and try again')
      setShareToggling(false)
      return
    }

    const dt = await checkDesktop()
    setDesktop(dt)

    if (!dt.available) {
      setShareError('desktop_required')
      setShareToggling(false)
      return
    }

    const { data: { session } } = await supabase.auth.getSession()
    if (!session) {
      setShareError('Session expired — please sign out and sign back in')
      setShareToggling(false)
      return
    }

    const ok = await startDesktopSharing({
      token: session.access_token,
      userId: profile.id,
      country: profile.country_code,
      trust: profile.trust_score,
    })

    if (!ok) {
      setShareError('desktop_required')
      setShareToggling(false)
      return
    }

    setIsSharing(true)
    setShareToggling(false)
    await fetch('/api/user/sharing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isSharing: true }),
    }).catch(() => {})
  }, [profile, isSharing, shareToggling])

  // ── Connect ─────────────────────────────────────────────────────────────────
  async function handleConnect() {
    if (!selectedCountry || !profile) return
    setConnectError(null)
    if (!navigator.onLine) {
      setConnectError('No internet connection — check your network and try again')
      return
    }
    setConnecting(true)
    try {
      const res = await fetch('/api/session/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ country: selectedCountry }),
      })
      const data = await res.json()
      if (!res.ok || data.error) throw new Error(data.error ?? `Server error (${res.status})`)
      router.push(`/browse?relay=${encodeURIComponent(data.relayEndpoint)}&country=${selectedCountry}&userId=${profile.id}&dbSessionId=${data.sessionId}`)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Could not connect'
      setConnectError(msg === 'Failed to fetch' ? 'Network error — could not reach server' : msg)
    } finally {
      setConnecting(false)
    }
  }

  async function handleSignOut() {
    stopPolling()
    await stopDesktopSharing()
    await supabase.auth.signOut()
    router.push('/')
  }

  function dismissErrors() {
    setConnectError(null)
    setShareError(null)
  }

  if (loading) {
    return (
      <main className="flex flex-1 items-center justify-center">
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
          <span style={{ display: 'inline-block', width: '20px', height: '20px', border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
          <div style={{ fontFamily: 'var(--font-geist-mono)', color: 'var(--muted)', fontSize: '11px', letterSpacing: '2px' }}>LOADING...</div>
        </div>
      </main>
    )
  }

  if (loadError) {
    return (
      <main className="flex flex-1 items-center justify-center">
        <div style={{ textAlign: 'center', padding: '24px' }}>
          <div style={{ fontSize: '11px', color: '#ff6060', fontFamily: 'var(--font-geist-mono)', marginBottom: '16px', letterSpacing: '0.5px' }}>{loadError}</div>
          <button onClick={() => window.location.reload()} style={{ padding: '10px 20px', background: 'var(--accent)', color: '#000', border: 'none', borderRadius: '8px', fontFamily: 'var(--font-geist-mono)', fontSize: '11px', fontWeight: 700, cursor: 'pointer', letterSpacing: '0.5px' }}>RETRY</button>
        </div>
      </main>
    )
  }

  if (!profile) return null

  const bandwidthPct = profile.bandwidth_limit > 0
    ? Math.min(100, Math.round((profile.bandwidth_used_month / profile.bandwidth_limit) * 100))
    : 0
  const desktopAvailable = desktop?.available ?? false
  const desktopUpdateAvailable = !!(latestDesktopVersion && desktop?.version && latestDesktopVersion !== desktop.version)
  const extUpdateAvailable = extInstalled && latestExtVersion && extVersion && latestExtVersion !== extVersion
  // Show ext banner only when: not installed, OR installed but update available
  // Never show when installed and up-to-date
  const showExtBanner = !extInstalled || !!extUpdateAvailable

  return (
    <main style={{ maxWidth: '680px', margin: '0 auto', width: '100%', padding: '24px 20px' }}>

      {/* Offline banner */}
      {!isOnline && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', background: 'rgba(255,170,0,0.08)', border: '1px solid rgba(255,170,0,0.4)', borderRadius: '10px', padding: '10px 14px', marginBottom: '16px' }}>
          <span style={{ fontSize: '16px' }}>⚠️</span>
          <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: '#ffaa00', letterSpacing: '0.5px' }}>NO INTERNET CONNECTION — features unavailable until reconnected</span>
        </div>
      )}

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '28px' }}>
        <span style={{ fontFamily: 'var(--font-geist-mono)', color: 'var(--accent)', fontSize: '13px', letterSpacing: '4px' }}>PEERMESH</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {profile.is_premium && (
            <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--accent)', border: '1px solid var(--accent)', padding: '3px 8px', borderRadius: '4px', letterSpacing: '1px' }}>PREMIUM</span>
          )}
          {desktopChecked && (
            <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: desktopAvailable ? 'var(--accent)' : 'var(--muted)', letterSpacing: '1px' }}>
              {desktopAvailable ? '● DESKTOP' : '○ NO DESKTOP'}
            </span>
          )}
          <span style={{ fontSize: '13px', color: 'var(--muted)' }}>{profile.username ?? 'user'}</span>
          <button onClick={handleSignOut} style={{ background: 'none', border: '1px solid var(--border)', color: 'var(--muted)', padding: '6px 12px', borderRadius: '6px', fontSize: '11px', cursor: 'pointer', fontFamily: 'var(--font-geist-mono)' }}>OUT</button>
        </div>
      </div>

      {/* Desktop update banner */}
      {desktopChecked && desktopAvailable && desktopUpdateAvailable && (
        <a
          href="/api/desktop-download"
          download
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', background: 'rgba(0,255,136,0.05)', border: '1px solid rgba(0,255,136,0.3)', borderRadius: '12px', padding: '12px 16px', marginBottom: '16px', textDecoration: 'none' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '18px' }}>⬆️</span>
            <div>
              <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--accent)', letterSpacing: '0.5px', marginBottom: '2px' }}>DESKTOP UPDATE AVAILABLE — v{latestDesktopVersion}</div>
              <div style={{ fontSize: '12px', color: 'var(--muted)' }}>You have v{desktop?.version}. Download the latest for best performance.</div>
            </div>
          </div>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: 'var(--accent)', whiteSpace: 'nowrap', flexShrink: 0 }}>↓ UPDATE</div>
        </a>
      )}

      {/* Desktop required banner — only show when not sharing and desktop not detected */}
      {desktopChecked && !desktopAvailable && !isSharing && (
        <a
          href="/api/desktop-download"
          download
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', background: 'rgba(255,80,80,0.07)', border: '1px solid rgba(255,80,80,0.3)', borderRadius: '12px', padding: '12px 16px', marginBottom: '16px', textDecoration: 'none' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '18px' }}>🖥️</span>
            <div>
              <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: '#ff6060', letterSpacing: '0.5px', marginBottom: '2px' }}>DESKTOP HELPER REQUIRED</div>
              <div style={{ fontSize: '12px', color: 'var(--muted)' }}>Install the desktop app to share your connection and enable full-browser routing</div>
            </div>
          </div>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: '#ff6060', whiteSpace: 'nowrap', flexShrink: 0 }}>↓ INSTALL</div>
        </a>
      )}

      {/* Extension banner — only show when not installed OR update available; hide when installed+current */}
      {showExtBanner && (
        <a
          href="/extension"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', background: 'var(--surface)', border: `1px solid ${extUpdateAvailable ? 'rgba(255,200,0,0.5)' : 'var(--accent)'}`, borderRadius: '12px', padding: '12px 16px', marginBottom: '16px', textDecoration: 'none' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '18px' }}>🧩</span>
            <div>
              <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: extUpdateAvailable ? '#ffc800' : 'var(--accent)', letterSpacing: '0.5px', marginBottom: '2px' }}>
                {extUpdateAvailable ? `UPDATE AVAILABLE — v${latestExtVersion}` : 'CHROME EXTENSION — RECOMMENDED'}
              </div>
              <div style={{ fontSize: '12px', color: 'var(--muted)' }}>
                {extUpdateAvailable ? `You have v${extVersion}. Update for latest features.` : 'Routes your entire browser — YouTube, Google, Netflix all work'}
              </div>
            </div>
          </div>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: extUpdateAvailable ? '#ffc800' : 'var(--accent)', whiteSpace: 'nowrap', flexShrink: 0 }}>
            {extUpdateAvailable ? '↑ UPDATE →' : 'INSTALL →'}
          </div>
        </a>
      )}

      {/* Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px', marginBottom: '20px' }}>
        {[
          { label: 'TRUST', value: String(profile.trust_score) },
          { label: 'SHARED', value: isSharing && sharingStats.bytesServed > 0 ? formatBytes(sharingStats.bytesServed) : formatBytes(profile.total_bytes_shared) },
          { label: 'USED', value: formatBytes(profile.total_bytes_used) },
        ].map(({ label, value }) => (
          <div key={label} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '10px', padding: '14px', textAlign: 'center' }}>
            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '18px', color: 'var(--accent)', marginBottom: '4px' }}>{value}</div>
            <div style={{ fontSize: '10px', color: 'var(--muted)', letterSpacing: '1px' }}>{label}</div>
          </div>
        ))}
      </div>

      {/* Bandwidth */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '10px', padding: '14px', marginBottom: '20px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
          <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--muted)', letterSpacing: '1px' }}>MONTHLY BANDWIDTH</span>
          <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: 'var(--text)' }}>
            {formatBytes(profile.bandwidth_used_month)} / {formatBytes(profile.bandwidth_limit)}
          </span>
        </div>
        <div style={{ height: '5px', background: 'var(--border)', borderRadius: '3px', overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${bandwidthPct}%`, background: bandwidthPct > 80 ? 'var(--danger)' : 'var(--accent)', borderRadius: '3px', transition: 'width 0.4s' }} />
        </div>
      </div>

      {/* Country picker */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '12px', padding: '16px', marginBottom: '16px' }}>
        <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--muted)', letterSpacing: '1px', marginBottom: '14px' }}>BROWSE AS...</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px' }}>
          {COUNTRIES.map(c => {
            const count = peerCounts[c.code] ?? 0
            const selected = selectedCountry === c.code
            return (
              <button
                key={c.code}
                onClick={() => { setSelectedCountry(selected ? null : c.code); setConnectError(null) }}
                style={{ background: selected ? 'var(--accent-dim)' : 'var(--bg)', border: `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`, borderRadius: '8px', padding: '10px 6px', cursor: 'pointer', textAlign: 'center', transition: 'all 0.15s' }}
              >
                <div style={{ fontSize: '20px', marginBottom: '3px' }}>{c.flag}</div>
                <div style={{ fontSize: '10px', color: 'var(--text)', marginBottom: '2px' }}>{c.name}</div>
                <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '9px', color: count > 0 ? 'var(--accent)' : 'var(--muted)' }}>{count} peers</div>
              </button>
            )
          })}
        </div>
      </div>

      {/* Connect error */}
      {connectError && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', background: 'rgba(255,80,80,0.07)', border: '1px solid rgba(255,80,80,0.3)', borderRadius: '10px', padding: '10px 14px', marginBottom: '12px' }}>
          <span style={{ fontSize: '12px', color: '#ff9090' }}>{connectError}</span>
          <button onClick={dismissErrors} style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: '14px', lineHeight: 1, padding: '0 2px' }}>✕</button>
        </div>
      )}

      {/* Connect buttons */}
      {selectedCountry && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '16px' }}>
          <a
            href="/extension"
            style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '6px',
              padding: '14px 10px', background: 'var(--accent)',
              color: '#000',
              border: '1px solid var(--accent)',
              borderRadius: '10px', textDecoration: 'none', textAlign: 'center', transition: 'all 0.2s',
            }}
          >
            <span style={{ fontSize: '18px' }}>🧩</span>
            <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', fontWeight: 700, letterSpacing: '0.5px' }}>EXTENSION</span>
            <span style={{ fontSize: '10px', opacity: 0.8 }}>Full browser · YouTube works</span>
          </a>

          <button
            onClick={handleConnect}
            disabled={connecting || (!profile.is_premium && !isSharing)}
            title={!profile.is_premium && !isSharing ? 'Enable sharing or upgrade to connect' : undefined}
            style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '6px',
              padding: '14px 10px', background: 'var(--surface)',
              color: (connecting || (!profile.is_premium && !isSharing)) ? 'var(--muted)' : 'var(--text)',
              border: '1px solid rgba(0,255,136,0.4)',
              borderRadius: '10px', cursor: (connecting || (!profile.is_premium && !isSharing)) ? 'not-allowed' : 'pointer',
              textAlign: 'center', transition: 'all 0.2s', opacity: (!profile.is_premium && !isSharing) ? 0.5 : 1,
            }}
          >
            <span style={{ fontSize: '18px' }}>🌐</span>
            <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', fontWeight: 700, letterSpacing: '0.5px' }}>
              {connecting ? 'CONNECTING...' : 'WEB BROWSER'}
            </span>
            <span style={{ fontSize: '10px', opacity: 0.7 }}>Limited sites · No install</span>
          </button>
        </div>
      )}

      {/* Share toggle */}
      <div style={{ background: 'var(--surface)', border: `1px solid ${isSharing ? 'rgba(0,255,136,0.3)' : shareError ? 'rgba(255,80,80,0.3)' : 'var(--border)'}`, borderRadius: '12px', padding: '16px', marginBottom: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: '14px', fontWeight: 500, marginBottom: '3px' }}>Share my connection</div>
            <div style={{ fontSize: '12px', color: isSharing ? 'var(--accent)' : 'var(--muted)' }}>
              {isSharing
                ? `${sharingStats.requestsHandled} requests · ${formatBytes(sharingStats.bytesServed)} served`
                : desktopAvailable
                  ? 'Desktop helper ready — toggle to start sharing'
                  : 'Install the desktop helper to share your connection'}
            </div>
          </div>
          <button
            onClick={handleShareToggle}
            disabled={shareToggling}
            style={{ width: '44px', height: '24px', borderRadius: '12px', border: 'none', background: isSharing ? 'var(--accent)' : shareToggling ? 'var(--border)' : 'var(--border)', cursor: shareToggling ? 'not-allowed' : 'pointer', position: 'relative', transition: 'background 0.2s', flexShrink: 0, opacity: shareToggling ? 0.6 : 1 }}
          >
            {shareToggling
              ? <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><span style={{ width: '10px', height: '10px', border: '2px solid rgba(255,255,255,0.3)', borderTopColor: 'white', borderRadius: '50%', animation: 'spin 0.7s linear infinite', display: 'inline-block' }} /></span>
              : <div style={{ position: 'absolute', width: '18px', height: '18px', borderRadius: '50%', background: 'white', top: '3px', left: isSharing ? '23px' : '3px', transition: 'left 0.2s' }} />
            }
          </button>
        </div>
        {shareError && (
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px', marginTop: '10px', padding: '8px 10px', background: 'rgba(255,80,80,0.07)', border: '1px solid rgba(255,80,80,0.2)', borderRadius: '7px' }}>
            <div style={{ fontSize: '11px', color: '#ff6060', fontFamily: 'var(--font-geist-mono)', lineHeight: 1.5 }}>
              {shareError === 'desktop_required' ? (
                <>Desktop helper not running.{' '}<a href="/api/desktop-download" download style={{ color: 'var(--accent)', textDecoration: 'underline' }}>Download & install</a>{' '}then reopen this page.</>
              ) : shareError}
            </div>
            <button onClick={() => setShareError(null)} style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: '13px', lineHeight: 1, padding: '0', flexShrink: 0 }}>✕</button>
          </div>
        )}
      </div>

      {/* Free tier must-share enforcement */}
      {!profile.is_premium && !isSharing && selectedCountry && (
        <div style={{ background: 'rgba(255,80,80,0.07)', border: '1px solid rgba(255,80,80,0.3)', borderRadius: '10px', padding: '12px 16px', marginBottom: '16px', fontSize: '12px', color: '#ff9090' }}>
          <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', letterSpacing: '0.5px' }}>FREE TIER — </span>
          Enable sharing above to connect, or{' '}
          <a href="/verify/payment" style={{ color: 'var(--accent)', textDecoration: 'underline' }}>upgrade to premium</a> to browse without sharing.
        </div>
      )}

      {/* Tier / upgrade */}
      {!profile.is_premium && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', background: 'var(--accent-dim)', border: '1px solid rgba(0,255,136,0.2)', borderRadius: '10px', marginBottom: '12px' }}>
          <div>
            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: 'var(--accent)', letterSpacing: '0.5px', marginBottom: '2px' }}>FREE TIER</div>
            <div style={{ fontSize: '12px', color: 'var(--muted)' }}>Upgrade to browse without sharing your IP</div>
          </div>
          <a href="/upgrade" style={{ padding: '8px 14px', background: 'var(--accent)', color: '#000', borderRadius: '7px', fontSize: '11px', fontFamily: 'var(--font-geist-mono)', fontWeight: 700, textDecoration: 'none', letterSpacing: '0.5px', whiteSpace: 'nowrap' }}>
            UPGRADE $7
          </a>
        </div>
      )}

      {/* Premium — reserve a peer */}
      {profile.is_premium && selectedCountry && (
        <div style={{ padding: '14px 16px', background: 'var(--surface)', border: '1px solid rgba(0,255,136,0.2)', borderRadius: '10px', marginBottom: '12px' }}>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--accent)', letterSpacing: '0.5px', marginBottom: '6px' }}>PREMIUM — PEER RESERVATION</div>
          {(profile.preferred_providers as Record<string, string>)?.[selectedCountry] ? (
            <>
              <div style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: '10px' }}>
                Reserved peer for <strong style={{ color: 'var(--text)' }}>{selectedCountry}</strong> — they will be matched first on every connection.
              </div>
              <button
                onClick={async () => {
                  const { data: { user } } = await supabase.auth.getUser()
                  if (!user) return
                  await supabase.from('profiles').update({
                    preferred_providers: { ...(profile.preferred_providers as Record<string, string>), [selectedCountry]: undefined }
                  }).eq('id', user.id)
                  const { data } = await supabase.from('profiles').select('preferred_providers').eq('id', profile.id).single()
                  if (data) setProfile(p => p ? { ...p, preferred_providers: data.preferred_providers } : p)
                }}
                style={{ padding: '7px 14px', background: 'none', border: '1px solid var(--border)', color: 'var(--muted)', borderRadius: '7px', fontFamily: 'var(--font-geist-mono)', fontSize: '10px', cursor: 'pointer' }}
              >
                CLEAR RESERVATION
              </button>
            </>
          ) : (
            <div style={{ fontSize: '12px', color: 'var(--muted)', lineHeight: 1.6 }}>
              No reserved peer for <strong style={{ color: 'var(--text)' }}>{selectedCountry}</strong> yet.<br />
              <span style={{ fontSize: '11px' }}>Connect to a peer and they will be auto-reserved so you always get the same IP.</span>
            </div>
          )}
        </div>
      )}
    </main>
  )
}
