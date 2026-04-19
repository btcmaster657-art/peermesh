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
  private pc: RTCPeerConnection | null = null
  private channel: RTCDataChannel | null = null
  private pending = new Map<string, (r: ProxyResponse) => void>()
  private onDisconnect?: () => void
  private agentMode = false
  private agentSessionId = ''
  sessionInfo: SessionInfo | null = null

  async connect(
    relayEndpoint: string,
    dbSessionId: string,
    country: string,
    userId: string,
    onDisconnect?: () => void,
    preferredProviderUserId?: string | null
  ): Promise<void> {
    this.onDisconnect = onDisconnect

    return new Promise((resolve, reject) => {
      console.log('[requester] connecting to relay:', relayEndpoint)
      this.ws = new WebSocket(relayEndpoint)

      this.ws.onopen = () => {
        console.log('[requester] relay connected, requesting session')
        this.ws!.send(JSON.stringify({
          type: 'request_session',
          country,
          userId,
          requireTunnel: false,
          dbSessionId,
          preferredProviderUserId: preferredProviderUserId ?? null,
        }))
      }

      this.ws.onmessage = async (event) => {
        const msg = JSON.parse(event.data)
        console.log('[requester] received:', msg.type)

        if (msg.type === 'session_created') {
          this.sessionInfo = { sessionId: msg.sessionId, country, relayEndpoint }
        }

        if (msg.type === 'agent_session_ready') {
          // Agent mode — no WebRTC needed, relay forwards requests directly
          this.agentMode = true
          this.agentSessionId = msg.sessionId
          console.log('[requester] agent mode — session ready')
          resolve()
        }

        if (msg.type === 'proxy_response') {
          // Agent sent response back through relay
          const response = msg.response
          const cb = this.pending.get(response.requestId)
          if (cb) {
            cb(response)
            this.pending.delete(response.requestId)
          }
        }

        if (msg.type === 'session_offer') {
          console.log('[requester] got offer, setting up WebRTC')
          try {
            await this.setupWebRTC(msg.offer, msg.sessionId, resolve, reject)
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)))
          }
        }

        if (msg.type === 'error') {
          reject(new Error(msg.message))
        }

        if (msg.type === 'webrtc_ice') {
          if (this.pc && this.pc.remoteDescription) {
            await this.pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(() => {})
          }
        }

        if (msg.type === 'session_ended') {
          this.onDisconnect?.()
        }
      }

      this.ws.onerror = (e) => {
        console.error('[requester] WebSocket error', e)
        reject(new Error('WebSocket connection failed'))
      }

      this.ws.onclose = () => {
        console.log('[requester] relay disconnected')
        if (this.sessionInfo) this.onDisconnect?.()
      }
      // Timeout if no agent_session_ready within 20s
      setTimeout(() => {
        if (!this.agentMode && !this.channel) {
          this.ws?.close()
          reject(new Error('No peer available in ' + country + ' — try another country'))
        }
      }, 20_000)
    })
  }

  private async setupWebRTC(
    offer: RTCSessionDescriptionInit,
    sessionId: string,
    resolve: () => void,
    reject: (e: Error) => void
  ) {
    this.pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ],
    })

    this.pc.onconnectionstatechange = () => {
      console.log('[requester] connection state:', this.pc?.connectionState)
      if (this.pc?.connectionState === 'failed') {
        reject(new Error('WebRTC connection failed'))
      }
    }

    this.pc.oniceconnectionstatechange = () => {
      console.log('[requester] ICE state:', this.pc?.iceConnectionState)
    }

    this.pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.ws?.send(JSON.stringify({
          type: 'webrtc_ice',
          sessionId,
          candidate: e.candidate,
        }))
      }
    }

    // Provider creates the data channel — we receive it via ondatachannel
    this.pc.ondatachannel = (e) => {
      console.log('[requester] data channel received:', e.channel.label, 'state:', e.channel.readyState)
      this.channel = e.channel

      if (e.channel.readyState === 'open') {
        console.log('[requester] data channel already open')
        resolve()
      }

      this.channel.onopen = () => {
        console.log('[requester] data channel opened')
        resolve()
      }

      this.channel.onclose = () => {
        console.log('[requester] data channel closed')
        this.onDisconnect?.()
      }

      this.channel.onerror = (err) => {
        console.error('[requester] data channel error', err)
      }

      this.channel.onmessage = (ev) => {
        const response: ProxyResponse = JSON.parse(ev.data)
        const cb = this.pending.get(response.requestId)
        if (cb) {
          cb(response)
          this.pending.delete(response.requestId)
        }
      }
    }

    await this.pc.setRemoteDescription(new RTCSessionDescription(offer))
    console.log('[requester] remote description set, creating answer')

    const answer = await this.pc.createAnswer()
    await this.pc.setLocalDescription(answer)
    console.log('[requester] local description set, sending answer')

    this.ws?.send(JSON.stringify({
      type: 'webrtc_answer',
      sessionId,
      answer: this.pc.localDescription,
    }))

    // Timeout if data channel never opens
    setTimeout(() => {
      if (!this.isConnected) {
        console.error('[requester] timeout — data channel never opened')
        reject(new Error('Peer connection timed out'))
      }
    }, 20_000)
  }

  async fetch(url: string, options: RequestInit = {}): Promise<ProxyResponse> {
    const requestId = crypto.randomUUID()

    // Agent mode — send request through relay to native agent
    if (this.agentMode && this.ws?.readyState === WebSocket.OPEN) {
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

    // WebRTC mode — send through data channel
    if (!this.channel || this.channel.readyState !== 'open') {
      throw new Error('No active peer connection')
    }

    return new Promise((resolve) => {
      this.pending.set(requestId, resolve)
      this.channel!.send(JSON.stringify({
        requestId,
        url,
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
        body: options.body ?? null,
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
    this.channel?.close()
    this.pc?.close()
    this.ws?.close()
    this.ws = null
    this.pc = null
    this.channel = null
    this.sessionInfo = null
    this.pending.clear()
  }

  get isConnected(): boolean {
    if (this.agentMode) return this.ws?.readyState === WebSocket.OPEN
    return this.channel?.readyState === 'open'
  }
}
