import { WebSocketServer, WebSocket } from 'ws'
import { createServer } from 'http'
import { randomUUID } from 'crypto'

const PORT = parseInt(process.env.PORT ?? '8080')
const API_BASE = process.env.API_BASE ?? 'https://peermesh-beta.vercel.app'
const RELAY_SECRET = process.env.RELAY_SECRET ?? ''

const peers = new Map()
const sessions = new Map()
const proxyClients = new Map()

// peerAffinity: requesterUserId → Map(country → providerUserId)
// In-memory cache — seeded from DB via request_session msg, updated on session end.
// Survives within a relay process lifetime. DB is the persistent source of truth.
const peerAffinity = new Map()

const MAX_RECONNECT_ATTEMPTS = 3

function log(tag, msg, extra = '') {
  const ts = new Date().toISOString().slice(11, 23)
  console.log(`[${ts}] [${tag}] ${msg}${extra ? ' | ' + extra : ''}`)
}

function logErr(tag, msg, err) {
  const ts = new Date().toISOString().slice(11, 23)
  console.error(`[${ts}] [${tag}] ERROR ${msg} | ${err?.message ?? err}`)
}

function peersSnapshot() {
  const all = [...peers.values()]
  const providers = all.filter(p => p.role === 'provider')
  const requesters = all.filter(p => p.role === 'requester')
  return `total=${all.length} providers=${providers.length} requesters=${requesters.length} | providers: [${providers.map(p => `${p.peerId.slice(0,8)} userId=${p.userId?.slice(0,8)} country=${p.country} busy=${!!p.sessionId}`).join(', ')}]`
}

// ── Affinity helpers ──────────────────────────────────────────────────────────

function getAffinity(requesterUserId, country) {
  return peerAffinity.get(requesterUserId)?.get(country) ?? null
}

function setAffinity(requesterUserId, country, providerUserId) {
  if (!requesterUserId || !providerUserId) return
  if (!peerAffinity.has(requesterUserId)) peerAffinity.set(requesterUserId, new Map())
  peerAffinity.get(requesterUserId).set(country, providerUserId)
}

// ── Provider finder — affinity-aware ─────────────────────────────────────────
// preferredUserId: try this provider first (peer affinity)
// excludeUserIds: skip these (e.g. the provider that just dropped)

function findProvider(country, requesterId, requestingUserId, {
  requireTunnel = false,
  preferredUserId = null,
  excludeUserIds = [],
} = {}) {
  const isEligible = (peer) =>
    peer.role === 'provider' &&
    peer.country === country &&
    !peer.sessionId &&
    peer.readyState === WebSocket.OPEN &&
    peer.trustScore >= 30 &&
    peer.peerId !== requesterId &&
    peer.userId !== requestingUserId &&
    !excludeUserIds.includes(peer.userId) &&
    peer.supportsHttp !== false &&
    (!requireTunnel || peer.supportsTunnel)

  // First pass — try preferred provider (affinity)
  if (preferredUserId) {
    for (const [, peer] of peers) {
      if (peer.userId === preferredUserId && isEligible(peer)) {
        log('AFFINITY', `HIT preferred provider userId=${preferredUserId.slice(0,8)} country=${country}`)
        return peer
      }
    }
    log('AFFINITY', `MISS preferred provider userId=${preferredUserId.slice(0,8)} offline/busy — falling back`)
  }

  // Second pass — any eligible provider, sorted by trust score descending
  const eligible = []
  for (const [, peer] of peers) {
    if (isEligible(peer)) eligible.push(peer)
  }
  if (eligible.length === 0) return null
  eligible.sort((a, b) => (b.trustScore ?? 50) - (a.trustScore ?? 50))
  return eligible[0]
}

// ── Create a new relay session between an existing requester WS and a provider ─

function createSession(requesterWs, provider, country, dbSessionId) {
  const sessionId = randomUUID()
  requesterWs.sessionId = sessionId
  provider.sessionId = sessionId
  peers.set(requesterWs.peerId, requesterWs)

  sessions.set(sessionId, {
    requesterId: requesterWs.peerId,
    providerId: provider.peerId,
    country,
    requesterUserId: requesterWs.userId,
    providerUserId: provider.userId,
    startTime: Date.now(),
    bytesRequester: 0,
    bytesProvider: 0,
    dbSessionId: dbSessionId ?? null,
    targetHost: null,
    reconnectAttempts: 0,
  })

  send(provider, { type: 'session_request', sessionId })
  send(requesterWs, { type: 'session_created', sessionId })
  log(requesterWs.peerId.slice(0,8), `SESSION_CREATED id=${sessionId.slice(0,8)} provider=${provider.peerId.slice(0,8)} country=${country}`)
  return sessionId
}

