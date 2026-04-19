export type ProxyResponse = {
  requestId: string
  status: number
  headers: Record<string, string>
  body: string
  error?: string
  finalUrl?: string
}

export type SessionInfo = {
  sessionId: string
  country: string
  relayEndpoint: string
}

export class PeerRequester {
  private ws: WebSocket | null = null
  private pending = new Map<string, (r: ProxyResponse) => void>()
  private onDisconnect?: () => void
  private agentSessionId = ''
  sessionInfo: SessionInfo | null = null

  async connect(
    relayEndpoint: string,
    dbSessionId: string,
    country: string,
    userId: string,
    onDisconnect?: () => void,
    preferredProviderUserId?: string | null,
    privateProviderUserId?: string | null,
    privateBaseDeviceId?: string | null
  ): Promise<void> {
    this.onDisconnect = onDisconnect

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(relayEndpoint)

      this.ws.onopen = () => {
        this.ws!.send(JSON.stringify({
          type: 'request_session',
          country,
          userId,
          requireTunnel: false,
          dbSessionId,
          preferredProviderUserId: preferredProviderUserId ?? null,
          privateProviderUserId: privateProviderUserId ?? null,
          privateBaseDeviceId: privateBaseDeviceId ?? null,
        }))
      }

      this.ws.onmessage = (event) => {
        const msg = JSON.parse(event.data)

        if (msg.type === 'session_created') {
          this.sessionInfo = { sessionId: msg.sessionId, country, relayEndpoint }
        }

        if (msg.type === 'agent_session_ready') {
          this.agentSessionId = msg.sessionId
          resolve()
        }

        if (msg.type === 'proxy_response') {
          const response = msg.response as ProxyResponse
          const cb = this.pending.get(response.requestId)
          if (cb) {
            cb(response)
            this.pending.delete(response.requestId)
          }
        }

        if (msg.type === 'error') {
          reject(new Error(msg.message))
        }

        if (msg.type === 'session_ended') {
          this.onDisconnect?.()
        }
      }

      this.ws.onerror = () => reject(new Error('WebSocket connection failed'))

      this.ws.onclose = () => {
        if (this.sessionInfo) this.onDisconnect?.()
      }

      setTimeout(() => {
        if (!this.agentSessionId) {
          this.ws?.close()
          reject(new Error('No peer available in ' + country + ' — try another country'))
        }
      }, 20_000)
    })
  }

  async fetch(url: string, options: RequestInit = {}): Promise<ProxyResponse> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return { requestId: '', status: 503, headers: {}, body: '', error: 'Not connected to peer' }
    }
    const requestId = crypto.randomUUID()
    return new Promise((resolve) => {
      this.pending.set(requestId, resolve)
      this.ws!.send(JSON.stringify({
        type: 'proxy_request',
        sessionId: this.agentSessionId,
        request: {
          requestId,
          url,
          method: options.method ?? 'GET',
          headers: options.headers ?? {},
          body: options.body ?? null,
        },
      }))
      setTimeout(() => {
        if (this.pending.has(requestId)) {
          this.pending.delete(requestId)
          resolve({ requestId, status: 504, headers: {}, body: '', error: 'Request timed out' })
        }
      }, 30_000)
    })
  }

  disconnect() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'end_session' }))
    }
    this.ws?.close()
    this.ws = null
    this.sessionInfo = null
    this.pending.clear()
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && !!this.agentSessionId
  }
}
