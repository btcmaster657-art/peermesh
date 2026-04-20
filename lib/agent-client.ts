const AGENT_URL = 'http://localhost:7654'
const PEER_URL  = 'http://localhost:7656'

export type AgentHealth = {
  running: boolean
  country: string
  userId: string
  stats: {
    bytesServed: number
    requestsHandled: number
    connectedAt: string | null
    peerId: string | null
  }
  version: string
}

export type DesktopState = {
  available: boolean
  running: boolean
  shareEnabled: boolean
  configured: boolean
  country: string | null
  userId: string | null
  version: string | null
  where?: 'desktop' | 'cli'
  source?: 'desktop' | 'cli'  // legacy compat
  baseDeviceId?: string | null
  connectionSlots?: number
  privateShareActive?: boolean
  privateShare?: {
    base_device_id: string
    code: string
    enabled: boolean
    expires_at: string | null
    active: boolean
  } | null
  slots?: {
    configured: number
    active: number
    statuses: Array<{
      index: number
      deviceId: string
      running: boolean
      requestsHandled: number
      bytesServed: number
      connectedAt: string | null
    }>
    warning?: string | null
  }
  stats?: AgentHealth['stats']
  peer?: {                     // the other process if both are running
    available: boolean
    running: boolean
    shareEnabled?: boolean
    where: 'desktop' | 'cli'
    userId?: string | null
    country?: string | null
    version: string | null
    baseDeviceId?: string | null
    privateShareActive?: boolean
    privateShare?: DesktopState['privateShare']
    stats?: AgentHealth['stats'] | null
    slots?: DesktopState['slots'] | null
    connectionSlots?: number | null
  } | null
}