// ── Auto-reconnect — called when provider drops while requester is still live ─

function attemptReconnect(requesterWs, droppedSession) {
  const { country, dbSessionId, reconnectAttempts, providerUserId, requesterUserId } = droppedSession

  if ((reconnectAttempts ?? 0) >= MAX_RECONNECT_ATTEMPTS) {
    log(requesterWs.peerId.slice(0,8), `RECONNECT giving up after ${MAX_RECONNECT_ATTEMPTS} attempts`)
    send(requesterWs, { type: 'session_ended', reason: 'no_peers_available' })
    return
  }

  // Exclude the provider that just dropped so we don't reconnect to them immediately
  const excludeUserIds = providerUserId ? [providerUserId] : []
  const preferred = getAffinity(requesterUserId, country)
  // Don't prefer the one that just dropped
  const preferredUserId = preferred === providerUserId ? null : preferred

  const nextProvider = findProvider(country, requesterWs.peerId, requesterUserId, {
    excludeUserIds,
    preferredUserId,
  })

  if (!nextProvider) {
    log(requesterWs.peerId.slice(0,8), `RECONNECT no provider available in ${country} attempt=${reconnectAttempts + 1}/${MAX_RECONNECT_ATTEMPTS}`)
    // Retry after 2s
    setTimeout(() => {
      if (requesterWs.readyState !== WebSocket.OPEN || requesterWs.sessionId) return
      attemptReconnect(requesterWs, { ...droppedSession, reconnectAttempts: (reconnectAttempts ?? 0) + 1 })
    }, 2000)
    return
  }

  log(requesterWs.peerId.slice(0,8), `RECONNECT found new provider=${nextProvider.peerId.slice(0,8)} userId=${nextProvider.userId?.slice(0,8)} attempt=${(reconnectAttempts ?? 0) + 1}`)

  const newSessionId = createSession(requesterWs, nextProvider, country, dbSessionId)

  // Tell requester a reconnect happened so extension/desktop can update proxySession
  send(requesterWs, {
    type: 'session_reconnected',
    sessionId: newSessionId,
    country,
    attempt: (reconnectAttempts ?? 0) + 1,
  })
}

const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', peers: peers.size, sessions: sessions.size }))
    return
  }
  res.writeHead(404)
  res.end()
})

const wss = new WebSocketServer({ noServer: true })
const proxyWss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname === '/proxy') {
    proxyWss.handleUpgrade(req, socket, head, (ws) => proxyWss.emit('connection', ws, req))
  } else {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  }
})

proxyWss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost')
  const sessionId = url.searchParams.get('session')
  const clientIp = req.headers['x-forwarded-for'] ?? req.socket.remoteAddress

  if (!sessionId) { ws.close(1008, 'Missing session'); return }

  const session = sessions.get(sessionId)
  if (!session) { ws.close(1008, 'Invalid session'); return }

  const provider = peers.get(session.providerId)
  if (!provider || provider.readyState !== WebSocket.OPEN) {
    ws.close(1008, 'Provider not available')
    return
  }

  const tunnelId = randomUUID()
  log('PROXY', `WS_OPEN session=${sessionId.slice(0,8)} tunnelId=${tunnelId.slice(0,8)} from ${clientIp}`)
  proxyClients.set(tunnelId, ws)

  let tunnelOpen = false

  ws.on('message', (data) => {
    if (!tunnelOpen) {
      const text = Buffer.isBuffer(data) ? data.toString() : data
      const match = text.match(/^CONNECT ([^\s]+) HTTP/)
      if (match) {
        const [hostname, portStr] = match[1].split(':')
        const port = parseInt(portStr) || 443
        tunnelOpen = true
        send(provider, { type: 'open_tunnel', tunnelId, sessionId, hostname, port })
        const sess = sessions.get(sessionId)
        if (sess && !sess.targetHost) sess.targetHost = hostname
        return
      }
      return
    }
    if (provider.readyState === WebSocket.OPEN) {
      const b64 = Buffer.isBuffer(data) ? data.toString('base64') : Buffer.from(data).toString('base64')
      send(provider, { type: 'tunnel_data', tunnelId, data: b64 })
    }
  })

  ws.on('close', () => {
    proxyClients.delete(tunnelId)
    send(provider, { type: 'tunnel_close', tunnelId })
  })

  ws.on('error', (err) => {
    logErr('PROXY', `tunnelId=${tunnelId.slice(0,8)}`, err)
    proxyClients.delete(tunnelId)
  })
})

