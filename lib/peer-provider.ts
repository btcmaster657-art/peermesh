export type ProviderStats = {
  activeSessions: number
  bytesServed: number
}

export class PeerProvider {
  private ws: WebSocket | null = null
  private connections = new Map<string, RTCPeerConnection>()
  private channels = new Map<string, RTCDataChannel>()
  private bytesServed = 0
  private onStats?: (stats: ProviderStats) => void
  private accessToken = ''

  async start(
    relayEndpoint: string,
    userId: string,
    country: string,
    trustScore: number,
    accessToken: string,
    onStats?: (stats: ProviderStats) => void
  ): Promise<void> {
    this.onStats = onStats
    this.accessToken = accessToken

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(relayEndpoint)

      this.ws.onopen = () => {
        console.log('[provider] WebSocket open, sending register_provider')
        this.ws!.send(JSON.stringify({ type: 'register_provider', userId, country, trustScore }))
      }

      this.ws.onmessage = async (event) => {
        const msg = JSON.parse(event.data)
        console.log('[provider] received:', msg.type)

        if (msg.type === 'registered') resolve()

        if (msg.type === 'session_request') {
          await this.handleSessionRequest(msg).catch(e =>
            console.error('[provider] session request error:', e)
          )
        }

        if (msg.type === 'webrtc_answer') {
          const pc = this.connections.get(msg.sessionId)
          if (pc && pc.signalingState === 'have-local-offer') {
            await pc.setRemoteDescription(new RTCSessionDescription(msg.answer))
              .catch(e => console.error('[provider] setRemoteDescription error:', e))
          }
        }

        if (msg.type === 'webrtc_ice') {
          const pc = this.connections.get(msg.sessionId)
          if (pc?.remoteDescription) {
            await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(() => {})
          }
        }

        if (msg.type === 'session_ended') this.cleanupSession(msg.sessionId)
        if (msg.type === 'error') console.error('[provider] relay error:', msg.message)
      }

      this.ws.onerror = (e) => {
        console.log('[provider] WebSocket error', e)
        reject(new Error('Failed to connect to relay'))
      }

      this.ws.onclose = (e) => {
        console.log('[provider] WebSocket closed, code:', e.code)
        if (this.ws === null) return
        this.stop()
      }
    })
  }

  private async handleSessionRequest(msg: { sessionId: string; targetHost: string }) {
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ],
    })

    this.connections.set(msg.sessionId, pc)

    const channel = pc.createDataChannel('proxy', { ordered: true })
    this.channels.set(msg.sessionId, channel)

    channel.onopen = () => {
      console.log(`[provider] data channel open for session ${msg.sessionId}`)
      this.emitStats()
    }

    channel.onclose = () => this.cleanupSession(msg.sessionId)

    channel.onmessage = async (e) => {
      const request = JSON.parse(e.data)
      const response = await this.handleProxyRequest(request)
      this.bytesServed += response.body.length
      this.emitStats()
      if (channel.readyState === 'open') {
        channel.send(JSON.stringify(response))
      }
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.ws?.send(JSON.stringify({
          type: 'webrtc_ice',
          sessionId: msg.sessionId,
          candidate: e.candidate,
        }))
      }
    }

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)

    this.ws?.send(JSON.stringify({
      type: 'session_offer',
      sessionId: msg.sessionId,
      offer: pc.localDescription,
    }))

    this.emitStats()
  }

  private async handleProxyRequest(request: {
    requestId: string
    url: string
    method: string
    headers: Record<string, string>
    body: string | null
  }) {
    try {
      const url = new URL(request.url)
      if (!['http:', 'https:'].includes(url.protocol)) {
        return { requestId: request.requestId, status: 403, headers: {}, body: '', error: 'Protocol not allowed' }
      }

      // Route through server-side proxy — no CORS restrictions
      const res = await fetch('/api/proxy-fetch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.accessToken}`,
        },
        body: JSON.stringify({
          url: request.url,
          method: request.method,
          headers: request.headers,
          body: request.body,
        }),
      })

      const data = await res.json()

      if (!res.ok && !data.body) {
        return { requestId: request.requestId, status: data.status ?? 502, headers: {}, body: '', error: data.error }
      }

      return {
        requestId: request.requestId,
        status: data.status ?? res.status,
        headers: data.headers ?? {},
        body: data.body ?? '',
        finalUrl: data.finalUrl,
      }
    } catch (err: unknown) {
      return {
        requestId: request.requestId,
        status: 502,
        headers: {},
        body: '',
        error: err instanceof Error ? err.message : 'Fetch failed',
      }
    }
  }

  private cleanupSession(sessionId: string) {
    this.channels.get(sessionId)?.close()
    this.connections.get(sessionId)?.close()
    this.channels.delete(sessionId)
    this.connections.delete(sessionId)
    this.emitStats()
  }

  private emitStats() {
    this.onStats?.({ activeSessions: this.connections.size, bytesServed: this.bytesServed })
  }

  stop() {
    for (const id of this.connections.keys()) this.cleanupSession(id)
    this.ws?.close()
    this.ws = null
  }

  get isRunning(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }
}
