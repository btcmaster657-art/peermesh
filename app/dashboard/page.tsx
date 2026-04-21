'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { checkDesktop, syncDesktopAuth, startDesktopSharing, stopDesktopSharing, setDesktopConnectionSlots } from '@/lib/agent-client'
import { formatBytes } from '@/lib/utils'
import type { Profile, PeerAvailability } from '@/lib/types'
import type { DesktopState } from '@/lib/agent-client'

type Country = { code: string; name: string; flag: string }
const COUNTRIES_PAGE_SIZE = 20


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

function getHelperMismatchError(where: string | null | undefined): string {
  const source = where === 'cli' ? 'CLI' : 'desktop app'
  return `This ${source} is signed in as a different user. Sign out of the ${source} first.`
}

const DAILY_LIMIT_MIN_MB = 1024

function getExpiryPreset(expiresAt: string | null): string {
  if (!expiresAt) return 'none'
  const hours = Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 3_600_000))
  if (hours <= 2) return '1'
  if (hours <= 30) return '24'
  if (hours <= 24 * 8) return '168'
  return 'none'
}

function isDesktopOwnedByUser(state: DesktopState | null, userId: string | null | undefined): boolean {
  return !(state?.available && state.userId && userId && state.userId !== userId)
}

function isDesktopSharing(state: DesktopState | null): boolean {
  return !!(state?.running || state?.shareEnabled)
}