wss.on('connection', (ws, req) => {
  const peerId = randomUUID()
  const clientIp = req.headers['x-forwarded-for'] ?? req.socket.remoteAddress

  Object.assign(ws, {
    peerId, role: null, country: null, userId: null,
    trustScore: 50, sessionId: null, providerKind: 'unknown',
    supportsHttp: true, supportsTunnel: false,
    bytesTransferred: 0, isAlive: true,
    clientIp: req.headers['fly-client-ip'] || (req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress || null,
  })

  log(peerId.slice(0,8), `CONNECTED from ${clientIp}`)
  send(ws, { type: 'connected', peerId })

  ws.on('pong', () => { ws.isAlive = true })

  ws.on('message', (data) => {
    try {
      ws.bytesTransferred += data.length
      if (ws.bytesTransferred > 1_073_741_824) {
        send(ws, { type: 'error', message: 'Byte limit reached' })
        ws.terminate()
        return
      }
      const msg = JSON.parse(data.toString())
      if (msg.type !== 'ping') log(peerId.slice(0,8), `MSG_IN type=${msg.type}`, msg.userId ? `userId=${msg.userId.slice(0,8)}` : '')
      handleMessage(ws, msg)
    } catch (e) {
      log(peerId.slice(0,8), `PARSE_ERROR ${e.message}`)
    }
  })

  ws.on('close', (code, reason) => {
    log(peerId.slice(0,8), `DISCONNECTED code=${code} role=${ws.role} userId=${ws.userId?.slice(0,8)}`)
    peers.delete(peerId)
    cleanupSession(ws)
    if (ws.role === 'provider' && ws.userId && API_BASE) {
      fetch(`${API_BASE}/api/user/sharing`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'x-relay-secret': RELAY_SECRET },
        body: JSON.stringify({ device_id: `relay_${peerId.slice(0,8)}`, user_id: ws.userId }),
      }).catch(() => {})
    }
    log(peerId.slice(0,8), `PEERS AFTER DISCONNECT`, peersSnapshot())
  })

  ws.on('error', (err) => log(peerId.slice(0,8), `SOCKET_ERROR ${err.message}`))
})

