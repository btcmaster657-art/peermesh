'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { checkDesktop, syncDesktopAuth, startDesktopSharing, stopDesktopSharing } from '@/lib/agent-client'
import { COUNTRIES, formatBytes, getFlagForCountry } from '@/lib/utils'
import type { Profile, PeerAvailability } from '@/lib/types'
import type { DesktopState } from '@/lib/agent-client'


function CliSection({ label, cmd }: { label: string; cmd: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div>
      <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '9px', color: 'var(--muted)', letterSpacing: '0.5px', marginBottom: '5px', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ position: 'relative', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '7px', padding: '10px 40px 10px 12px' }}>
        <pre style={{ margin: 0, fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--accent)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', lineHeight: 1.6 }}>{cmd}</pre>
        <button
          onClick={() => { navigator.clipboard.writeText(cmd).catch(() => {}); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
          style={{ position: 'absolute', top: '8px', right: '8px', background: 'none', border: 'none', color: copied ? 'var(--accent)' : 'var(--muted)', cursor: 'pointer', fontFamily: 'var(--font-geist-mono)', fontSize: '9px', padding: '2px 4px' }}
        >
          {copied ? '✓' : 'COPY'}
        </button>
      </div>
    </div>
  )
}

type PrivateShareState = {
  base_device_id: string
  code: string
  enabled: boolean
  expires_at: string | null
  active: boolean
} | null

function getExpiryPreset(expiresAt: string | null): string {
  if (!expiresAt) return 'none'
  const hours = Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 3_600_000))
  if (hours <= 2) return '1'
  if (hours <= 30) return '24'
  if (hours <= 24 * 8) return '168'
  return 'none'
}

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
  const [disconnecting, setDisconnecting] = useState(false)
  const [shareToggling, setShareToggling] = useState(false)
  const [showDisclosure, setShowDisclosure] = useState(false)
  const [privateCodeInput, setPrivateCodeInput] = useState('')
  const [privateShare, setPrivateShare] = useState<PrivateShareState>(null)
  const [privateExpiryHours, setPrivateExpiryHours] = useState('24')
  const [privateShareSaving, setPrivateShareSaving] = useState(false)
  const [privateShareStoppedSharing, setPrivateShareStoppedSharing] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [shareError, setShareError] = useState<string | null>(null)
  const [connectError, setConnectError] = useState<string | null>(null)
  const [isOnline, setIsOnline] = useState(true)
  const [latestDesktopVersion, setLatestDesktopVersion] = useState<string | null>(null)
  const [latestExtVersion, setLatestExtVersion] = useState<string | null>(null)
  const [latestCliVersion, setLatestCliVersion] = useState<string | null>(null)
  const [extInstalled, setExtInstalled] = useState(false)
  const [extVersion, setExtVersion] = useState<string | null>(null)
  const [showCliDocs, setShowCliDocs] = useState(false)
  const [cliDocTab, setCliDocTab] = useState<'windows' | 'mac' | 'linux'>('windows')

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
          setLatestCliVersion(v.cli ?? null)
        }).catch(() => {})

        const dt = await checkDesktop()
        setDesktop(dt)
        setDesktopChecked(true)
        startPolling()

        if (dt.available) {
          // Only sync auth / show sharing UI if the desktop belongs to this user
          // (dt.userId is null when not yet configured — allow sync in that case)
          const desktopOwnedByOther = dt.userId && dt.userId !== user.id
          if (desktopOwnedByOther) {
            setShareError('This desktop app is signed in as a different user. Sign out of the desktop app first.')
          } else {
            const { data: { session } } = await supabase.auth.getSession()
            if (session) {
              const authResult = await syncDesktopAuth({
                token: session.access_token,
                userId: user.id,
                country: data.country_code,
                trust: data.trust_score,
              })
              if (!authResult.ok && authResult.error) {
                setShareError(authResult.error)
              }
            }
            setIsSharing(dt.running)
            if (dt.stats) setSharingStats({ bytesServed: dt.stats.bytesServed, requestsHandled: dt.stats.requestsHandled })
          }
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
    // Extension stamps data-peermesh-extension on <html> via content script
    const el = document.documentElement
    if (el.dataset.peermeshExtension) {
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

  useEffect(() => {
    const baseDeviceId = desktop?.baseDeviceId ?? desktop?.peer?.baseDeviceId ?? null
    if (!profile || !baseDeviceId) {
      setPrivateShare(null)
      return
    }
    loadPrivateShare(baseDeviceId).catch(() => {})
  }, [profile?.id, desktop?.baseDeviceId, desktop?.peer?.baseDeviceId])

  // ── Poll desktop state + refresh profile from DB ──────────────────────────
  function startPolling() {
    if (pollRef.current) return
    let tick = 0
    pollRef.current = setInterval(async () => {
      tick++
      const dt = await checkDesktop()
      setDesktop(dt)
      const { data: { user } } = await supabase.auth.getUser()
      const desktopOwnedByOther = dt.available && dt.userId && user && dt.userId !== user.id
      if (dt.available && !desktopOwnedByOther) {
        setIsSharing(dt.running)
        if (dt.stats) setSharingStats({ bytesServed: dt.stats.bytesServed, requestsHandled: dt.stats.requestsHandled })
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

  async function loadPrivateShare(baseDeviceId: string) {
    const res = await fetch(`/api/user/sharing?baseDeviceId=${encodeURIComponent(baseDeviceId)}`)
    if (!res.ok) throw new Error('Could not load private sharing state')
    const data = await res.json()
    setPrivateShare(data.private_share ?? null)
    setPrivateExpiryHours(getExpiryPreset(data.private_share?.expires_at ?? null))
  }

  async function savePrivateShare(input: { enabled?: boolean; refresh?: boolean; expiryHours?: string }) {
    const baseDeviceId = desktop?.baseDeviceId ?? desktop?.peer?.baseDeviceId ?? null
    if (!baseDeviceId) {
      setShareError('A local desktop app or CLI device is required to manage private sharing')
      return
    }
    setPrivateShareSaving(true)
    setShareError(null)
    try {
      const expiryHours = input.expiryHours === undefined
        ? undefined
        : (input.expiryHours === 'none' ? null : Number.parseInt(input.expiryHours, 10))
      const res = await fetch('/api/user/sharing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          privateSharing: {
            baseDeviceId,
            enabled: input.enabled,
            refresh: input.refresh === true,
            expiryHours,
          },
        }),
      })
      const data = await res.json()
      if (!res.ok || data.error) throw new Error(data.error ?? 'Could not update private sharing')
      setPrivateShare(data.private_share ?? null)
      if (input.expiryHours !== undefined) setPrivateExpiryHours(input.expiryHours)
    } catch (err: unknown) {
      setShareError(err instanceof Error ? err.message : 'Could not update private sharing')
    } finally {
      setPrivateShareSaving(false)
    }
  }

  // ── Share toggle ────────────────────────────────────────────────────────────
  const handleShareToggle = useCallback(async () => {
    if (!profile || shareToggling) return
    setShareError(null)

    // If turning OFF — no disclosure needed
    if (isSharing) {
      setShareToggling(true)
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

    // First-time share — show disclosure modal first
    if (!profile.has_accepted_provider_terms) {
      setShowDisclosure(true)
      return
    }

    await startSharing()
  }, [profile, isSharing, shareToggling])

  async function startSharing() {
    setShareToggling(true)
    setShareError(null)

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
      userId: profile!.id,
      country: profile!.country_code,
      trust: profile!.trust_score,
    })

    if (!ok.ok) {
      setShareError(ok.error ?? 'desktop_required')
      setShareToggling(false)
      return
    }

    setIsSharing(true)
    setShareToggling(false)
    setPrivateShareStoppedSharing(false)
    await fetch('/api/user/sharing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isSharing: true }),
    }).catch(() => {})
  }

  // ── Connect ─────────────────────────────────────────────────────────────────
  async function handleConnect() {
    const trimmedPrivateCode = privateCodeInput.trim()
    // Country selection = public mode (ignore any code in the box)
    const isPrivateConnect = !selectedCountry && !!trimmedPrivateCode
    if ((!selectedCountry && !trimmedPrivateCode) || !profile) return
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
        body: JSON.stringify(isPrivateConnect ? { privateCode: trimmedPrivateCode } : { country: selectedCountry }),
      })
      const data = await res.json()
      if (!res.ok || data.error) throw new Error(data.error ?? `Server error (${res.status})`)
      const targetCountry = data.country ?? selectedCountry
      const fallback = (data.relayFallbackList ?? [data.relayEndpoint]).join(',')
      router.push(`/browse?relay=${encodeURIComponent(data.relayEndpoint)}&relayFallback=${encodeURIComponent(fallback)}&country=${encodeURIComponent(targetCountry)}&userId=${profile.id}&dbSessionId=${data.sessionId}&preferredProviderUserId=${encodeURIComponent(data.preferredProviderUserId ?? '')}&privateProviderUserId=${encodeURIComponent(data.privateProviderUserId ?? '')}&privateBaseDeviceId=${encodeURIComponent(data.privateBaseDeviceId ?? '')}&connectionType=${isPrivateConnect ? 'private' : 'public'}`)
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
    ? Math.min(100, Math.max(profile.bandwidth_used_month > 0 ? 1 : 0, Math.round((profile.bandwidth_used_month / profile.bandwidth_limit) * 100)))
    : profile.bandwidth_used_month > 0 ? 100 : 0
  const desktopAvailable = desktop?.available ?? false
  const primaryWhere = desktop?.where ?? desktop?.source ?? null  // 'desktop' | 'cli' | null
  const isCLI = primaryWhere === 'cli'
  const isDesktopApp = primaryWhere === 'desktop'

  // Peer = the second process (if both running)
  const peerRunning = desktop?.peer?.available ?? false
  const peerWhere = desktop?.peer?.where ?? null

  // Per-process version info
  const desktopProcessVersion = isDesktopApp ? desktop?.version : (peerWhere === 'desktop' ? desktop?.peer?.version : null)
  const cliProcessVersion     = isCLI        ? desktop?.version : (peerWhere === 'cli'     ? desktop?.peer?.version : null)
  const desktopRunning = isDesktopApp || peerWhere === 'desktop'
  const cliRunning     = isCLI        || peerWhere === 'cli'

  const desktopUpdateAvailable = !!(desktopRunning && latestDesktopVersion && desktopProcessVersion && latestDesktopVersion !== desktopProcessVersion)
  const cliUpdateAvailable     = !!(cliRunning     && latestCliVersion     && cliProcessVersion     && latestCliVersion     !== cliProcessVersion)
  const extUpdateAvailable     = !!(extInstalled   && latestExtVersion     && extVersion            && latestExtVersion     !== extVersion)
  const showExtBanner          = !extInstalled || extUpdateAvailable
  const helperBaseDeviceId = desktop?.baseDeviceId ?? desktop?.peer?.baseDeviceId ?? null
  const helperSlots = desktop?.slots ?? desktop?.peer?.slots ?? null
  const privateConnectReady = !selectedCountry && !!privateCodeInput.trim()

  // Detect OS for CLI docs default tab
  const detectedOS: 'windows' | 'mac' | 'linux' = typeof navigator !== 'undefined'
    ? navigator.userAgent.includes('Win') ? 'windows'
      : navigator.userAgent.includes('Mac') ? 'mac'
      : 'linux'
    : 'linux'

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
            <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              {[{ label: 'CLI', green: cliRunning }, { label: 'DSK', green: desktopRunning }]
                .filter(s => s.green || (!cliRunning && !desktopRunning))
                .map(s => (
                  <span key={s.label} style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: s.green ? 'var(--accent)' : '#ff6060', letterSpacing: '0.5px' }}>
                    {s.green ? '●' : '○'} {s.label}
                  </span>
                ))
              }
            </span>
          )}
          <span style={{ fontSize: '13px', color: 'var(--muted)' }}>{profile.username ?? 'user'}</span>
          <button onClick={handleSignOut} style={{ background: 'none', border: '1px solid var(--border)', color: 'var(--muted)', padding: '6px 12px', borderRadius: '6px', fontSize: '11px', cursor: 'pointer', fontFamily: 'var(--font-geist-mono)' }}>OUT</button>
        </div>
      </div>

      {/* Desktop update banner */}
      {desktopChecked && desktopRunning && desktopUpdateAvailable && (
        <a href="/api/desktop-download" download style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', background: 'rgba(0,255,136,0.05)', border: '1px solid rgba(0,255,136,0.3)', borderRadius: '12px', padding: '12px 16px', marginBottom: '16px', textDecoration: 'none' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '18px' }}>⬆️</span>
            <div>
              <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--accent)', letterSpacing: '0.5px', marginBottom: '2px' }}>DESKTOP UPDATE AVAILABLE — v{latestDesktopVersion}</div>
              <div style={{ fontSize: '12px', color: 'var(--muted)' }}>You have v{desktopProcessVersion}. Download the latest for best performance.</div>
            </div>
          </div>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: 'var(--accent)', whiteSpace: 'nowrap', flexShrink: 0 }}>↓ UPDATE</div>
        </a>
      )}

      {/* Desktop install banner — neither running */}
      {desktopChecked && !desktopRunning && !cliRunning && (
        <a href="/api/desktop-download" download style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', background: 'rgba(255,80,80,0.07)', border: '1px solid rgba(255,80,80,0.3)', borderRadius: '12px', padding: '12px 16px', marginBottom: '16px', textDecoration: 'none' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '18px' }}>🖥️</span>
            <div>
              <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: '#ff6060', letterSpacing: '0.5px', marginBottom: '2px' }}>DESKTOP OR CLI REQUIRED TO SHARE</div>
              <div style={{ fontSize: '12px', color: 'var(--muted)' }}>Install the desktop app or run <code style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px' }}>npx @btcmaster1000/peermesh-provider</code></div>
            </div>
          </div>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: '#ff6060', whiteSpace: 'nowrap', flexShrink: 0 }}>↓ DESKTOP</div>
        </a>
      )}

      {/* Extension banner */}
      {showExtBanner && (
        <a
          href={extUpdateAvailable ? '/api/extension-download' : '/extension'}
          download={extUpdateAvailable ? 'peermesh-extension.zip' : undefined}
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
          { label: 'SHARED', value: formatBytes(profile.total_bytes_shared + (isSharing ? sharingStats.bytesServed : 0)) },
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

      {/* Private connect */}
      <div style={{ background: 'var(--surface)', border: '1px solid rgba(0,255,136,0.18)', borderRadius: '12px', padding: '16px', marginBottom: '16px' }}>
        <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--accent)', letterSpacing: '1px', marginBottom: '6px' }}>PRIVATE SHARE CODE</div>
        <div style={{ fontSize: '12px', color: 'var(--muted)', lineHeight: 1.6, marginBottom: '12px' }}>
          Connect directly to a known device. PeerMesh will only use that device&apos;s active slots and will not fall back to the public pool.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '10px' }}>
          <div style={{ position: 'relative' }}>
            <input
              value={privateCodeInput}
              onChange={(e) => { setPrivateCodeInput(e.target.value.replace(/\D/g, '').slice(0, 9)); setConnectError(null) }}
              placeholder="Enter 9-digit code"
              inputMode="numeric"
              maxLength={9}
              style={{ width: '100%', padding: '10px 36px 10px 12px', background: 'var(--bg)', border: `1px solid ${selectedCountry ? 'var(--border)' : 'var(--border)'}`, borderRadius: '8px', color: 'var(--text)', fontFamily: 'var(--font-geist-mono)', fontSize: '12px', letterSpacing: '1px', boxSizing: 'border-box' }}
            />
            {privateCodeInput && (
              <button
                onClick={() => { setPrivateCodeInput(''); setConnectError(null) }}
                style={{ position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: '14px', lineHeight: 1, padding: '2px' }}
                title="Clear code"
              >✕</button>
            )}
          </div>
          <button
            onClick={handleConnect}
            disabled={connecting || !privateConnectReady || (!profile.is_premium && !isSharing)}
            title={selectedCountry ? 'Clear country selection to use private code' : !profile.is_premium && !isSharing ? 'Enable sharing or upgrade to connect' : undefined}
            style={{ padding: '10px 14px', background: privateConnectReady ? 'var(--accent)' : 'var(--border)', color: privateConnectReady ? '#000' : 'var(--muted)', border: 'none', borderRadius: '8px', fontFamily: 'var(--font-geist-mono)', fontSize: '10px', fontWeight: 700, letterSpacing: '0.5px', cursor: connecting || !privateConnectReady || (!profile.is_premium && !isSharing) ? 'not-allowed' : 'pointer', opacity: (!profile.is_premium && !isSharing) ? 0.5 : 1 }}
          >
            {connecting && privateConnectReady ? 'CONNECTING...' : 'CONNECT CODE'}
          </button>
        </div>
        {selectedCountry && privateCodeInput && (
          <div style={{ marginTop: '8px', fontSize: '11px', color: 'var(--muted)', fontFamily: 'var(--font-geist-mono)' }}>
            Country selected — connecting publicly. Clear country to use private code.
          </div>
        )}
      </div>

      {/* Country picker */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '12px', padding: '16px', marginBottom: '16px', opacity: connecting ? 0.5 : 1, pointerEvents: connecting ? 'none' : 'auto' }}>
        <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--muted)', letterSpacing: '1px', marginBottom: '14px' }}>BROWSE AS...</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px' }}>
          {COUNTRIES.map(c => {
            const count = peerCounts[c.code] ?? 0
            const selected = selectedCountry === c.code
            return (
              <button
                key={c.code}
                onClick={() => { const next = selected ? null : c.code; setSelectedCountry(next); setConnectError(null); if (next) setPrivateCodeInput('') }}
                style={{ background: selected ? 'var(--accent-dim)' : 'var(--bg)', border: `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`, borderRadius: '8px', padding: '10px 6px', cursor: 'pointer', textAlign: 'center', transition: 'all 0.15s' }}
              >
                <div style={{ fontSize: '20px', marginBottom: '3px' }}>{c.flag}</div>
                <div style={{ fontSize: '10px', color: 'var(--text)', marginBottom: '2px' }}>{c.name}</div>
                <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '9px', color: count > 0 ? 'var(--accent)' : 'var(--muted)' }}>{count} devices</div>
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
            <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '9px', background: 'rgba(0,0,0,0.15)', padding: '2px 6px', borderRadius: '4px' }}>🌐 PUBLIC</span>
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
            {connecting
              ? <span style={{ display: 'inline-block', width: '18px', height: '18px', border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
              : <span style={{ fontSize: '18px' }}>🌐</span>
            }
            <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', fontWeight: 700, letterSpacing: '0.5px' }}>
              {connecting ? 'CONNECTING...' : 'WEB BROWSER'}
            </span>
            <span style={{ fontSize: '10px', opacity: 0.7 }}>Limited sites · No install</span>
            <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '9px', color: 'var(--muted)', background: 'var(--border)', padding: '2px 6px', borderRadius: '4px' }}>🌐 PUBLIC</span>
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
                ? `${sharingStats.requestsHandled} requests · ${formatBytes(sharingStats.bytesServed)} served · ${privateShare?.active ? '\uD83D\uDD12 PRIVATE' : '\uD83C\uDF10 PUBLIC'}`
                : shareToggling
                  ? 'Connecting...'
                  : desktopAvailable
                    ? `${cliRunning && desktopRunning ? 'CLI + Desktop' : cliRunning ? 'CLI' : 'Desktop'} ready — toggle to start sharing`
                    : 'Install the desktop app or run the CLI to share your connection'}
            </div>
          </div>
          <button
            onClick={handleShareToggle}
            disabled={shareToggling}
            style={{ width: '44px', height: '24px', borderRadius: '12px', border: 'none', background: isSharing ? 'var(--accent)' : 'var(--border)', cursor: shareToggling ? 'not-allowed' : 'pointer', position: 'relative', transition: 'background 0.2s', flexShrink: 0, opacity: shareToggling ? 0.6 : 1 }}
          >
            {shareToggling
              ? <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><span style={{ width: '10px', height: '10px', border: '2px solid rgba(255,255,255,0.3)', borderTopColor: 'white', borderRadius: '50%', animation: 'spin 0.7s linear infinite', display: 'inline-block' }} /></span>
              : <div style={{ position: 'absolute', width: '18px', height: '18px', borderRadius: '50%', background: 'white', top: '3px', left: isSharing ? '23px' : '3px', transition: 'left 0.2s' }} />
            }
          </button>
        </div>

        {helperSlots && (
          <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid var(--border)' }}>
            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--muted)', letterSpacing: '0.5px', marginBottom: '4px' }}>CONNECTION SLOTS</div>
            <div style={{ fontSize: '11px', color: 'var(--muted)' }}>
              {helperSlots.active} / {helperSlots.configured} active{helperSlots.warning ? ` — ${helperSlots.warning}` : ''}
            </div>
          </div>
        )}

        {/* Daily limit setter — always visible so user can set before sharing */}
        <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
          <div>
            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--muted)', letterSpacing: '0.5px', marginBottom: '2px' }}>DAILY SHARE LIMIT</div>
            <div style={{ fontSize: '11px', color: 'var(--muted)' }}>
              {profile.daily_share_limit_mb ? `${profile.daily_share_limit_mb}MB/day — auto-stops when reached` : 'No limit set'}
            </div>
          </div>
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexShrink: 0 }}>
            <select
              defaultValue={profile.daily_share_limit_mb ?? ''}
              onChange={async (e) => {
                const val = e.target.value === '' ? null : parseInt(e.target.value)
                await fetch('/api/user/sharing', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ dailyLimitMb: val }),
                })
                setProfile(p => p ? { ...p, daily_share_limit_mb: val } : p)
              }}
              style={{ background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: '6px', padding: '4px 8px', fontFamily: 'var(--font-geist-mono)', fontSize: '10px', cursor: 'pointer' }}
            >
              <option value=''>No limit</option>
              <option value='100'>100 MB</option>
              <option value='250'>250 MB</option>
              <option value='500'>500 MB</option>
              <option value='1024'>1 GB</option>
              <option value='2048'>2 GB</option>
              <option value='5120'>5 GB</option>
            </select>
          </div>
        </div>

        {shareError && (
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px', marginTop: '10px', padding: '8px 10px', background: 'rgba(255,80,80,0.07)', border: '1px solid rgba(255,80,80,0.2)', borderRadius: '7px' }}>
            <div style={{ fontSize: '11px', color: '#ff6060', fontFamily: 'var(--font-geist-mono)', lineHeight: 1.5 }}>
              {shareError === 'desktop_required' ? (
                <>Desktop or CLI not running.{' '}<a href="/api/desktop-download" download style={{ color: 'var(--accent)', textDecoration: 'underline' }}>Download desktop</a>{' '}or run <code style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px' }}>npx @btcmaster1000/peermesh-provider</code> then reopen this page.</>
              ) : shareError}
            </div>
            <button onClick={() => setShareError(null)} style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: '13px', lineHeight: 1, padding: '0', flexShrink: 0 }}>✕</button>
          </div>
        )}
      </div>

      {helperBaseDeviceId && (
        <div style={{ background: 'var(--surface)', border: '1px solid rgba(0,255,136,0.18)', borderRadius: '12px', padding: '16px', marginBottom: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', marginBottom: '12px' }}>
            <div>
              <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--accent)', letterSpacing: '1px', marginBottom: '4px' }}>PRIVATE SHARING</div>
              <div style={{ fontSize: '12px', color: 'var(--muted)', lineHeight: 1.6 }}>
                {privateShare?.active
                  ? 'Enabled for this local device. The 9-digit code is pinned to this device and all of its active slots.'
                  : 'Optional device-scoped sharing for trusted requesters only.'}
              </div>
            </div>
            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: privateShare?.active ? 'var(--accent)' : 'var(--muted)', whiteSpace: 'nowrap' }}>
              {privateShare?.active ? '● ACTIVE' : '○ OFF'}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '10px', marginBottom: '10px' }}>
            <div style={{ padding: '10px 12px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '8px', fontFamily: 'var(--font-geist-mono)', fontSize: '15px', letterSpacing: '3px', color: privateShare?.code ? 'var(--accent)' : 'var(--muted)' }}>
              {privateShare?.code ?? 'CODE OFF'}
            </div>
            <button
              onClick={() => { if (privateShare?.code) navigator.clipboard.writeText(privateShare.code).catch(() => {}) }}
              disabled={!privateShare?.code}
              style={{ padding: '10px 12px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '8px', color: privateShare?.code ? 'var(--text)' : 'var(--muted)', fontFamily: 'var(--font-geist-mono)', fontSize: '10px', cursor: privateShare?.code ? 'pointer' : 'not-allowed' }}
            >
              COPY
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
            <select
              value={privateExpiryHours}
              onChange={(e) => setPrivateExpiryHours(e.target.value)}
              style={{ background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: '6px', padding: '6px 8px', fontFamily: 'var(--font-geist-mono)', fontSize: '10px', cursor: 'pointer' }}
            >
              <option value='none'>No expiry</option>
              <option value='1'>1 hour</option>
              <option value='24'>24 hours</option>
              <option value='168'>7 days</option>
            </select>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <button
                onClick={async () => {
                  const nextEnabled = !(privateShare?.enabled ?? false)
                  await savePrivateShare({ enabled: nextEnabled, expiryHours: privateExpiryHours })
                  // If sharing is active, stop it so user must manually restart with new privacy state
                  if (isSharing) {
                    await stopDesktopSharing()
                    setIsSharing(false)
                    setPrivateShareStoppedSharing(true)
                    await fetch('/api/user/sharing', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ isSharing: false }),
                    }).catch(() => {})
                  }
                }}
                disabled={privateShareSaving}
                style={{ padding: '7px 12px', background: privateShare?.enabled ? 'transparent' : 'var(--accent)', color: privateShare?.enabled ? 'var(--text)' : '#000', border: `1px solid ${privateShare?.enabled ? 'var(--border)' : 'var(--accent)'}`, borderRadius: '7px', fontFamily: 'var(--font-geist-mono)', fontSize: '10px', cursor: privateShareSaving ? 'not-allowed' : 'pointer', opacity: privateShareSaving ? 0.6 : 1 }}
              >
                {privateShare?.enabled ? 'DISABLE' : 'ENABLE'}
              </button>
              <button
                onClick={() => savePrivateShare({ enabled: true, refresh: true, expiryHours: privateExpiryHours })}
                disabled={privateShareSaving}
                style={{ padding: '7px 12px', background: 'transparent', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: '7px', fontFamily: 'var(--font-geist-mono)', fontSize: '10px', cursor: privateShareSaving ? 'not-allowed' : 'pointer', opacity: privateShareSaving ? 0.6 : 1 }}
              >
                REFRESH CODE
              </button>
            </div>
          </div>

          {privateShareStoppedSharing && !isSharing && (
            <div style={{ marginTop: '8px', fontSize: '11px', color: '#ffaa00', fontFamily: 'var(--font-geist-mono)', background: 'rgba(255,170,0,0.07)', border: '1px solid rgba(255,170,0,0.3)', borderRadius: '6px', padding: '6px 10px' }}>
              Sharing was stopped. Toggle sharing above to restart with the new privacy setting.
            </div>
          )}
          {isSharing && privateShare?.active && (
            <div style={{ marginTop: '8px', fontSize: '11px', color: 'var(--muted)', fontFamily: 'var(--font-geist-mono)', background: 'rgba(0,255,136,0.05)', border: '1px solid rgba(0,255,136,0.15)', borderRadius: '6px', padding: '6px 10px' }}>
              Sharing is PRIVATE — only requesters with your code can connect.
            </div>
          )}
          {isSharing && !privateShare?.active && (
            <div style={{ marginTop: '8px', fontSize: '11px', color: 'var(--muted)', fontFamily: 'var(--font-geist-mono)', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border)', borderRadius: '6px', padding: '6px 10px' }}>
              Sharing is PUBLIC — any verified user can connect.
            </div>
          )}
          {privateShare?.expires_at && (
            <div style={{ marginTop: '10px', fontSize: '11px', color: 'var(--muted)' }}>
              Expires {new Date(privateShare.expires_at).toLocaleString()}
            </div>
          )}
        </div>
      )}

      {/* Free tier must-share enforcement */}
      {!profile.is_premium && !isSharing && (selectedCountry || privateConnectReady) && (
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

      {/* CLI banner */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', background: 'var(--surface)', border: `1px solid ${cliRunning ? (cliUpdateAvailable ? 'rgba(255,200,0,0.5)' : 'rgba(0,255,136,0.3)') : 'var(--border)'}`, borderRadius: '10px', marginBottom: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ fontSize: '16px' }}>⌨️</span>
          <div>
            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: cliRunning ? (cliUpdateAvailable ? '#ffc800' : 'var(--accent)') : 'var(--muted)', letterSpacing: '0.5px', marginBottom: '2px' }}>
              {cliRunning
                ? cliUpdateAvailable ? `CLI UPDATE AVAILABLE — v${latestCliVersion}` : '● CLI DETECTED — SHARING ACTIVE'
                : 'SHARE FROM ANY MACHINE'}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--muted)' }}>
              {cliRunning
                ? cliUpdateAvailable ? `You have v${cliProcessVersion}. Run: npm install -g @btcmaster1000/peermesh-provider@latest` : `v${cliProcessVersion} — in sync with this dashboard`
                : latestCliVersion ? `Latest: v${latestCliVersion} — no desktop app needed` : 'No desktop app needed — just Node.js'}
            </div>
          </div>
        </div>
        <button
          onClick={() => { setCliDocTab(detectedOS); setShowCliDocs(true) }}
          style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: cliUpdateAvailable ? '#ffc800' : 'var(--accent)', background: 'var(--bg)', border: `1px solid ${cliUpdateAvailable ? 'rgba(255,200,0,0.4)' : 'rgba(0,255,136,0.3)'}`, padding: '5px 10px', borderRadius: '5px', cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0 }}
        >
          {cliUpdateAvailable ? '↑ UPDATE →' : 'CLI DOCS →'}
        </button>
      </div>

      {/* CLI Docs modal */}
      {showCliDocs && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '20px' }}>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '16px', padding: '24px', maxWidth: '520px', width: '100%', maxHeight: '90vh', overflowY: 'auto' }}>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
              <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: 'var(--accent)', letterSpacing: '1px' }}>CLI INSTALL GUIDE</div>
              <button onClick={() => setShowCliDocs(false)} style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: '16px', lineHeight: 1, padding: 0 }}>✕</button>
            </div>

            <div style={{ fontSize: '13px', color: 'var(--muted)', marginBottom: '16px', lineHeight: 1.5 }}>
              Run the CLI on any machine to share your connection. It works as a drop-in alternative to the desktop app — the dashboard detects it automatically.
            </div>

            {/* OS tabs */}
            <div style={{ display: 'flex', gap: '6px', marginBottom: '20px' }}>
              {(['windows', 'mac', 'linux'] as const).map(os => (
                <button
                  key={os}
                  onClick={() => setCliDocTab(os)}
                  style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', padding: '5px 12px', borderRadius: '6px', border: `1px solid ${cliDocTab === os ? 'var(--accent)' : 'var(--border)'}`, background: cliDocTab === os ? 'rgba(0,255,136,0.1)' : 'var(--bg)', color: cliDocTab === os ? 'var(--accent)' : 'var(--muted)', cursor: 'pointer', letterSpacing: '0.5px', textTransform: 'uppercase' }}
                >
                  {os === 'windows' ? '🪟 Windows' : os === 'mac' ? '🍎 macOS' : '🐧 Linux'}
                </button>
              ))}
            </div>

            {cliDocTab === 'windows' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                <CliSection label="Option 1 — npx (no install needed)" cmd="npx @btcmaster1000/peermesh-provider" />
                <CliSection label="Option 2 — install globally" cmd="npm install -g @btcmaster1000/peermesh-provider" />
                <CliSection label="Install Node.js first (cmd / winget)" cmd={`winget install OpenJS.NodeJS`} />
                <CliSection label="Install Node.js first (PowerShell / Invoke)" cmd={`Invoke-WebRequest https://nodejs.org/dist/v20.11.0/node-v20.11.0-x64.msi -OutFile node.msi
Start-Process msiexec -ArgumentList '/i node.msi /quiet' -Wait`} />
                <CliSection label="Run at startup (Task Scheduler)" cmd={`$action = New-ScheduledTaskAction -Execute "$(where.exe peermesh-provider)"
$trigger = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName "PeerMesh" -Action $action -Trigger $trigger -RunLevel Highest -Force`} />
              </div>
            )}

            {cliDocTab === 'mac' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                <CliSection label="Option 1 — npx (no install needed)" cmd="npx @btcmaster1000/peermesh-provider" />
                <CliSection label="Option 2 — install globally" cmd="npm install -g @btcmaster1000/peermesh-provider" />
                <CliSection label="Install Node.js via Homebrew" cmd="brew install node" />
                <CliSection label="Install Node.js via built-in curl" cmd={`curl -fsSL https://nodejs.org/dist/v20.11.0/node-v20.11.0.pkg -o node.pkg
sudo installer -pkg node.pkg -target /`} />
                <CliSection label="Run at startup (launchd — built-in)" cmd={`cat > ~/Library/LaunchAgents/app.peermesh.provider.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>app.peermesh.provider</string>
  <key>ProgramArguments</key><array><string>$(which peermesh-provider)</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
EOF
launchctl load ~/Library/LaunchAgents/app.peermesh.provider.plist`} />
              </div>
            )}

            {cliDocTab === 'linux' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                <CliSection label="Option 1 — npx (no install needed)" cmd="npx @btcmaster1000/peermesh-provider" />
                <CliSection label="Option 2 — install globally" cmd="npm install -g @btcmaster1000/peermesh-provider" />
                <CliSection label="Install Node.js via built-in curl (Debian/Ubuntu)" cmd={`curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs`} />
                <CliSection label="Install Node.js via built-in curl (RHEL/Fedora)" cmd={`curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo dnf install -y nodejs`} />
                <CliSection label="Run at startup (systemd — built-in)" cmd={`sudo tee /etc/systemd/system/peermesh.service <<EOF
[Unit]
Description=PeerMesh Provider
After=network.target

[Service]
ExecStart=$(which peermesh-provider)
Restart=always
User=$USER

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl enable --now peermesh.service`} />
              </div>
            )}

            <div style={{ marginTop: '20px', paddingTop: '16px', borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: '14px' }}>

              <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '9px', color: 'var(--muted)', letterSpacing: '0.5px' }}>UPDATE</div>
              <CliSection label="Update to latest version" cmd="npm install -g @btcmaster1000/peermesh-provider@latest" />

              <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '9px', color: 'var(--muted)', letterSpacing: '0.5px', marginTop: '4px' }}>USAGE</div>
              <CliSection label="Start sharing (prompts for sign-in on first run)" cmd="peermesh-provider" />
              <CliSection label="Run without installing" cmd="npx @btcmaster1000/peermesh-provider" />
              <CliSection label="Set a daily bandwidth limit (MB)" cmd="peermesh-provider --limit 500" />
              <CliSection label="Remove daily limit" cmd="peermesh-provider --no-limit" />
              <CliSection label="Set number of concurrent connection slots (1–32)" cmd="peermesh-provider --slots 4" />
              <CliSection label="Show today's usage and status, then exit" cmd="peermesh-provider --status" />
              <CliSection label="Clear saved credentials and re-authenticate" cmd="peermesh-provider --reset" />
              <CliSection label="Skip provider terms prompt (for scripts/CI)" cmd="peermesh-provider --serve" />
              <CliSection label="Print verbose debug logs to console" cmd="peermesh-provider --debug" />
              <CliSection label="Combine flags" cmd="peermesh-provider --slots 4 --limit 1024 --debug" />

              <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '9px', color: 'var(--muted)', letterSpacing: '0.5px', marginTop: '4px' }}>UNINSTALL</div>
              <CliSection label="Remove the CLI" cmd="npm uninstall -g @btcmaster1000/peermesh-provider" />
              {cliDocTab === 'windows' && (
                <>
                  <CliSection label="Remove saved credentials (PowerShell)" cmd={`Remove-Item -Recurse -Force "$env:USERPROFILE\.peermesh"`} />
                  <CliSection label="Remove saved credentials (cmd)" cmd={`rmdir /s /q "%USERPROFILE%\.peermesh"`} />
                  <CliSection label="Remove startup task" cmd={`Unregister-ScheduledTask -TaskName "PeerMesh" -Confirm:$false`} />
                </>
              )}
              {cliDocTab === 'mac' && (
                <>
                  <CliSection label="Remove saved credentials" cmd="rm -rf ~/.peermesh" />
                  <CliSection label="Remove startup service" cmd={`launchctl unload ~/Library/LaunchAgents/app.peermesh.provider.plist
rm ~/Library/LaunchAgents/app.peermesh.provider.plist`} />
                </>
              )}
              {cliDocTab === 'linux' && (
                <>
                  <CliSection label="Remove saved credentials" cmd="rm -rf ~/.peermesh" />
                  <CliSection label="Remove startup service" cmd={`sudo systemctl disable --now peermesh.service
sudo rm /etc/systemd/system/peermesh.service`} />
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Provider disclosure modal */}
      {showDisclosure && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '20px' }}>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '16px', padding: '28px', maxWidth: '440px', width: '100%' }}>
            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: 'var(--accent)', letterSpacing: '1px', marginBottom: '12px' }}>BEFORE YOU SHARE</div>
            <div style={{ fontSize: '15px', fontWeight: 600, marginBottom: '16px', lineHeight: 1.3 }}>What sharing your connection means</div>
            {([
              ['🌐', 'Your IP address will be used by other PeerMesh users to browse the web.'],
              ['🔒', 'All sessions are logged with signed receipts. You can see what passed through in your session history.'],
              ['🚫', 'Blocked automatically: .onion sites, SMTP/mail servers, torrent trackers, and private network addresses.'],
              ['⚡', 'You can stop sharing at any time by toggling the switch off.'],
              ['💸', 'Sharing earns you free browsing credits on the free tier.'],
            ] as [string, string][]).map(([icon, text]) => (
              <div key={text} style={{ display: 'flex', gap: '12px', marginBottom: '12px', fontSize: '13px', color: 'var(--muted)', lineHeight: 1.5 }}>
                <span style={{ flexShrink: 0 }}>{icon}</span>
                <span>{text}</span>
              </div>
            ))}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginTop: '20px' }}>
              <button
                onClick={() => setShowDisclosure(false)}
                style={{ padding: '12px', background: 'none', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--muted)', cursor: 'pointer', fontFamily: 'var(--font-geist-mono)', fontSize: '11px' }}
              >
                CANCEL
              </button>
              <button
                onClick={async () => {
                  setShowDisclosure(false)
                  const { data: { user } } = await supabase.auth.getUser()
                  if (user) {
                    await supabase.from('profiles').update({ has_accepted_provider_terms: true }).eq('id', user.id)
                    setProfile(p => p ? { ...p, has_accepted_provider_terms: true } : p)
                  }
                  await startSharing()
                }}
                style={{ padding: '12px', background: 'var(--accent)', border: 'none', borderRadius: '8px', color: '#000', cursor: 'pointer', fontFamily: 'var(--font-geist-mono)', fontSize: '11px', fontWeight: 700 }}
              >
                I UNDERSTAND — SHARE
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}