export default function Dashboard() {
  const router = useRouter()
  const supabase = createClient()
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const pendingShareTargetRef = useRef<boolean | null>(null)

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
  const [shareTarget, setShareTarget] = useState<boolean | null>(null)
  const [showDisclosure, setShowDisclosure] = useState(false)
  const [privateCodeInput, setPrivateCodeInput] = useState('')
  const [privateShare, setPrivateShare] = useState<PrivateShareState>(null)
  const [privateExpiryHours, setPrivateExpiryHours] = useState('24')
  const [privateShareSaving, setPrivateShareSaving] = useState(false)
  const [privateShareStoppedSharing, setPrivateShareStoppedSharing] = useState(false)
  const [slotUpdating, setSlotUpdating] = useState(false)
  const [dailyLimitInput, setDailyLimitInput] = useState('')
  const [dailyLimitSaving, setDailyLimitSaving] = useState(false)
  const [dailyLimitError, setDailyLimitError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [shareError, setShareError] = useState<string | null>(null)
  const [connectError, setConnectError] = useState<string | null>(null)
  const [signingOut, setSigningOut] = useState(false)
  const [isOnline, setIsOnline] = useState(true)
  const [latestDesktopVersion, setLatestDesktopVersion] = useState<string | null>(null)
  const [latestExtVersion, setLatestExtVersion] = useState<string | null>(null)
  const [latestCliVersion, setLatestCliVersion] = useState<string | null>(null)
  const [extInstalled, setExtInstalled] = useState(false)
  const [extVersion, setExtVersion] = useState<string | null>(null)
  const [showCliDocs, setShowCliDocs] = useState(false)
  const [cliDocTab, setCliDocTab] = useState<'windows' | 'mac' | 'linux'>('windows')
  const [isMobile, setIsMobile] = useState(false)

  // ── Countries from DB ──────────────────────────────────────────────────────
  const [countries, setCountries] = useState<Country[]>([])
  const [countriesPage, setCountriesPage] = useState(1)
  const [countriesTotalPages, setCountriesTotalPages] = useState(1)
  const [countriesLoading, setCountriesLoading] = useState(false)
  const [countriesError, setCountriesError] = useState(false)
  const [countriesSearch, setCountriesSearch] = useState('')
  const countriesSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const loadCountries = useCallback(async (page: number, search: string) => {
    setCountriesLoading(true)
    setCountriesError(false)
    try {
      const qs = new URLSearchParams({ page: String(page), limit: String(COUNTRIES_PAGE_SIZE) })
      if (search) qs.set('q', search)
      const res = await fetch(`/api/countries?${qs}`)
      if (!res.ok) throw new Error('failed')
      const data = await res.json()
      setCountries(data.countries ?? [])
      setCountriesTotalPages(data.pages ?? 1)
      setCountriesPage(page)
      if (page === 1 && !search && data.detectedCountry && !selectedCountry) {
        const found = (data.countries as Country[]).find((c: Country) => c.code === data.detectedCountry)
        if (found) setSelectedCountry(found.code)
      }
    } catch {
      setCountriesError(true)
    } finally {
      setCountriesLoading(false)
    }
  }, [selectedCountry])

  useEffect(() => { loadCountries(1, '') }, [])

  function getFlagForCountry(code: string): string {
    return countries.find(c => c.code === code)?.flag ?? '🌍'
  }

  // ── Mobile detection ────────────────────────────────────────────────────────
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

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
        // Use getSession first to avoid throwing on missing session
        const { data: { session }, error: sessionError } = await supabase.auth.getSession()
        if (sessionError) throw new Error('Could not verify session – please refresh')
        if (!session) { router.push('/auth?mode=login'); return }

        const user = session.user

        const { data, error: profileError } = await supabase.from('profiles').select('*').eq('id', user.id).single<Profile>()
        if (profileError) throw new Error('Could not load your profile – please refresh')
        if (!data?.is_verified) { router.push('/verify/payment'); return }

        setProfile(data)
        setLoading(false)

        fetch('/api/version').then(r => r.json()).then(v => {
          setLatestDesktopVersion(v.desktop ?? null)
          setLatestExtVersion(v.extension ?? null)
          setLatestCliVersion(v.cli ?? null)
        }).catch(() => {})

        const dt = await checkDesktop()
        const desktopState = applyDesktopSnapshot(dt, user.id)
        setDesktopChecked(true)
        startPolling()

        if (dt.available) {
          if (desktopState.desktopOwnedByOther) {
            setShareError(getHelperMismatchError(dt.where))
          } else {
            const authResult = await syncDesktopAuth({
              token: session.access_token,
              userId: user.id,
              country: data.country_code,
              trust: data.trust_score,
            })
            if (!authResult.ok && authResult.error) {
              setShareError(authResult.error)
            }
            setShareError(prev => prev != null && prev.includes('signed in as a different user') ? null : prev)
          }
        } else if (data.is_sharing) {
          await fetch('/api/user/sharing', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ isSharing: false }),
          }).catch(() => {})
        }
      } catch (err: unknown) {
        setLoadError(err instanceof Error ? err.message : 'Something went wrong – please refresh')
        setLoading(false)
      }
    }
    load()
    return () => stopPolling()
  }, [])

  // ── Extension detection ─────────────────────────────────────────────────────
  useEffect(() => {
    const syncExtensionMarker = () => {
      const el = document.documentElement
      const installed = !!el?.dataset.peermeshExtension
      setExtInstalled(installed)
      setExtVersion(installed ? (el.dataset.extVersion ?? null) : null)
    }

    syncExtensionMarker()

    const root = document.documentElement
    const observer = root
      ? new MutationObserver(() => syncExtensionMarker())
      : null

    if (root) {
      observer?.observe(root, {
        attributes: true,
        attributeFilter: ['data-peermesh-extension', 'data-ext-version'],
      })
    }

    window.addEventListener('focus', syncExtensionMarker)
    window.addEventListener('pageshow', syncExtensionMarker)
    document.addEventListener('visibilitychange', syncExtensionMarker)

    return () => {
      observer?.disconnect()
      window.removeEventListener('focus', syncExtensionMarker)
      window.removeEventListener('pageshow', syncExtensionMarker)
      document.removeEventListener('visibilitychange', syncExtensionMarker)
    }
  }, [])

  // ── Load peer counts ────────────────────────────────────────────────────────
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
    setDailyLimitInput(profile?.daily_share_limit_mb != null ? String(profile.daily_share_limit_mb) : '')
  }, [profile?.daily_share_limit_mb])

  useEffect(() => {
    const baseDeviceId = isDesktopOwnedByUser(desktop, profile?.id)
      ? (desktop?.baseDeviceId ?? desktop?.peer?.baseDeviceId ?? null)
      : null
    if (!profile || !baseDeviceId) {
      setPrivateShare(null)
      return
    }
    loadPrivateShare(baseDeviceId).catch(() => {})
  }, [profile?.id, desktop?.baseDeviceId, desktop?.peer?.baseDeviceId, desktop?.userId])

  // ── Poll desktop state + refresh profile ────────────────────────────────────
  const applyDesktopSnapshot = useCallback((dt: DesktopState, userId: string | null | undefined) => {
    setDesktop(dt)

    const desktopOwnedByOther = !isDesktopOwnedByUser(dt, userId)
    if (desktopOwnedByOther) {
      pendingShareTargetRef.current = null
      setShareTarget(null)
      setShareToggling(false)
      setIsSharing(false)
      return { desktopOwnedByOther, helperSharing: false }
    }

    if (dt.stats) {
      setSharingStats({
        bytesServed: dt.stats.bytesServed,
        requestsHandled: dt.stats.requestsHandled,
      })
    }

    const helperSharing = isDesktopSharing(dt)
    if (pendingShareTargetRef.current !== null && helperSharing !== pendingShareTargetRef.current) {
      return { desktopOwnedByOther: false, helperSharing }
    }

    if (pendingShareTargetRef.current !== null) {
      pendingShareTargetRef.current = null
      setShareTarget(null)
      setShareToggling(false)
    }

    setIsSharing(helperSharing)
    return { desktopOwnedByOther: false, helperSharing }
  }, [])

  function startPolling() {
    if (pollRef.current) return
    let tick = 0
    pollRef.current = setInterval(async () => {
      tick++
      const dt = await checkDesktop()
      const currentBaseDeviceId = dt.baseDeviceId ?? dt.peer?.baseDeviceId ?? null
      const { data: { session } } = await supabase.auth.getSession()
      const user = session?.user ?? null
      const desktopOwnedByOther = dt.available && dt.userId && user && dt.userId !== user.id
      if (dt.available && !desktopOwnedByOther) {
        applyDesktopSnapshot(dt, user?.id ?? null)
        setShareError(prev => prev != null && prev.includes('signed in as a different user') ? null : prev)
      } else {
        setDesktop(dt)
        pendingShareTargetRef.current = null
        setShareTarget(null)
        setShareToggling(false)
        setIsSharing(false)
        if (desktopOwnedByOther) setShareError(getHelperMismatchError(dt.where))
        else setShareError(prev => prev != null && prev.includes('signed in as a different user') ? null : prev)
      }
      if (tick % 3 === 0 && user) {
        const { data } = await supabase.from('profiles').select('*').eq('id', user.id).single<Profile>()
        if (data) setProfile(data)
      }
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
      if (tick % 2 === 0) {
        if (currentBaseDeviceId && !desktopOwnedByOther) {
          loadPrivateShare(currentBaseDeviceId).catch(() => {})
        } else {
          setPrivateShare(null)
        }
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
    if (profile && !isDesktopOwnedByUser(desktop, profile.id)) {
      setShareError(getHelperMismatchError(desktop?.where))
      return
    }
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

  async function updateConnectionSlots(nextSlots: number) {
    if (slotUpdating) return
    if (profile && !isDesktopOwnedByUser(desktop, profile.id)) {
      setShareError(getHelperMismatchError(desktop?.where))
      return
    }
    if (!desktopAvailable && !cliRunning && !desktopRunning) {
      setShareError('Desktop or CLI not running. Start a local helper before changing connection slots.')
      return
    }
    setSlotUpdating(true)
    setShareError(null)
    try {
      const result = await setDesktopConnectionSlots(nextSlots)
      if (!result.ok || !result.state) throw new Error(result.error ?? 'Could not update connection slots')
      applyDesktopSnapshot(result.state, profile?.id ?? null)
    } catch (err: unknown) {
      setShareError(err instanceof Error ? err.message : 'Could not update connection slots')
    } finally {
      setSlotUpdating(false)
    }
  }

  async function saveDailyLimit(nextLimitMb: number | null) {
    if (dailyLimitSaving) return
    if (profile && !isDesktopOwnedByUser(desktop, profile.id)) {
      setDailyLimitError(getHelperMismatchError(desktop?.where))
      return
    }
    if (nextLimitMb !== null && nextLimitMb < DAILY_LIMIT_MIN_MB) {
      setDailyLimitError(`Minimum daily limit is ${DAILY_LIMIT_MIN_MB} MB (1 GB)`)
      return
    }
    setDailyLimitSaving(true)
    setDailyLimitError(null)
    try {
      const res = await fetch('/api/user/sharing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dailyLimitMb: nextLimitMb }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.error) throw new Error(data.error ?? 'Could not update daily limit')
      const savedLimit = data.daily_share_limit_mb ?? null
      setProfile(p => p ? { ...p, daily_share_limit_mb: savedLimit } : p)
      setDailyLimitInput(savedLimit != null ? String(savedLimit) : '')
    } catch (err: unknown) {
      setDailyLimitError(err instanceof Error ? err.message : 'Could not update daily limit')
    } finally {
      setDailyLimitSaving(false)
    }
  }

  // ── Share toggle ────────────────────────────────────────────────────────────
  async function handleShareToggle() {
    if (!profile || shareToggling) return
    if (!isDesktopOwnedByUser(desktop, profile.id)) {
      setShareError(getHelperMismatchError(desktop?.where))
      return
    }
    setShareError(null)

    if (isSharing) {
      pendingShareTargetRef.current = false
      setShareTarget(false)
      setShareToggling(true)
      const result = await stopDesktopSharing()
      if (result.state) applyDesktopSnapshot(result.state, profile.id)
      await fetch('/api/user/sharing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isSharing: false }),
      }).catch(() => {})
      if (!result.ok) {
        pendingShareTargetRef.current = null
        setShareTarget(null)
        setShareToggling(false)
        setIsSharing(true)
        setShareError('Could not stop sharing')
      }
      return
    }

    if (!profile.has_accepted_provider_terms) {
      setShowDisclosure(true)
      return
    }

    await startSharing()
  }

  async function startSharing() {
    setShareToggling(true)
    setShareError(null)

    if (!navigator.onLine) {
      setShareError('No internet connection – check your network and try again')
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
    if (!isDesktopOwnedByUser(dt, profile!.id)) {
      setShareError(getHelperMismatchError(dt.where))
      setShareToggling(false)
      return
    }

    const { data: { session } } = await supabase.auth.getSession()
    if (!session) {
      setShareError('Session expired – please sign out and sign back in')
      setShareToggling(false)
      return
    }

    pendingShareTargetRef.current = true
    setShareTarget(true)
    const result = await startDesktopSharing({
      token: session.access_token,
      userId: profile!.id,
      country: profile!.country_code,
      trust: profile!.trust_score,
    })

    if (!result.ok) {
      pendingShareTargetRef.current = null
      setShareTarget(null)
      setShareError(result.error ?? 'desktop_required')
      setShareToggling(false)
      return
    }

    if (result.state) {
      applyDesktopSnapshot(result.state, profile!.id)
    } else {
      pendingShareTargetRef.current = null
      setShareTarget(null)
      setIsSharing(true)
      setShareToggling(false)
    }
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
    const isPrivateConnect = !selectedCountry && !!trimmedPrivateCode
    if ((!selectedCountry && !trimmedPrivateCode) || !profile) return
    setConnectError(null)
    if (!navigator.onLine) {
      setConnectError('No internet connection – check your network and try again')
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
      setConnectError(msg === 'Failed to fetch' ? 'Network error – could not reach server' : msg)
    } finally {
      setConnecting(false)
    }
  }

  async function handleSignOut() {
    if (!confirm('Sign out of PeerMesh?')) return
    setSigningOut(true)
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
  const helperOwnedByCurrentUser = isDesktopOwnedByUser(desktop, profile.id)
  const desktopAvailableForUser = desktopAvailable && helperOwnedByCurrentUser
  const primaryWhere = desktop?.where ?? desktop?.source ?? null
  const isCLI = primaryWhere === 'cli'
  const isDesktopApp = primaryWhere === 'desktop'

  const peerRunning = desktop?.peer?.available ?? false
  const peerWhere = desktop?.peer?.where ?? null

  const desktopProcessVersion = isDesktopApp ? desktop?.version : (peerWhere === 'desktop' ? desktop?.peer?.version : null)
  const cliProcessVersion = isCLI ? desktop?.version : (peerWhere === 'cli' ? desktop?.peer?.version : null)
  const desktopRunning = isDesktopApp || peerWhere === 'desktop'
  const cliRunning = isCLI || peerWhere === 'cli'
  const desktopRunningForUser = desktopRunning && helperOwnedByCurrentUser
  const cliRunningForUser = cliRunning && helperOwnedByCurrentUser

  const desktopUpdateAvailable = !!(desktopRunning && latestDesktopVersion && desktopProcessVersion && latestDesktopVersion !== desktopProcessVersion)
  const cliUpdateAvailable = !!(cliRunning && latestCliVersion && cliProcessVersion && latestCliVersion !== cliProcessVersion)
  const extUpdateAvailable = !!(extInstalled && latestExtVersion && extVersion && latestExtVersion !== extVersion)
  const showExtBanner = !extInstalled || extUpdateAvailable
  const helperBaseDeviceId = helperOwnedByCurrentUser ? (desktop?.baseDeviceId ?? desktop?.peer?.baseDeviceId ?? null) : null
  const helperSlots = helperOwnedByCurrentUser ? (desktop?.slots ?? desktop?.peer?.slots ?? null) : null
  const slotDisplayCount = helperSlots?.configured ?? (helperOwnedByCurrentUser ? (desktop?.connectionSlots ?? desktop?.peer?.connectionSlots ?? 1) : 1)
  const slotDisplayActive = helperSlots?.active ?? 0
  const displayIsSharing = shareTarget ?? isSharing
  const privateConnectReady = !selectedCountry && !!privateCodeInput.trim()

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
          <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: '#ffaa00', letterSpacing: '0.5px' }}>NO INTERNET CONNECTION – features unavailable until reconnected</span>
        </div>
      )}

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '28px' }}>
        <span style={{ fontFamily: 'var(--font-geist-mono)', color: 'var(--accent)', fontSize: '13px', letterSpacing: '4px' }}>PEERMESH</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {profile.is_premium && (
            <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--accent)', border: '1px solid var(--accent)', padding: '3px 8px', borderRadius: '4px', letterSpacing: '1px' }}>PREMIUM</span>
          )}
          {desktopChecked && !isMobile && (
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
          <button onClick={handleSignOut} disabled={signingOut} style={{ background: 'none', border: '1px solid var(--border)', color: 'var(--muted)', padding: '6px 12px', borderRadius: '6px', fontSize: '11px', cursor: signingOut ? 'not-allowed' : 'pointer', fontFamily: 'var(--font-geist-mono)', opacity: signingOut ? 0.6 : 1 }}>{signingOut ? '...' : 'OUT'}</button>
        </div>
      </div>

      {/* Desktop update banner */}
      {!isMobile && desktopChecked && desktopRunning && desktopUpdateAvailable && (
        <a href="/api/desktop-download" download style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', background: 'rgba(0,255,136,0.05)', border: '1px solid rgba(0,255,136,0.3)', borderRadius: '12px', padding: '12px 16px', marginBottom: '16px', textDecoration: 'none' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '18px' }}>⬆️</span>
            <div>
              <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--accent)', letterSpacing: '0.5px', marginBottom: '2px' }}>DESKTOP UPDATE AVAILABLE – v{latestDesktopVersion}</div>
              <div style={{ fontSize: '12px', color: 'var(--muted)' }}>You have v{desktopProcessVersion}. Download the latest for best performance.</div>
            </div>
          </div>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: 'var(--accent)', whiteSpace: 'nowrap', flexShrink: 0 }}>↓ UPDATE</div>
        </a>
      )}

      {/* Desktop install banner */}
      {!isMobile && desktopChecked && !desktopRunning && !cliRunning && (
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
      {!isMobile && showExtBanner && (
        <a
          href={extUpdateAvailable ? '/api/extension-download' : '/extension'}
          download={extUpdateAvailable ? 'peermesh-extension.zip' : undefined}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', background: 'var(--surface)', border: `1px solid ${extUpdateAvailable ? 'rgba(255,200,0,0.5)' : 'var(--accent)'}`, borderRadius: '12px', padding: '12px 16px', marginBottom: '16px', textDecoration: 'none' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '18px' }}>🧩</span>
            <div>
              <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: extUpdateAvailable ? '#ffc800' : 'var(--accent)', letterSpacing: '0.5px', marginBottom: '2px' }}>
                {extUpdateAvailable ? `UPDATE AVAILABLE – v${latestExtVersion}` : 'CHROME EXTENSION – RECOMMENDED'}
              </div>
              <div style={{ fontSize: '12px', color: 'var(--muted)' }}>
                {extUpdateAvailable ? `You have v${extVersion}. Update for latest features.` : 'Routes your entire browser – YouTube, Google, Netflix all work'}
              </div>
            </div>
          </div>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: extUpdateAvailable ? '#ffc800' : 'var(--accent)', whiteSpace: 'nowrap', flexShrink: 0 }}>
            {extUpdateAvailable ? '↑ UPDATE ↑' : 'INSTALL →'}
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

      {/* Mobile: only show stats + bandwidth + free tier enforcement */}
      {!isMobile && (<>

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
              style={{ width: '100%', padding: '10px 36px 10px 12px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text)', fontFamily: 'var(--font-geist-mono)', fontSize: '12px', letterSpacing: '1px', boxSizing: 'border-box' }}
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
            Country selected – connecting publicly. Clear country to use private code.
          </div>
        )}
      </div>

      {/* Country picker */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '12px', padding: '16px', marginBottom: '16px', opacity: connecting ? 0.5 : 1, pointerEvents: connecting ? 'none' : 'auto' }}>
        <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--muted)', letterSpacing: '1px', marginBottom: '10px' }}>BROWSE AS...</div>
        <input
          value={countriesSearch}
          onChange={(e) => {
            const q = e.target.value
            setCountriesSearch(q)
            if (countriesSearchTimer.current) clearTimeout(countriesSearchTimer.current)
            countriesSearchTimer.current = setTimeout(() => loadCountries(1, q), 300)
          }}
          placeholder="Search country..."
          style={{ width: '100%', padding: '8px 10px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text)', fontFamily: 'var(--font-geist-mono)', fontSize: '11px', marginBottom: '10px', boxSizing: 'border-box' }}
        />
        {countriesLoading ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '12px', color: 'var(--muted)', fontFamily: 'var(--font-geist-mono)', fontSize: '11px' }}>
            <span style={{ display: 'inline-block', width: '10px', height: '10px', border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
            LOADING COUNTRIES...
          </div>
        ) : countriesError ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px', background: 'rgba(255,68,102,0.08)', border: '1px solid rgba(255,68,102,0.25)', borderRadius: '8px' }}>
            <span style={{ color: '#ff6060', fontSize: '12px' }}>Could not load countries</span>
            <button onClick={() => loadCountries(countriesPage, countriesSearch)} style={{ background: 'none', border: 'none', color: 'var(--accent)', fontFamily: 'var(--font-geist-mono)', fontSize: '10px', cursor: 'pointer' }}>RETRY</button>
          </div>
        ) : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px' }}>
              {countries.map(c => {
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
            {countriesTotalPages > 1 && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '10px' }}>
                <button onClick={() => loadCountries(countriesPage - 1, countriesSearch)} disabled={countriesPage <= 1} style={{ background: 'none', border: '1px solid var(--border)', color: countriesPage <= 1 ? 'var(--muted)' : 'var(--text)', borderRadius: '6px', padding: '5px 12px', fontFamily: 'var(--font-geist-mono)', fontSize: '10px', cursor: countriesPage <= 1 ? 'not-allowed' : 'pointer' }}>← PREV</button>
                <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--muted)' }}>{countriesPage} / {countriesTotalPages}</span>
                <button onClick={() => loadCountries(countriesPage + 1, countriesSearch)} disabled={countriesPage >= countriesTotalPages} style={{ background: 'none', border: '1px solid var(--border)', color: countriesPage >= countriesTotalPages ? 'var(--muted)' : 'var(--text)', borderRadius: '6px', padding: '5px 12px', fontFamily: 'var(--font-geist-mono)', fontSize: '10px', cursor: countriesPage >= countriesTotalPages ? 'not-allowed' : 'pointer' }}>NEXT →</button>
              </div>
            )}
          </>
        )}
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
      <div style={{ background: 'var(--surface)', border: `1px solid ${displayIsSharing ? 'rgba(0,255,136,0.3)' : shareError ? 'rgba(255,80,80,0.3)' : 'var(--border)'}`, borderRadius: '12px', padding: '16px', marginBottom: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: '14px', fontWeight: 500, marginBottom: '3px' }}>Share my connection</div>
            <div style={{ fontSize: '12px', color: displayIsSharing ? 'var(--accent)' : 'var(--muted)' }}>
              {shareToggling && shareTarget === true
                ? 'Connecting...'
                : displayIsSharing
                  ? `${sharingStats.requestsHandled} requests · ${formatBytes(sharingStats.bytesServed)} served · ${privateShare?.active ? '🔒 PRIVATE' : '🌐 PUBLIC'}`
                  : !helperOwnedByCurrentUser
                    ? 'Local helper belongs to another user.'
                    : desktopAvailableForUser
                      ? `${cliRunningForUser && desktopRunningForUser ? 'CLI + Desktop' : cliRunningForUser ? 'CLI' : 'Desktop'} ready – toggle to start sharing`
                      : 'Install the desktop app or run the CLI to share your connection'}
            </div>
          </div>
          <button
            onClick={handleShareToggle}
            disabled={shareToggling}
            style={{ width: '44px', height: '24px', borderRadius: '12px', border: 'none', background: displayIsSharing ? 'var(--accent)' : 'var(--border)', cursor: shareToggling ? 'not-allowed' : 'pointer', position: 'relative', transition: 'background 0.2s', flexShrink: 0, opacity: shareToggling ? 0.6 : 1 }}
          >
            {shareToggling
              ? <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><span style={{ width: '10px', height: '10px', border: '2px solid rgba(255,255,255,0.3)', borderTopColor: 'white', borderRadius: '50%', animation: 'spin 0.7s linear infinite', display: 'inline-block' }} /></span>
              : <div style={{ position: 'absolute', width: '18px', height: '18px', borderRadius: '50%', background: 'white', top: '3px', left: displayIsSharing ? '23px' : '3px', transition: 'left 0.2s' }} />
            }
          </button>
        </div>

        <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--muted)', letterSpacing: '0.5px', marginBottom: '4px' }}>CONNECTION SLOTS</div>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '8px' }}>
                {Array.from({ length: slotDisplayCount }, (_, index) => {
                  const running = !!helperSlots?.statuses?.[index]?.running || index < slotDisplayActive
                  return (
                    <span
                      key={`slot-dot-${index}`}
                      style={{
                        width: '10px',
                        height: '10px',
                        borderRadius: '999px',
                        background: running ? 'var(--accent)' : 'var(--border)',
                        boxShadow: running ? '0 0 8px rgba(0,255,136,0.35)' : 'none',
                      }}
                    />
                  )
                })}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--muted)' }}>
                {slotDisplayActive} / {slotDisplayCount} active{helperSlots?.warning ? ` – ${helperSlots.warning}` : ''}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
              <button
                onClick={() => updateConnectionSlots(slotDisplayCount - 1)}
                disabled={slotUpdating || slotDisplayCount <= 1 || !desktopAvailableForUser}
                style={{ width: '30px', height: '30px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg)', color: slotDisplayCount <= 1 ? 'var(--muted)' : 'var(--text)', cursor: slotUpdating || slotDisplayCount <= 1 || !desktopAvailableForUser ? 'not-allowed' : 'pointer', fontFamily: 'var(--font-geist-mono)', fontSize: '16px' }}
              >-</button>
              <div style={{ minWidth: '28px', textAlign: 'center', fontFamily: 'var(--font-geist-mono)', fontSize: '12px', color: 'var(--text)' }}>
                {slotUpdating ? '...' : slotDisplayCount}
              </div>
              <button
                onClick={() => updateConnectionSlots(slotDisplayCount + 1)}
                disabled={slotUpdating || slotDisplayCount >= 32 || !desktopAvailableForUser}
                style={{ width: '30px', height: '30px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg)', color: slotDisplayCount >= 32 ? 'var(--muted)' : 'var(--text)', cursor: slotUpdating || slotDisplayCount >= 32 || !desktopAvailableForUser ? 'not-allowed' : 'pointer', fontFamily: 'var(--font-geist-mono)', fontSize: '16px' }}
              >+</button>
            </div>
          </div>
        </div>

        {/* Daily limit */}
        <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
          <div>
            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--muted)', letterSpacing: '0.5px', marginBottom: '2px' }}>DAILY SHARE LIMIT</div>
            <div style={{ fontSize: '11px', color: 'var(--muted)' }}>
              {profile.daily_share_limit_mb != null ? `${profile.daily_share_limit_mb} MB/day – auto-stops when reached` : 'No limit set'}
            </div>
          </div>
          <div style={{ display: 'grid', gap: '8px', minWidth: '220px', flex: '1 1 220px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '8px' }}>
              <input
                value={dailyLimitInput}
                onChange={(e) => { setDailyLimitInput(e.target.value.replace(/\D/g, '')); setDailyLimitError(null) }}
                inputMode="numeric"
                placeholder="1024+ MB"
                disabled={!helperOwnedByCurrentUser}
                style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: '6px', padding: '7px 9px', fontFamily: 'var(--font-geist-mono)', fontSize: '10px' }}
              />
              <button
                onClick={() => saveDailyLimit(dailyLimitInput ? Number.parseInt(dailyLimitInput, 10) : null)}
                disabled={dailyLimitSaving || !helperOwnedByCurrentUser}
                style={{ padding: '7px 12px', background: 'var(--accent)', color: '#000', border: 'none', borderRadius: '6px', fontFamily: 'var(--font-geist-mono)', fontSize: '10px', fontWeight: 700, cursor: dailyLimitSaving || !helperOwnedByCurrentUser ? 'not-allowed' : 'pointer', opacity: dailyLimitSaving || !helperOwnedByCurrentUser ? 0.6 : 1 }}
              >
                {dailyLimitSaving ? '...' : 'APPLY'}
              </button>
            </div>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              {[1024, 2048, 5120].map(limit => (
                <button
                  key={`limit-preset-${limit}`}
                  onClick={() => { setDailyLimitInput(String(limit)); void saveDailyLimit(limit) }}
                  disabled={dailyLimitSaving || !helperOwnedByCurrentUser}
                  style={{ padding: '6px 8px', background: profile.daily_share_limit_mb === limit ? 'var(--accent-dim)' : 'var(--bg)', color: profile.daily_share_limit_mb === limit ? 'var(--accent)' : 'var(--text)', border: `1px solid ${profile.daily_share_limit_mb === limit ? 'rgba(0,255,136,0.4)' : 'var(--border)'}`, borderRadius: '6px', fontFamily: 'var(--font-geist-mono)', fontSize: '9px', cursor: dailyLimitSaving || !helperOwnedByCurrentUser ? 'not-allowed' : 'pointer', opacity: dailyLimitSaving || !helperOwnedByCurrentUser ? 0.6 : 1 }}
                >
                  {limit >= 1024 ? `${limit / 1024} GB` : `${limit} MB`}
                </button>
              ))}
              <button
                onClick={() => { setDailyLimitInput(''); void saveDailyLimit(null) }}
                disabled={dailyLimitSaving || !helperOwnedByCurrentUser}
                style={{ padding: '6px 8px', background: profile.daily_share_limit_mb == null ? 'var(--accent-dim)' : 'var(--bg)', color: profile.daily_share_limit_mb == null ? 'var(--accent)' : 'var(--text)', border: `1px solid ${profile.daily_share_limit_mb == null ? 'rgba(0,255,136,0.4)' : 'var(--border)'}`, borderRadius: '6px', fontFamily: 'var(--font-geist-mono)', fontSize: '9px', cursor: dailyLimitSaving || !helperOwnedByCurrentUser ? 'not-allowed' : 'pointer', opacity: dailyLimitSaving || !helperOwnedByCurrentUser ? 0.6 : 1 }}
              >
                NO LIMIT
              </button>
            </div>
            {dailyLimitError && (
              <div style={{ fontSize: '10px', color: '#ff9090', fontFamily: 'var(--font-geist-mono)', lineHeight: 1.5 }}>
                {dailyLimitError}
              </div>
            )}
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
                  if (isSharing) {
                    pendingShareTargetRef.current = false
                    const result = await stopDesktopSharing()
                    if (result.state) applyDesktopSnapshot(result.state, profile.id)
                    else { pendingShareTargetRef.current = null; setIsSharing(false) }
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
              Sharing is PRIVATE – only requesters with your code can connect.
            </div>
          )}
          {isSharing && !privateShare?.active && (
            <div style={{ marginTop: '8px', fontSize: '11px', color: 'var(--muted)', fontFamily: 'var(--font-geist-mono)', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border)', borderRadius: '6px', padding: '6px 10px' }}>
              Sharing is PUBLIC – any verified user can connect.
            </div>
          )}
          {privateShare?.expires_at && (
            <div style={{ marginTop: '10px', fontSize: '11px', color: 'var(--muted)' }}>
              Expires {new Date(privateShare.expires_at).toLocaleString()}
            </div>
          )}
        </div>
      )}

      {/* Free tier enforcement – shown on all screen sizes */}
      {!profile.is_premium && !isSharing && (selectedCountry || privateConnectReady) && !isMobile && (
        <div style={{ background: 'rgba(255,80,80,0.07)', border: '1px solid rgba(255,80,80,0.3)', borderRadius: '10px', padding: '12px 16px', marginBottom: '16px', fontSize: '12px', color: '#ff9090' }}>
          <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', letterSpacing: '0.5px' }}>FREE TIER – </span>
          Enable sharing above to connect, or{' '}
          <a href="/verify/payment" style={{ color: 'var(--accent)', textDecoration: 'underline' }}>upgrade to premium</a> to browse without sharing.
        </div>
      )}

      {/* Close desktop-only wrapper */}
      </>)}

      {/* Upgrade banner – always visible so mobile users can upgrade */}
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

      {/* Desktop-only: premium reservation, CLI banner, modals */}
      {!isMobile && (<>

      {/* Premium peer reservation */}
      {profile.is_premium && selectedCountry && (
        <div style={{ padding: '14px 16px', background: 'var(--surface)', border: '1px solid rgba(0,255,136,0.2)', borderRadius: '10px', marginBottom: '12px' }}>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--accent)', letterSpacing: '0.5px', marginBottom: '6px' }}>PREMIUM – PEER RESERVATION</div>
          {(profile.preferred_providers as Record<string, string>)?.[selectedCountry] ? (
            <>
              <div style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: '10px' }}>
                Reserved peer for <strong style={{ color: 'var(--text)' }}>{selectedCountry}</strong> – they will be matched first on every connection.
              </div>
              <button
                onClick={async () => {
                  const { data: { session } } = await supabase.auth.getSession()
                  if (!session) return
                  await supabase.from('profiles').update({
                    preferred_providers: { ...(profile.preferred_providers as Record<string, string>), [selectedCountry]: undefined }
                  }).eq('id', session.user.id)
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
                ? cliUpdateAvailable ? `CLI UPDATE AVAILABLE – v${latestCliVersion}` : '● CLI DETECTED – SHARING ACTIVE'
                : 'SHARE FROM ANY MACHINE'}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--muted)' }}>
              {cliRunning
                ? cliUpdateAvailable ? `You have v${cliProcessVersion}. Run: npm install -g @btcmaster1000/peermesh-provider@latest` : `v${cliProcessVersion} – in sync with this dashboard`
                : latestCliVersion ? `Latest: v${latestCliVersion} – no desktop app needed` : 'No desktop app needed – just Node.js'}
            </div>
          </div>
        </div>
        <button
          onClick={() => { setCliDocTab(detectedOS); setShowCliDocs(true) }}
          style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: cliUpdateAvailable ? '#ffc800' : 'var(--accent)', background: 'var(--bg)', border: `1px solid ${cliUpdateAvailable ? 'rgba(255,200,0,0.4)' : 'rgba(0,255,136,0.3)'}`, padding: '5px 10px', borderRadius: '5px', cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0 }}
        >
          {cliUpdateAvailable ? '↑ UPDATE ↑' : 'CLI DOCS →'}
        </button>
      </div>

      {/* CLI Docs modal */}
      {showCliDocs && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '20px' }}>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '16px', padding: '24px', maxWidth: '560px', width: '100%', maxHeight: '90vh', overflowY: 'auto' }}>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
              <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: 'var(--accent)', letterSpacing: '1px' }}>CLI REFERENCE</div>
              <button onClick={() => setShowCliDocs(false)} style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: '16px', lineHeight: 1, padding: 0 }}>✕</button>
            </div>

            <div style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: '16px', lineHeight: 1.6 }}>
              Run on any machine with Node.js 18+. The dashboard and desktop app detect it automatically on the same machine. Slots, daily limit, and private sharing stay in sync across all surfaces.
            </div>

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

            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '9px', color: 'var(--muted)', letterSpacing: '0.5px', marginBottom: '10px' }}>INSTALL</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '20px' }}>
              <CliSection label="Run once without installing (recommended for first try)" cmd="npx @btcmaster1000/peermesh-provider" />
              <CliSection label="Install globally" cmd="npm install -g @btcmaster1000/peermesh-provider" />
              <CliSection label="Update to latest" cmd="npm install -g @btcmaster1000/peermesh-provider@latest" />
              {cliDocTab === 'windows' && (
                <>
                  <CliSection label="Install Node.js (winget)" cmd="winget install OpenJS.NodeJS" />
                  <CliSection label="Install Node.js (PowerShell)" cmd={`Invoke-WebRequest https://nodejs.org/dist/v20.11.0/node-v20.11.0-x64.msi -OutFile node.msi\nStart-Process msiexec -ArgumentList '/i node.msi /quiet' -Wait`} />
                </>
              )}
              {cliDocTab === 'mac' && (
                <>
                  <CliSection label="Install Node.js (Homebrew)" cmd="brew install node" />
                  <CliSection label="Install Node.js (curl)" cmd={`curl -fsSL https://nodejs.org/dist/v20.11.0/node-v20.11.0.pkg -o node.pkg\nsudo installer -pkg node.pkg -target /`} />
                </>
              )}
              {cliDocTab === 'linux' && (
                <>
                  <CliSection label="Install Node.js (Debian/Ubuntu)" cmd={`curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -\nsudo apt-get install -y nodejs`} />
                  <CliSection label="Install Node.js (RHEL/Fedora)" cmd={`curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -\nsudo dnf install -y nodejs`} />
                </>
              )}
            </div>

            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '9px', color: 'var(--muted)', letterSpacing: '0.5px', marginBottom: '10px' }}>BASIC USAGE</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '20px' }}>
              <CliSection label="Start sharing (sign-in prompt on first run)" cmd="peermesh-provider" />
              <CliSection label="Show status, live slot count, and today's usage, then exit" cmd="peermesh-provider --status" />
              <CliSection label="Skip the provider terms prompt (scripts / CI)" cmd="peermesh-provider --serve" />
              <CliSection label="Print verbose debug logs to console" cmd="peermesh-provider --debug" />
              <CliSection label="Clear saved credentials and re-authenticate" cmd="peermesh-provider --reset" />
            </div>

            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '9px', color: 'var(--muted)', letterSpacing: '0.5px', marginBottom: '10px' }}>CONNECTION SLOTS</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '20px' }}>
              <CliSection label="Run with 4 concurrent slots" cmd="peermesh-provider --slots 4" />
              <CliSection label="--slot is also accepted (alias)" cmd="peermesh-provider --slot 4" />
              <CliSection label="Run with 16 slots (high throughput server)" cmd="peermesh-provider --slots 16" />
              <div style={{ fontSize: '11px', color: 'var(--muted)', lineHeight: 1.6, padding: '8px 10px', background: 'var(--bg)', borderRadius: '7px', border: '1px solid var(--border)' }}>
                Each slot is an independent relay WebSocket. Slots 1–8 are safe for home connections. 9–16 for stable broadband. 17–32 for servers only. The dashboard and desktop app stay in sync – changing slots in one surface updates the other. Both <code style={{fontFamily:'var(--font-geist-mono)'}}>--slots</code> and <code style={{fontFamily:'var(--font-geist-mono)'}}>--slot</code> are accepted.
              </div>
            </div>

            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '9px', color: 'var(--muted)', letterSpacing: '0.5px', marginBottom: '10px' }}>DAILY BANDWIDTH LIMIT</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '20px' }}>
              <CliSection label="Cap at 500 MB/day" cmd="peermesh-provider --limit 500" />
              <CliSection label="Cap at 2 GB/day" cmd="peermesh-provider --limit 2048" />
              <CliSection label="Remove the daily cap" cmd="peermesh-provider --no-limit" />
              <div style={{ fontSize: '11px', color: 'var(--muted)', lineHeight: 1.6, padding: '8px 10px', background: 'var(--bg)', borderRadius: '7px', border: '1px solid var(--border)' }}>
                When the limit is reached, sharing pauses automatically and resumes at midnight – the process stays running. The limit is also synced from the dashboard and desktop app.
              </div>
            </div>

            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '9px', color: 'var(--muted)', letterSpacing: '0.5px', marginBottom: '10px' }}>PRIVATE SHARING</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '20px' }}>
              <CliSection label="Enable private sharing (generates a 9-digit code)" cmd="peermesh-provider --private-on" />
              <CliSection label="Disable private sharing (back to public)" cmd="peermesh-provider --private-off" />
              <CliSection label="Rotate the private code (keep sharing enabled)" cmd="peermesh-provider --private-refresh" />
              <CliSection label="Show current private sharing status and code" cmd="peermesh-provider --private-status" />
              <CliSection label="Set code expiry to 1 hour" cmd="peermesh-provider --private-on --private-expiry 1" />
              <CliSection label="Set code expiry to 7 days" cmd="peermesh-provider --private-on --private-expiry 168" />
              <CliSection label="Set code with no expiry" cmd="peermesh-provider --private-on --private-expiry none" />
              <div style={{ fontSize: '11px', color: 'var(--muted)', lineHeight: 1.6, padding: '8px 10px', background: 'var(--bg)', borderRadius: '7px', border: '1px solid var(--border)' }}>
                Private sharing restricts connections to requesters who know your 9-digit code. Changing the mode (on/off) stops sharing – restart manually to apply. The code and state sync with the dashboard and desktop app.
              </div>
            </div>

            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '9px', color: 'var(--muted)', letterSpacing: '0.5px', marginBottom: '10px' }}>COMBINING FLAGS</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '20px' }}>
              <CliSection label="4 slots, 1 GB/day cap, verbose logs" cmd="peermesh-provider --slots 4 --limit 1024 --debug" />
              <CliSection label="8 slots, private, 24h expiry, no terms prompt" cmd="peermesh-provider --slots 8 --private-on --private-expiry 24 --serve" />
              <CliSection label="Check live status without starting" cmd="peermesh-provider --status" />
            </div>

            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '9px', color: 'var(--muted)', letterSpacing: '0.5px', marginBottom: '10px' }}>RUN AT STARTUP</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '20px' }}>
              {cliDocTab === 'windows' && (
                <CliSection label="Register as a login startup task (PowerShell, run as admin)" cmd={`$action = New-ScheduledTaskAction -Execute "$(where.exe peermesh-provider)" -Argument "--serve"\n$trigger = New-ScheduledTaskTrigger -AtLogOn\nRegister-ScheduledTask -TaskName "PeerMesh" -Action $action -Trigger $trigger -RunLevel Highest -Force`} />
              )}
              {cliDocTab === 'mac' && (
                <CliSection label="Register as a launchd service" cmd={`cat > ~/Library/LaunchAgents/app.peermesh.provider.plist <<EOF\n<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n  <key>Label</key><string>app.peermesh.provider</string>\n  <key>ProgramArguments</key><array>\n    <string>$(which peermesh-provider)</string>\n    <string>--serve</string>\n  </array>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n</dict></plist>\nEOF\nlaunchctl load ~/Library/LaunchAgents/app.peermesh.provider.plist`} />
              )}
              {cliDocTab === 'linux' && (
                <CliSection label="Register as a systemd service" cmd={`sudo tee /etc/systemd/system/peermesh.service <<EOF\n[Unit]\nDescription=PeerMesh Provider\nAfter=network.target\n\n[Service]\nExecStart=$(which peermesh-provider) --serve\nRestart=always\nRestartSec=10\nUser=$USER\n\n[Install]\nWantedBy=multi-user.target\nEOF\nsudo systemctl enable --now peermesh.service`} />
              )}
            </div>

            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '9px', color: 'var(--muted)', letterSpacing: '0.5px', marginBottom: '10px' }}>UNINSTALL</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <CliSection label="Remove the CLI" cmd="npm uninstall -g @btcmaster1000/peermesh-provider" />
              {cliDocTab === 'windows' && (
                <>
                  <CliSection label="Remove saved credentials (PowerShell)" cmd={`Remove-Item -Recurse -Force "$env:USERPROFILE\\.peermesh"`} />
                  <CliSection label="Remove saved credentials (cmd)" cmd={`rmdir /s /q "%USERPROFILE%\\.peermesh"`} />
                  <CliSection label="Remove startup task" cmd={`Unregister-ScheduledTask -TaskName "PeerMesh" -Confirm:$false`} />
                </>
              )}
              {cliDocTab === 'mac' && (
                <>
                  <CliSection label="Remove saved credentials" cmd="rm -rf ~/.peermesh" />
                  <CliSection label="Remove startup service" cmd={`launchctl unload ~/Library/LaunchAgents/app.peermesh.provider.plist\nrm ~/Library/LaunchAgents/app.peermesh.provider.plist`} />
                </>
              )}
              {cliDocTab === 'linux' && (
                <>
                  <CliSection label="Remove saved credentials" cmd="rm -rf ~/.peermesh" />
                  <CliSection label="Remove startup service" cmd={`sudo systemctl disable --now peermesh.service\nsudo rm /etc/systemd/system/peermesh.service`} />
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
              ['📋', 'All sessions are logged with signed receipts. You can see what passed through in your session history.'],
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
                  const { data: { session } } = await supabase.auth.getSession()
                  if (session) {
                    await supabase.from('profiles').update({ has_accepted_provider_terms: true }).eq('id', session.user.id)
                    setProfile(p => p ? { ...p, has_accepted_provider_terms: true } : p)
                  }
                  await startSharing()
                }}
                style={{ padding: '12px', background: 'var(--accent)', border: 'none', borderRadius: '8px', color: '#000', cursor: 'pointer', fontFamily: 'var(--font-geist-mono)', fontSize: '11px', fontWeight: 700 }}
              >
                I UNDERSTAND – SHARE
              </button>
            </div>
          </div>
        </div>
      )}
      {/* End desktop-only block */}
      </>)}

    </main>
  )
}
