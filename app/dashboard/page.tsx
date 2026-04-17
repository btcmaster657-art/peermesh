'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { checkAgent, startAgent, stopAgent } from '@/lib/agent-client'
import { COUNTRIES, formatBytes, getFlagForCountry } from '@/lib/utils'
import type { Profile, PeerAvailability } from '@/lib/types'

const RELAY = process.env.NEXT_PUBLIC_RELAY_ENDPOINT ?? 'ws://localhost:8080'

export default function Dashboard() {
  const router = useRouter()
  const supabase = createClient()
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const [profile, setProfile] = useState<Profile | null>(null)
  const [peerCounts, setPeerCounts] = useState<Record<string, number>>({})
  const [selectedCountry, setSelectedCountry] = useState<string | null>(null)
  const [isSharing, setIsSharing] = useState(false)
  const [agentStats, setAgentStats] = useState({ bytesServed: 0, requestsHandled: 0 })
  const [connecting, setConnecting] = useState(false)
  const [loading, setLoading] = useState(true)

  // ── Load profile ────────────────────────────────────────────────────────────
  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/auth?mode=login'); return }

      const { data } = await supabase.from('profiles').select('*').eq('id', user.id).single<Profile>()
      if (!data?.is_verified) { router.push('/verify/payment'); return }

      setProfile(data)
      setLoading(false)

      // Check if agent is running (for users with extension/agent already active)
      if (data.is_sharing) {
        const health = await checkAgent()
        if (health?.running) {
          setIsSharing(true)
          setAgentStats({ bytesServed: health.stats.bytesServed, requestsHandled: health.stats.requestsHandled })
          startPolling()
        } else {
          await fetch('/api/user/sharing', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ isSharing: false }),
          })
        }
      }
    }
    load()
    return () => stopPolling()
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

  // ── Poll agent health ───────────────────────────────────────────────────────
  function startPolling() {
    if (pollRef.current) return
    pollRef.current = setInterval(async () => {
      const health = await checkAgent()
      if (health?.running) {
        setAgentStats({ bytesServed: health.stats.bytesServed, requestsHandled: health.stats.requestsHandled })
      } else {
        setIsSharing(false)
        stopPolling()
        await fetch('/api/user/sharing', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isSharing: false }),
        })
      }
    }, 5000)
  }

  function stopPolling() {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
  }

  // ── Share toggle — extension handles this ──────────────────────────────────
  const handleShareToggle = useCallback(async () => {
    if (!profile) return

    if (isSharing) {
      // Turn OFF
      setIsSharing(false)
      stopPolling()
      await stopAgent()
      await fetch('/api/user/sharing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isSharing: false }),
      })
      return
    }

    // Turn ON — check if extension/agent already running
    const health = await checkAgent()
    if (health?.running) {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) return
      await startAgent({
        relay: RELAY,
        apiBase: process.env.NEXT_PUBLIC_APP_URL ?? '',
        token: session.access_token,
        userId: profile.id,
        country: profile.country_code,
        trust: profile.trust_score,
      })
      setIsSharing(true)
      startPolling()
      await fetch('/api/user/sharing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isSharing: true }),
      })
      return
    }

    // Not running — send to extension page
    router.push('/extension#share')
  }, [profile, isSharing])

  // ── Connect ─────────────────────────────────────────────────────────────────
  async function handleConnect() {
    if (!selectedCountry || !profile) return
    setConnecting(true)
    try {
      const res = await fetch('/api/session/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ country: selectedCountry }),
      })
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      router.push(`/browse?relay=${encodeURIComponent(data.relayEndpoint)}&country=${selectedCountry}&userId=${profile.id}&dbSessionId=${data.sessionId}`)
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Could not connect')
    } finally {
      setConnecting(false)
    }
  }

  async function handleSignOut() {
    stopPolling()
    await stopAgent()
    await supabase.auth.signOut()
    router.push('/')
  }

  if (loading) {
    return (
      <main className="flex flex-1 items-center justify-center">
        <div style={{ fontFamily: 'var(--font-geist-mono)', color: 'var(--muted)', fontSize: '12px', letterSpacing: '2px' }}>LOADING...</div>
      </main>
    )
  }

  if (!profile) return null

  const bandwidthPct = Math.min(100, Math.round((profile.bandwidth_used_month / profile.bandwidth_limit) * 100))

  return (
    <main style={{ maxWidth: '680px', margin: '0 auto', width: '100%', padding: '24px 20px' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '28px' }}>
        <span style={{ fontFamily: 'var(--font-geist-mono)', color: 'var(--accent)', fontSize: '13px', letterSpacing: '4px' }}>PEERMESH</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {profile.is_premium && (
            <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--accent)', border: '1px solid var(--accent)', padding: '3px 8px', borderRadius: '4px', letterSpacing: '1px' }}>PREMIUM</span>
          )}
          <span style={{ fontSize: '13px', color: 'var(--muted)' }}>{profile.username ?? 'user'}</span>
          <button onClick={handleSignOut} style={{ background: 'none', border: '1px solid var(--border)', color: 'var(--muted)', padding: '6px 12px', borderRadius: '6px', fontSize: '11px', cursor: 'pointer', fontFamily: 'var(--font-geist-mono)' }}>OUT</button>
        </div>
      </div>

      {/* Extension banner */}
      {!selectedCountry && (
        <a
          href="/extension"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', background: 'var(--surface)', border: '1px solid var(--accent)', borderRadius: '12px', padding: '12px 16px', marginBottom: '16px', textDecoration: 'none' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '18px' }}>🧩</span>
            <div>
              <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--accent)', letterSpacing: '0.5px', marginBottom: '2px' }}>CHROME EXTENSION — RECOMMENDED</div>
              <div style={{ fontSize: '12px', color: 'var(--muted)' }}>Routes your entire browser — YouTube, Google, Netflix all work</div>
            </div>
          </div>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: 'var(--accent)', whiteSpace: 'nowrap', flexShrink: 0 }}>GET IT →</div>
        </a>
      )}

      {/* Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px', marginBottom: '20px' }}>
        {[
          { label: 'TRUST', value: String(profile.trust_score) },
          { label: 'SHARED', value: formatBytes(profile.total_bytes_shared) },
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
                onClick={() => setSelectedCountry(selected ? null : c.code)}
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

      {/* Connect buttons */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '16px' }}>
        <a
          href="/extension"
          style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '6px',
            padding: '14px 10px', background: selectedCountry ? 'var(--accent)' : 'var(--surface)',
            color: selectedCountry ? '#000' : 'var(--muted)',
            border: `1px solid ${selectedCountry ? 'var(--accent)' : 'var(--border)'}`,
            borderRadius: '10px', textDecoration: 'none', textAlign: 'center', transition: 'all 0.2s',
          }}
        >
          <span style={{ fontSize: '18px' }}>🧩</span>
          <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', fontWeight: 700, letterSpacing: '0.5px' }}>EXTENSION</span>
          <span style={{ fontSize: '10px', opacity: 0.7 }}>Full browser · YouTube works</span>
        </a>

        <button
          onClick={handleConnect}
          disabled={!selectedCountry || connecting}
          style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '6px',
            padding: '14px 10px', background: 'var(--surface)',
            color: !selectedCountry || connecting ? 'var(--muted)' : 'var(--text)',
            border: `1px solid ${!selectedCountry ? 'var(--border)' : 'rgba(0,255,136,0.4)'}`,
            borderRadius: '10px', cursor: !selectedCountry || connecting ? 'not-allowed' : 'pointer',
            textAlign: 'center', transition: 'all 0.2s',
          }}
        >
          <span style={{ fontSize: '18px' }}>🌐</span>
          <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', fontWeight: 700, letterSpacing: '0.5px' }}>
            {connecting ? 'CONNECTING...' : 'WEB BROWSER'}
          </span>
          <span style={{ fontSize: '10px', opacity: 0.7 }}>In-page · Most sites</span>
        </button>
      </div>

      {/* Share toggle */}
      <div style={{ background: 'var(--surface)', border: `1px solid ${isSharing ? 'rgba(0,255,136,0.3)' : 'var(--border)'}`, borderRadius: '12px', padding: '16px', marginBottom: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: '14px', fontWeight: 500, marginBottom: '3px' }}>Share my connection</div>
            <div style={{ fontSize: '12px', color: isSharing ? 'var(--accent)' : 'var(--muted)' }}>
              {isSharing
                ? `${agentStats.requestsHandled} requests · ${formatBytes(agentStats.bytesServed)} served`
                : 'Install the extension to share and earn credits'}
            </div>
          </div>
          <button
            onClick={handleShareToggle}
            style={{ width: '44px', height: '24px', borderRadius: '12px', border: 'none', background: isSharing ? 'var(--accent)' : 'var(--border)', cursor: 'pointer', position: 'relative', transition: 'background 0.2s', flexShrink: 0 }}
          >
            <div style={{ position: 'absolute', width: '18px', height: '18px', borderRadius: '50%', background: 'white', top: '3px', left: isSharing ? '23px' : '3px', transition: 'left 0.2s' }} />
          </button>
        </div>
      </div>

      {/* Windows desktop app download */}
      {typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows') && (
        <a
          href="/api/desktop-download"
          download="PeerMesh-Setup.exe"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '12px', padding: '12px 16px', marginBottom: '16px', textDecoration: 'none' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '18px' }}>🖥️</span>
            <div>
              <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--text)', letterSpacing: '0.5px', marginBottom: '2px' }}>WINDOWS DESKTOP APP</div>
              <div style={{ fontSize: '12px', color: 'var(--muted)' }}>Share your connection without the browser open — runs in system tray</div>
            </div>
          </div>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: 'var(--muted)', whiteSpace: 'nowrap', flexShrink: 0 }}>↓ DOWNLOAD</div>
        </a>
      )}

      {/* Tier / upgrade */}
      {!profile.is_premium && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', background: 'var(--accent-dim)', border: '1px solid rgba(0,255,136,0.2)', borderRadius: '10px' }}>
          <div>
            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: 'var(--accent)', letterSpacing: '0.5px', marginBottom: '2px' }}>FREE TIER</div>
            <div style={{ fontSize: '12px', color: 'var(--muted)' }}>Upgrade to browse without sharing your IP</div>
          </div>
          <a href="/upgrade" style={{ padding: '8px 14px', background: 'var(--accent)', color: '#000', borderRadius: '7px', fontSize: '11px', fontFamily: 'var(--font-geist-mono)', fontWeight: 700, textDecoration: 'none', letterSpacing: '0.5px', whiteSpace: 'nowrap' }}>
            UPGRADE $7
          </a>
        </div>
      )}
    </main>
  )
}
