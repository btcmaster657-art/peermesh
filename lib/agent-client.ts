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

export async function checkAgent(): Promise<AgentHealth | null> {
  try {
    const res = await fetch(`${AGENT_URL}/health`, { signal: AbortSignal.timeout(1500) })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
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