export async function checkAgent(): Promise<AgentHealth | null> {
  try {
    const res = await fetch(`${AGENT_URL}/health`, { signal: AbortSignal.timeout(1500) })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

/** Check if the desktop app or CLI is running via its control server.
 *  isSharing = A(7654).running OR B(7656).running */
export async function checkDesktop(): Promise<DesktopState> {
  const notAvailable: DesktopState = { available: false, running: false, shareEnabled: false, configured: false, country: null, userId: null, version: null, peer: null }

  const [aRes, bRes] = await Promise.allSettled([
    fetch(`${AGENT_URL}/native/state`, { signal: AbortSignal.timeout(1500) }),
    fetch(`${PEER_URL}/native/state`,  { signal: AbortSignal.timeout(1000) }),
  ])

  let a: DesktopState | null = null
  let b: DesktopState['peer'] = null

  if (aRes.status === 'fulfilled' && aRes.value.ok) {
    const d = await aRes.value.json()
    a = { available: true, peer: null, ...d }
  }
  if (bRes.status === 'fulfilled' && bRes.value.ok) {
    const d = await bRes.value.json()
    b = {
      available: true,
      running: !!d.running,
      shareEnabled: !!d.shareEnabled,
      where: d.where ?? 'cli',
      version: d.version ?? null,
      userId: d.userId ?? null,
      country: d.country ?? null,
      baseDeviceId: d.baseDeviceId ?? null,
      privateShareActive: !!d.privateShareActive,
      privateShare: d.privateShare ?? null,
      stats: d.stats ?? null,
      slots: d.slots ?? null,
      connectionSlots: d.connectionSlots ?? null,
    }
    // If peer is the active sharer, promote its stats to the top-level
    if (b.running) {
      if (!a) a = { available: false, running: false, shareEnabled: false, configured: false, country: null, userId: null, version: null, peer: null }
      a = {
        ...a,
        where: d.where ?? a.where,
        source: d.source ?? d.where ?? a.source,
        userId: d.userId ?? a.userId,
        country: d.country ?? a.country,
        version: d.version ?? a.version,
        stats: d.stats ?? a.stats,
        slots: d.slots ?? a.slots,
        connectionSlots: d.connectionSlots ?? a.connectionSlots,
        baseDeviceId: d.baseDeviceId ?? a.baseDeviceId,
        privateShareActive: !!(d.privateShareActive ?? a.privateShareActive),
        privateShare: d.privateShare ?? a.privateShare ?? null,
      }
    }
  }

  if (!a) return notAvailable

  const isSharing = !!a.running || !!(b?.running)
  const shareEnabled = !!a.shareEnabled || !!a.running || !!(b?.shareEnabled) || !!(b?.running)
  return { ...a, running: isSharing, shareEnabled, peer: b }
}

async function postConnectionSlots(url: string, slots: number): Promise<boolean> {
  try {
    const res = await fetch(`${url}/native/connection-slots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slots }),
      signal: AbortSignal.timeout(2500),
    })
    return res.ok
  } catch {
    return false
  }
}

export async function setDesktopConnectionSlots(slots: number): Promise<{ ok: boolean; state?: DesktopState; error?: string }> {
  const nextSlots = Math.max(1, Math.min(32, Number.parseInt(String(slots), 10) || 1))
  const [primary, peer] = await Promise.all([
    postConnectionSlots(AGENT_URL, nextSlots),
    postConnectionSlots(PEER_URL, nextSlots),
  ])
  if (!primary && !peer) {
    return { ok: false, error: 'Could not reach desktop or CLI helper' }
  }
  return { ok: true, state: await checkDesktop() }
}

export async function syncDesktopAuth(payload: { token: string; userId: string; country: string; trust: number }): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${AGENT_URL}/native/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(3000),
    })
    if (res.status === 403) {
      const data = await res.json().catch(() => ({}))
      return { ok: false, error: data.error ?? 'This desktop is signed in as a different user' }
    }
    return { ok: res.ok }
  } catch {
    return { ok: false }
  }
}

export async function startDesktopSharing(payload: { token: string; userId: string; country: string; trust: number }): Promise<{ ok: boolean; error?: string; state?: DesktopState }> {
  try {
    const res = await fetch(`${AGENT_URL}/native/share/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(4000),
    })
    if (res.status === 403) {
      const data = await res.json().catch(() => ({}))
      return { ok: false, error: data.error ?? 'This desktop is signed in as a different user' }
    }
    const data = await res.json().catch(() => null)
    return { ok: res.ok, state: res.ok && data ? { available: true, peer: null, ...data } : undefined }
  } catch {
    return { ok: false }
  }
}

export async function stopDesktopSharing(): Promise<{ ok: boolean; state?: DesktopState }> {
  // Stop both the primary process (7654) and the peer process (7656)
  const stopPrimary = fetch(`${AGENT_URL}/native/share/stop`, {
    method: 'POST',
    signal: AbortSignal.timeout(4000),
  }).then(async (r) => {
    const data = await r.json().catch(() => null)
    return { ok: r.ok, state: r.ok && data ? { available: true, peer: null, ...data } : undefined }
  }).catch(() => ({ ok: false as const, state: undefined }))

  const stopPeer = fetch(`${PEER_URL}/native/share/stop`, {
    method: 'POST',
    signal: AbortSignal.timeout(4000),
  }).then(async (r) => {
    const data = await r.json().catch(() => null)
    return { ok: r.ok, state: r.ok && data ? { available: true, peer: null, ...data } : undefined }
  }).catch(() => ({ ok: false as const, state: undefined }))

  const [primary, peer] = await Promise.all([stopPrimary, stopPeer])
  return primary.ok ? primary : peer
}

export async function startAgent(config: {
  relay: string
  apiBase: string
  token: string
  userId: string
  country: string
  trust: number
}): Promise<boolean> {
  try {
    const res = await fetch(`${AGENT_URL}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
      signal: AbortSignal.timeout(3000),
    })
    return res.ok
  } catch {
    return false
  }
}

export async function stopAgent(): Promise<boolean> {
  try {
    const res = await fetch(`${AGENT_URL}/stop`, {
      method: 'POST',
      signal: AbortSignal.timeout(3000),
    })
    return res.ok
  } catch {
    return false
  }
}
