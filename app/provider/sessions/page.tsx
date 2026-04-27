'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { formatBytes } from '@/lib/utils'

type ProviderSessionRecord = {
  id: string
  target_country: string
  target_host: string | null
  target_hosts: string[]
  status: string
  bytes_used: number
  disconnect_reason: string | null
  started_at: string
  ended_at: string | null
}

export default function ProviderSessionsPage() {
  const supabase = createClient()
  const [sessions, setSessions] = useState<ProviderSessionRecord[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reportingId, setReportingId] = useState<string | null>(null)
  const [expandedHosts, setExpandedHosts] = useState<Record<string, boolean>>({})

  const getAccessToken = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token ?? null
  }, [supabase])

  const loadSessions = useCallback(async (query = search) => {
    setLoading(true)
    setError('')
    try {
      const token = await getAccessToken()
      const params = new URLSearchParams()
      if (query.trim()) params.set('q', query.trim())
      const res = await fetch(`/api/provider/sessions?${params}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not load provider sessions')
      setSessions(data.sessions ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load provider sessions')
    } finally {
      setLoading(false)
    }
  }, [getAccessToken, search])

  async function reportRequester(sessionId: string) {
    const reason = window.prompt('Reason for reporting this requester')
    if (!reason) return
    setReportingId(sessionId)
    setError('')
    try {
      const token = await getAccessToken()
      const res = await fetch('/api/abuse/report', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          sessionId,
          reason,
          reportSubject: 'requester',
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not submit report')
      await loadSessions()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not submit report')
    } finally {
      setReportingId(null)
    }
  }

  useEffect(() => {
    void loadSessions('')
  }, [loadSessions])

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadSessions(search)
    }, 10000)
    return () => window.clearInterval(timer)
  }, [loadSessions, search])

  return (
    <main className="flex flex-1 justify-center px-6 py-16">
      <div style={{ width: '100%', maxWidth: '900px', display: 'grid', gap: '16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '12px', color: 'var(--accent)', letterSpacing: '3px', marginBottom: '6px' }}>
              PROVIDER SESSIONS
            </div>
            <h1 style={{ margin: 0, fontSize: '24px', fontWeight: 600 }}>Realtime routed traffic</h1>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <Link href="/dashboard" style={{ padding: '9px 12px', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text)', textDecoration: 'none', fontFamily: 'var(--font-geist-mono)', fontSize: '11px' }}>
              DASHBOARD
            </Link>
            <Link href="/developers/api-docs" style={{ padding: '9px 12px', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text)', textDecoration: 'none', fontFamily: 'var(--font-geist-mono)', fontSize: '11px' }}>
              API DOCS
            </Link>
          </div>
        </div>

        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '12px', padding: '16px', display: 'grid', gap: '12px' }}>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void loadSessions(search) }}
            placeholder="Search host"
            style={{ width: '100%', padding: '10px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', boxSizing: 'border-box' }}
          />
          {error ? <div style={{ color: '#ff8080', fontSize: '13px' }}>{error}</div> : null}
          {loading ? <div style={{ color: 'var(--muted)', fontFamily: 'var(--font-geist-mono)', fontSize: '11px' }}>LOADING...</div> : null}
          {!loading && sessions.length === 0 ? (
            <div style={{ color: 'var(--muted)', fontSize: '13px' }}>No sessions match the current filter.</div>
          ) : null}
          {sessions.map((session) => {
            const expanded = expandedHosts[session.id] === true
            const visibleHosts = expanded ? session.target_hosts : session.target_hosts.slice(0, 3)

            return (
              <div key={session.id} style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '12px', display: 'grid', gap: '10px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '12px', color: 'var(--accent)' }}>
                      {session.target_host ?? 'Host pending'}
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--muted)', marginTop: '4px' }}>
                      {session.target_country} · {session.status.toUpperCase()}
                    </div>
                  </div>
                  <button
                    onClick={() => void reportRequester(session.id)}
                    disabled={reportingId === session.id}
                    style={{ padding: '9px 12px', borderRadius: '8px', border: '1px solid rgba(255,96,96,0.35)', background: 'rgba(255,96,96,0.08)', color: '#ff8080', fontFamily: 'var(--font-geist-mono)', fontSize: '11px', cursor: reportingId === session.id ? 'not-allowed' : 'pointer' }}
                  >
                    {reportingId === session.id ? 'REPORTING...' : 'REPORT REQUESTER'}
                  </button>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '8px', fontSize: '12px', color: 'var(--muted)' }}>
                  <div>Traffic: {formatBytes(Number(session.bytes_used ?? 0))}</div>
                  <div>Started: {new Date(session.started_at).toLocaleString()}</div>
                  <div>Ended: {session.ended_at ? new Date(session.ended_at).toLocaleString() : 'Active'}</div>
                  <div>Disconnect: {session.disconnect_reason ?? '-'}</div>
                </div>
                {session.target_hosts.length > 0 ? (
                  <div style={{ display: 'grid', gap: '8px' }}>
                    <div style={{ fontSize: '12px', color: 'var(--muted)', lineHeight: 1.7 }}>
                      Hosts: {visibleHosts.join(', ')}
                      {!expanded && session.target_hosts.length > 3 ? `, +${session.target_hosts.length - 3} more` : ''}
                    </div>
                    {session.target_hosts.length > 3 ? (
                      <button
                        onClick={() => setExpandedHosts((current) => ({ ...current, [session.id]: !current[session.id] }))}
                        style={{ justifySelf: 'flex-start', padding: '8px 11px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontFamily: 'var(--font-geist-mono)', fontSize: '10px', cursor: 'pointer' }}
                      >
                        {expanded ? 'READ LESS' : 'READ MORE'}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      </div>
    </main>
  )
}
