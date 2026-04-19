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
  stats?: AgentHealth['stats']
  peer?: {                     // the other process if both are running
    available: boolean
    running: boolean
    where: 'desktop' | 'cli'
    version: string | null
    stats?: AgentHealth['stats'] | null
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
    b = { available: true, running: !!d.running, where: d.where ?? 'cli', version: d.version ?? null }
    // If peer is the active sharer, promote its stats to the top-level
    if (b.running && d.stats) {
      if (!a) a = { available: false, running: false, shareEnabled: false, configured: false, country: null, userId: null, version: null, peer: null }
      a = { ...a, stats: d.stats }
    }
  }

  if (!a) return notAvailable

  const isSharing = !!a.running || !!(b?.running)
  return { ...a, running: isSharing, shareEnabled: isSharing, peer: b }
}

/** Push auth credentials to the running desktop app */
export async function syncDesktopAuth(payload: { token: string; userId: string; country: string; trust: number }): Promise<boolean> {
  try {
    const res = await fetch(`${AGENT_URL}/native/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(3000),
    })
    return res.ok
  } catch {
    return false
  }
}

export async function startDesktopSharing(payload: { token: string; userId: string; country: string; trust: number }): Promise<boolean> {
  try {
    const res = await fetch(`${AGENT_URL}/native/share/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(4000),
    })
    return res.ok
  } catch {
    return false
  }
}

export async function stopDesktopSharing(): Promise<boolean> {
  // Stop both the primary process (7654) and the peer process (7656)
  const stopPrimary = fetch(`${AGENT_URL}/native/share/stop`, {
    method: 'POST',
    signal: AbortSignal.timeout(4000),
  }).then(r => r.ok).catch(() => false)

  const stopPeer = fetch(`${PEER_URL}/native/share/stop`, {
    method: 'POST',
    signal: AbortSignal.timeout(4000),
  }).then(r => r.ok).catch(() => false)

  const [primary] = await Promise.all([stopPrimary, stopPeer])
  return primary
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