function handleMessage(ws, msg) {
  switch (msg.type) {

    case 'register_provider': {
      log(ws.peerId.slice(0,8), `REGISTER_PROVIDER userId=${msg.userId?.slice(0,8)} country=${msg.country}`)
      for (const [id, peer] of peers) {
        if (peer.userId === msg.userId && peer.role === 'provider' && id !== ws.peerId) {
          if (peer.sessionId) {
            const oldSession = sessions.get(peer.sessionId)
            if (oldSession) { oldSession.providerId = ws.peerId; ws.sessionId = peer.sessionId }
          }
          send(peer, { type: 'error', message: 'Replaced by new connection' })
          peer.terminate()
          peers.delete(id)
        }
      }
      ws.role = 'provider'
      ws.country = msg.country
      ws.userId = msg.userId
      ws.trustScore = msg.trustScore ?? 50
      ws.agentMode = msg.agentMode ?? false
      ws.providerKind = msg.providerKind ?? 'unknown'
      ws.supportsHttp = msg.supportsHttp ?? true
      ws.supportsTunnel = msg.supportsTunnel ?? false
      peers.set(ws.peerId, ws)
      send(ws, { type: 'registered', peerId: ws.peerId })
      log(ws.peerId.slice(0,8), `REGISTERED_PROVIDER country=${ws.country} userId=${ws.userId?.slice(0,8)}`)
      log(ws.peerId.slice(0,8), `PEERS AFTER REGISTER`, peersSnapshot())
      if (msg.userId && API_BASE) {
        const headers = { 'Content-Type': 'application/json', 'x-relay-secret': RELAY_SECRET }
        if (ws.clientIp) headers['x-provider-ip'] = ws.clientIp
        fetch(`${API_BASE}/api/user/sharing`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ device_id: `relay_${ws.peerId.slice(0,8)}`, user_id: msg.userId }),
        }).catch(() => {})
      }
      break
    }

    case 'request_session': {
      const requireTunnel = !!msg.requireTunnel
      log(ws.peerId.slice(0,8), `REQUEST_SESSION country=${msg.country} userId=${msg.userId?.slice(0,8)}`)
      log(ws.peerId.slice(0,8), `PEERS AT REQUEST TIME`, peersSnapshot())

      // Seed in-memory affinity from DB value passed by client on connect
      if (msg.preferredProviderUserId && msg.userId && msg.country) {
        setAffinity(msg.userId, msg.country, msg.preferredProviderUserId)
        log('AFFINITY', `SEEDED from DB requester=${msg.userId.slice(0,8)} → provider=${msg.preferredProviderUserId.slice(0,8)} country=${msg.country}`)
      }

      const preferredUserId = getAffinity(msg.userId, msg.country)

      const provider = findProvider(msg.country, ws.peerId, msg.userId, {
        requireTunnel,
        preferredUserId,
      })

      if (!provider) {
        log(ws.peerId.slice(0,8), `NO_PROVIDER_FOUND country=${msg.country}`)
        for (const [, peer] of peers) {
          if (peer.role === 'provider') {
            const reasons = []
            if (peer.country !== msg.country) reasons.push(`wrong_country(${peer.country})`)
            if (peer.sessionId) reasons.push('busy')
            if (peer.readyState !== WebSocket.OPEN) reasons.push(`ws_state=${peer.readyState}`)
            if (peer.trustScore < 30) reasons.push(`low_trust(${peer.trustScore})`)
            if (peer.peerId === ws.peerId) reasons.push('same_peer')
            if (peer.userId === msg.userId) reasons.push('same_user')
            if (peer.supportsHttp === false) reasons.push('no_http')
            if (requireTunnel && !peer.supportsTunnel) reasons.push('no_tunnel')
            log(ws.peerId.slice(0,8), `  PROVIDER_REJECTED ${peer.peerId.slice(0,8)} | ${reasons.join(', ')}`)
          }
        }
        send(ws, { type: 'error', message: `No peers available in ${msg.country}` })
        return
      }

      ws.role = 'requester'
      ws.userId = msg.userId
      peers.set(ws.peerId, ws)

      createSession(ws, provider, msg.country, msg.dbSessionId ?? null)
      break
    }

    case 'agent_ready': {
      const agentSession = sessions.get(msg.sessionId)
      if (!agentSession) break
      const requester = peers.get(agentSession.requesterId)
      if (requester) {
        send(requester, { type: 'agent_session_ready', sessionId: msg.sessionId })
        log(ws.peerId.slice(0,8), `AGENT_READY session=${msg.sessionId.slice(0,8)} → requester notified`)
      }
      agentSession.providerUserId = ws.userId
      if (ws.userId && API_BASE) {
        fetch(`${API_BASE}/api/session/end`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'x-relay-secret': RELAY_SECRET },
          body: JSON.stringify({ sessionId: msg.sessionId, providerUserId: ws.userId }),
        }).catch(() => {})
      }
      break
    }

    case 'proxy_request': {
      const proxySession = sessions.get(msg.sessionId)
      if (!proxySession) return
      const provider = peers.get(proxySession.providerId)
      if (!provider || !provider.agentMode) return
      const reqBytes = JSON.stringify(msg.request ?? {}).length
      proxySession.bytesRequester = (proxySession.bytesRequester ?? 0) + reqBytes
      if (msg.request?.url && !proxySession.targetHost) {
        try { proxySession.targetHost = new URL(msg.request.url).hostname } catch {}
      }
      log(ws.peerId.slice(0,8), `PROXY_REQUEST → provider=${provider.peerId.slice(0,8)} url=${msg.request?.url?.slice(0,60)}`)
      send(provider, { type: 'proxy_request', sessionId: msg.sessionId, request: msg.request })
      break
    }

    case 'proxy_response': {
      const respSession = sessions.get(msg.sessionId)
      if (!respSession) return
      const requester = peers.get(respSession.requesterId)
      if (!requester) return
      const respBytes = msg.response?.body?.length ?? 0
      respSession.bytesRequester = (respSession.bytesRequester ?? 0) + respBytes
      respSession.bytesProvider = (respSession.bytesProvider ?? 0) + respBytes
      send(requester, { type: 'proxy_response', sessionId: msg.sessionId, response: msg.response })
      break
    }

    case 'tunnel_ready': {
      const proxyClient = proxyClients.get(msg.tunnelId)
      if (proxyClient?.readyState === WebSocket.OPEN) {
        proxyClient.send('HTTP/1.1 200 Connection Established\r\n\r\n')
      }
      break
    }

    case 'tunnel_data': {
      const proxyClient = proxyClients.get(msg.tunnelId)
      if (!proxyClient || proxyClient.readyState !== WebSocket.OPEN) return
      const chunk = Buffer.from(msg.data, 'base64')
      const tunnelSession = ws.sessionId ? sessions.get(ws.sessionId) : null
      if (tunnelSession) {
        tunnelSession.bytesProvider = (tunnelSession.bytesProvider ?? 0) + chunk.length
        tunnelSession.bytesRequester = (tunnelSession.bytesRequester ?? 0) + chunk.length
      }
      proxyClient.send(chunk)
      break
    }

    case 'tunnel_close': {
      const proxyClient = proxyClients.get(msg.tunnelId)
      if (proxyClient) { proxyClient.close(); proxyClients.delete(msg.tunnelId) }
      break
    }

    case 'end_session':
      cleanupSession(ws)
      break

    case 'ping':
      ws.isAlive = true
      break

    default:
      log(ws.peerId.slice(0,8), `UNKNOWN_MSG type=${msg.type}`)
  }
}

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data))
}

