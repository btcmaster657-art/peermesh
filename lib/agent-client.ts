const AGENT_URL = 'http://localhost:7654'

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
  source?: 'desktop' | 'cli'
  stats?: AgentHealth['stats']
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

/** Check if the desktop app is running via its control server */
export async function checkDesktop(): Promise<DesktopState> {
  try {
    const res = await fetch(`${AGENT_URL}/native/state`, { signal: AbortSignal.timeout(1500) })
    if (!res.ok) return { available: false, running: false, shareEnabled: false, configured: false, country: null, userId: null, version: null }
    return { available: true, ...(await res.json()) }
  } catch {
    return { available: false, running: false, shareEnabled: false, configured: false, country: null, userId: null, version: null }
  }
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
  try {
    const res = await fetch(`${AGENT_URL}/native/share/stop`, {
      method: 'POST',
      signal: AbortSignal.timeout(4000),
    })
    return res.ok
  } catch {
    return false
  }
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
