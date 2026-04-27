'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { formatBytes } from '@/lib/utils'
import { DeveloperActionLink, DeveloperPageHeader, developerCardStyle } from '../ui'

type ApiKeyRecord = {
  id: string
  name: string
  key_prefix: string
  tier: string
  rpm_limit: number
  session_mode: string
  requires_verification: boolean
  is_active: boolean
  last_used_at: string | null
  created_at: string
}

type ApiUsageRecord = {
  id: string
  api_key_id: string
  session_id: string | null
  request_id: string | null
  bandwidth_bytes: number
  rpm_requested: number
  session_mode: string
  duration_minutes: number
  estimated_cost_usd: number
  collected_cost_usd: number
  shortfall_cost_usd: number
  created_at: string
}

const sectionStyle: React.CSSProperties = {
  ...developerCardStyle,
  display: 'grid',
  gap: '12px',
}

export default function KeysPageClient() {
  const supabase = createClient()

  const [keys, setKeys] = useState<ApiKeyRecord[]>([])
  const [usage, setUsage] = useState<ApiUsageRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [createdKey, setCreatedKey] = useState('')
  const [copied, setCopied] = useState(false)

  const [name, setName] = useState('Checkout worker')
  const [tier, setTier] = useState('standard')
  const [rpmLimit, setRpmLimit] = useState(60)
  const [sessionMode, setSessionMode] = useState<'rotating' | 'sticky'>('rotating')

  const getAccessToken = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token ?? null
  }, [supabase])

  const loadData = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const token = await getAccessToken()
      const res = await fetch('/api/billing/api-keys', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not load API keys')
      setKeys(data.keys ?? [])
      setUsage(data.usage ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load API keys')
    } finally {
      setLoading(false)
    }
  }, [getAccessToken])

  async function handleCreateKey() {
    setSaving(true)
    setError('')
    setNotice('')
    setCreatedKey('')
    try {
      const token = await getAccessToken()
      const res = await fetch('/api/billing/api-keys', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          name,
          tier,
          rpmLimit,
          sessionMode,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not create API key')
      setCreatedKey(data.key ?? '')
      setNotice('API key created. Copy it now because PeerMesh only shows the raw key once.')
      await loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create API key')
    } finally {
      setSaving(false)
    }
  }

  async function handleToggleKey(id: string, isActive: boolean) {
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const token = await getAccessToken()
      const res = await fetch('/api/billing/api-keys', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          id,
          isActive: !isActive,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not update API key')
      setNotice(!isActive ? 'API key reactivated.' : 'API key deactivated.')
      await loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update API key')
    } finally {
      setSaving(false)
    }
  }

  async function handleCopyKey() {
    if (!createdKey) return
    try {
      await navigator.clipboard.writeText(createdKey)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {}
  }

  useEffect(() => {
    void loadData()
  }, [loadData])

  return (
    <div style={{ display: 'grid', gap: '16px' }}>
      <DeveloperPageHeader
        eyebrow="KEY CONTROL"
        title="Issue, revoke, and observe API credentials"
        description={
          <>
            Create keys for backend jobs, browser workers, or customer-specific integrations. Each key enforces its own tier, session mode,
            and request-per-minute cap at the API edge.
          </>
        }
        actions={
          <>
            <DeveloperActionLink href="/developers/api-docs" label="API Docs" />
            <DeveloperActionLink href="/developers/billing" label="Open Billing" />
          </>
        }
      />

      {error ? (
        <div style={{ ...sectionStyle, borderColor: 'rgba(255,96,96,0.35)', background: 'rgba(255,96,96,0.08)', color: '#ff8080', fontSize: '13px' }}>
          {error}
        </div>
      ) : null}

      {notice ? (
        <div style={{ ...sectionStyle, borderColor: 'rgba(0,255,136,0.35)', background: 'rgba(0,255,136,0.08)', color: 'var(--accent)', fontSize: '13px' }}>
          {notice}
        </div>
      ) : null}

      {createdKey ? (
        <div style={{ ...sectionStyle, borderColor: 'rgba(0,255,136,0.24)' }}>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--accent)', letterSpacing: '1px' }}>NEW RAW KEY</div>
          <div style={{ padding: '12px', borderRadius: '10px', background: 'var(--bg)', border: '1px solid rgba(255,255,255,0.05)', fontFamily: 'var(--font-geist-mono)', fontSize: '12px', overflowX: 'auto' }}>
            {createdKey}
          </div>
          <button
            onClick={() => void handleCopyKey()}
            style={{ padding: '10px 14px', borderRadius: '8px', border: 'none', background: 'var(--accent)', color: '#000', fontFamily: 'var(--font-geist-mono)', fontWeight: 700, cursor: 'pointer' }}
          >
            {copied ? 'COPIED' : 'COPY KEY'}
          </button>
        </div>
      ) : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 0.95fr) minmax(0, 1.05fr)', gap: '16px' }}>
        <div style={sectionStyle}>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--accent)', letterSpacing: '1px' }}>CREATE KEY</div>
          <div style={{ display: 'grid', gap: '10px' }}>
            <label style={{ fontSize: '12px', color: 'var(--muted)' }}>
              Key name
              <input value={name} onChange={(event) => setName(event.target.value)} style={{ width: '100%', marginTop: '6px', padding: '10px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }} />
            </label>
            <label style={{ fontSize: '12px', color: 'var(--muted)' }}>
              Tier
              <select value={tier} onChange={(event) => setTier(event.target.value)} style={{ width: '100%', marginTop: '6px', padding: '10px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }}>
                <option value="standard">Standard</option>
                <option value="advanced">Advanced</option>
                <option value="enterprise">Enterprise</option>
                <option value="contributor">Contributor</option>
              </select>
            </label>
            <label style={{ fontSize: '12px', color: 'var(--muted)' }}>
              RPM limit
              <input type="number" min={1} max={2400} step={1} value={rpmLimit} onChange={(event) => setRpmLimit(Number(event.target.value) || 60)} style={{ width: '100%', marginTop: '6px', padding: '10px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }} />
            </label>
            <label style={{ fontSize: '12px', color: 'var(--muted)' }}>
              Session mode
              <select value={sessionMode} onChange={(event) => setSessionMode(event.target.value === 'sticky' ? 'sticky' : 'rotating')} style={{ width: '100%', marginTop: '6px', padding: '10px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }}>
                <option value="rotating">Rotating</option>
                <option value="sticky">Sticky</option>
              </select>
            </label>
            <button
              onClick={handleCreateKey}
              disabled={saving}
              style={{ padding: '12px 14px', borderRadius: '8px', border: 'none', background: 'var(--accent)', color: '#000', fontFamily: 'var(--font-geist-mono)', fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1 }}
            >
              {saving ? 'CREATING...' : 'CREATE API KEY'}
            </button>
          </div>
        </div>

        <div style={sectionStyle}>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--accent)', letterSpacing: '1px' }}>KEY GUIDANCE</div>
          <div style={{ display: 'grid', gap: '8px', fontSize: '13px', color: 'var(--muted)', lineHeight: 1.8 }}>
            <div><strong style={{ color: 'var(--text)' }}>Standard</strong> keeps routing simple with rotating sessions only.</div>
            <div><strong style={{ color: 'var(--text)' }}>Advanced</strong> and <strong style={{ color: 'var(--text)' }}>Enterprise</strong> support sticky sessions, but verified accounts are required for sticky activation.</div>
            <div><strong style={{ color: 'var(--text)' }}>Contributor</strong> is reserved for accounts that can provide capacity back to the network.</div>
            <div>Deactivate a key instead of deleting credentials from downstream systems blindly. That gives you an immediate kill switch.</div>
          </div>
        </div>
      </div>

      <div style={sectionStyle}>
        <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--accent)', letterSpacing: '1px' }}>ISSUED KEYS</div>
        {loading ? <div style={{ fontSize: '12px', color: 'var(--muted)' }}>LOADING...</div> : null}
        {!loading && keys.length === 0 ? <div style={{ fontSize: '12px', color: 'var(--muted)' }}>No API keys issued yet.</div> : null}
        {keys.map((key) => (
          <div key={key.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: '12px', alignItems: 'center', padding: '12px 0', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
            <div>
              <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '12px', color: 'var(--text)' }}>{key.name}</div>
              <div style={{ fontSize: '12px', color: 'var(--muted)', marginTop: '4px', lineHeight: 1.7 }}>
                {key.key_prefix}... · {key.tier.toUpperCase()} · {key.session_mode.toUpperCase()} · {key.rpm_limit} RPM
              </div>
              <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '4px' }}>
                Created {new Date(key.created_at).toLocaleString()}
                {key.last_used_at ? ` · Last used ${new Date(key.last_used_at).toLocaleString()}` : ' · Never used'}
              </div>
            </div>
            <button
              onClick={() => void handleToggleKey(key.id, key.is_active)}
              disabled={saving}
              style={{
                padding: '10px 12px',
                borderRadius: '8px',
                border: `1px solid ${key.is_active ? 'rgba(255,96,96,0.35)' : 'rgba(0,255,136,0.35)'}`,
                background: key.is_active ? 'rgba(255,96,96,0.08)' : 'rgba(0,255,136,0.08)',
                color: key.is_active ? '#ff8080' : 'var(--accent)',
                fontFamily: 'var(--font-geist-mono)',
                fontSize: '11px',
                cursor: saving ? 'not-allowed' : 'pointer',
              }}
            >
              {key.is_active ? 'DEACTIVATE' : 'REACTIVATE'}
            </button>
          </div>
        ))}
      </div>

      <div style={sectionStyle}>
        <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--accent)', letterSpacing: '1px' }}>RECENT API USAGE</div>
        {usage.length === 0 ? <div style={{ fontSize: '12px', color: 'var(--muted)' }}>No API-key usage recorded yet.</div> : null}
        {usage.map((row) => (
          <div key={row.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: '12px', padding: '12px 0', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
            <div>
              <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '12px', color: 'var(--text)' }}>
                {row.request_id ?? row.session_id ?? row.api_key_id}
              </div>
              <div style={{ fontSize: '12px', color: 'var(--muted)', marginTop: '4px', lineHeight: 1.7 }}>
                {formatBytes(Number(row.bandwidth_bytes ?? 0))} · {row.rpm_requested} RPM · {row.session_mode.toUpperCase()} · {row.duration_minutes} min
              </div>
              <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '4px' }}>
                {new Date(row.created_at).toLocaleString()}
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '12px', color: 'var(--text)' }}>
                ${Number(row.collected_cost_usd ?? 0).toFixed(2)}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '4px' }}>
                est. ${Number(row.estimated_cost_usd ?? 0).toFixed(2)}
                {Number(row.shortfall_cost_usd ?? 0) > 0 ? ` · shortfall $${Number(row.shortfall_cost_usd ?? 0).toFixed(2)}` : ''}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