function reportSessionEnd(session, sessionId) {
  const bytesUsed = session.bytesRequester ?? 0
  const dbSessionId = session.dbSessionId ?? null
  if (!API_BASE || !dbSessionId) return
  fetch(`${API_BASE}/api/session/end`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-relay-secret': RELAY_SECRET },
    body: JSON.stringify({
      sessionId: dbSessionId,
      bytesUsed,
      providerUserId: session.providerUserId ?? null,
      requesterUserId: session.requesterUserId ?? null,
      country: session.country,
      targetHost: session.targetHost ?? null,
    }),
  })
    .then(r => log('RELAY', `SESSION_END_REPORT sessionId=${sessionId.slice(0,8)} status=${r.status} bytes=${bytesUsed}`))
    .catch(err => logErr('RELAY', 'SESSION_END_REPORT failed', err))
}

function cleanupSession(ws) {
  if (!ws.sessionId) return
  const sessionId = ws.sessionId
  const session = sessions.get(sessionId)
  ws.sessionId = null

  if (!session) return

  const otherId = ws.role === 'provider' ? session.requesterId : session.providerId
  const other = peers.get(otherId)

  // Close proxy tunnel clients for this session
  const proxyClient = proxyClients.get(sessionId)
  if (proxyClient) { proxyClient.close(); proxyClients.delete(sessionId) }

  // Save affinity — remember which provider this requester used
  if (session.requesterUserId && session.providerUserId && session.country) {
    setAffinity(session.requesterUserId, session.country, session.providerUserId)
    log('AFFINITY', `SAVED requester=${session.requesterUserId.slice(0,8)} → provider=${session.providerUserId.slice(0,8)} country=${session.country}`)
  }

  reportSessionEnd(session, sessionId)
  sessions.delete(sessionId)
  log(ws.peerId.slice(0,8), `SESSION_CLEANED id=${sessionId.slice(0,8)} bytes=${session.bytesRequester ?? 0}`)

  if (!other) return
  other.sessionId = null

  // Auto-reconnect — only when provider dropped and requester is still connected
  if (ws.role === 'provider' && other.readyState === WebSocket.OPEN) {
    log(other.peerId.slice(0,8), `PROVIDER_DROPPED — attempting auto-reconnect country=${session.country}`)
    attemptReconnect(other, session)
  } else {
    send(other, { type: 'session_ended', reason: 'peer_disconnected' })
  }
}

const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) { ws.terminate(); return }
    ws.isAlive = false
    ws.ping()
  })
}, 30_000)

wss.on('close', () => clearInterval(heartbeat))

server.listen(PORT, () => {
  log('RELAY', `PeerMesh relay on port ${PORT}`)
})
