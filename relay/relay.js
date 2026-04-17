import { WebSocketServer, WebSocket } from 'ws'
import { createServer } from 'http'
import { connect as netConnect } from 'net'
import { randomUUID } from 'crypto'

const PORT = parseInt(process.env.PORT ?? '8080')
const PROXY_PORT = parseInt(process.env.PROXY_PORT ?? '8081')
const API_BASE = process.env.API_BASE ?? 'https://peermesh-beta.vercel.app'
const RELAY_SECRET = process.env.RELAY_SECRET ?? ''

const peers = new Map()
const sessions = new Map()

const BLOCKED_PATTERNS = [/torrent/i, /\.onion$/, /^smtp\./i, /^mail\./i, /^pop3\./i, /^imap\./i]
const ALLOWED_PORTS = new Set([80, 443, 8080, 8443])

function log(tag, msg, extra = '') {
  const ts = new Date().toISOString().slice(11, 23)
  console.log(`[${ts}] [${tag}] ${msg}${extra ? ' | ' + extra : ''}`)
}

function peersSnapshot() {
  const all = [...peers.values()]
  const providers = all.filter(p => p.role === 'provider')
  const requesters = all.filter(p => p.role === 'requester')
  return `total=${all.length} providers=${providers.length} requesters=${requesters.length} | providers: [${providers.map(p => `${p.peerId.slice(0,8)} userId=${p.userId?.slice(0,8)} country=${p.country} busy=${!!p.sessionId}`).join(', ')}]`
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

const wss = new WebSocketServer({ server })

wss.on('connection', (ws, req) => {
  const peerId = randomUUID()
  const clientIp = req.headers['x-forwarded-for'] ?? req.socket.remoteAddress

  const socket = Object.assign(ws, {
    peerId,
    role: null,
    country: null,
    userId: null,
    trustScore: 50,
    sessionId: null,
    providerKind: 'unknown',
    supportsHttp: true,
    supportsTunnel: false,
    bytesTransferred: 0,
    isAlive: true,
  })

  log(peerId.slice(0,8), `CONNECTED from ${clientIp}`)
  log(peerId.slice(0,8), `PEERS AFTER CONNECT`, peersSnapshot())
  send(socket, { type: 'connected', peerId })

  socket.on('pong', () => { socket.isAlive = true })

  socket.on('message', (data) => {
    try {
      socket.bytesTransferred += data.length
      if (socket.bytesTransferred > 1_073_741_824) {
        send(socket, { type: 'error', message: 'Byte limit reached' })
        socket.terminate()
        return
      }
      const msg = JSON.parse(data.toString())
      log(peerId.slice(0,8), `MSG_IN type=${msg.type}`, msg.userId ? `userId=${msg.userId.slice(0,8)}` : '')
      handleMessage(socket, msg)
    } catch (e) {
      log(peerId.slice(0,8), `PARSE_ERROR ${e.message}`)
    }
  })

  socket.on('close', (code, reason) => {
    log(peerId.slice(0,8), `DISCONNECTED code=${code} reason=${reason?.toString() || 'none'} role=${socket.role} userId=${socket.userId?.slice(0,8)}`)
    peers.delete(peerId)
    cleanupSession(socket)
    log(peerId.slice(0,8), `PEERS AFTER DISCONNECT`, peersSnapshot())
  })

  socket.on('error', (err) => {
    log(peerId.slice(0,8), `SOCKET_ERROR ${err.message}`)
  })
})

function handleMessage(ws, msg) {
  switch (msg.type) {

    case 'register_provider': {
      // Evict any existing provider with the same userId to prevent accumulation
      for (const [id, peer] of peers) {
        if (peer.userId === msg.userId && peer.role === 'provider' && id !== ws.peerId) {
          log(id.slice(0,8), `EVICTING duplicate provider userId=${msg.userId?.slice(0,8)}`)
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
      log(
        ws.peerId.slice(0,8),
        `REGISTERED_PROVIDER country=${ws.country} userId=${ws.userId?.slice(0,8)} trust=${ws.trustScore} agent=${ws.agentMode}`,
        `kind=${ws.providerKind} http=${ws.supportsHttp} tunnel=${ws.supportsTunnel}`,
      )
      log(ws.peerId.slice(0,8), `PEERS AFTER REGISTER`, peersSnapshot())
      break
    }

    case 'request_session': {
      const requireTunnel = !!msg.requireTunnel
      log(
        ws.peerId.slice(0,8),
        `REQUEST_SESSION country=${msg.country} userId=${msg.userId?.slice(0,8)}`,
        `requireTunnel=${requireTunnel}`,
      )
      log(ws.peerId.slice(0,8), `PEERS AT REQUEST TIME`, peersSnapshot())

      const provider = findProvider(msg.country, ws.peerId, msg.userId, { requireTunnel })

      if (!provider) {
        log(ws.peerId.slice(0,8), `NO_PROVIDER_FOUND for country=${msg.country}`)
        // Log why each provider was rejected
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
            log(ws.peerId.slice(0,8), `  PROVIDER_REJECTED ${peer.peerId.slice(0,8)} userId=${peer.userId?.slice(0,8)}`, reasons.join(', '))
          }
        }
        send(ws, { type: 'error', message: requireTunnel
          ? `No full-browser peers available in ${msg.country}`
          : `No peers available in ${msg.country}` })
        return
      }

      const sessionId = randomUUID()
      ws.role = 'requester'
      ws.sessionId = sessionId
      ws.userId = msg.userId
      provider.sessionId = sessionId
      peers.set(ws.peerId, ws)  // requester must be in peers map to receive the offer

      sessions.set(sessionId, {
        requesterId: ws.peerId,
        providerId: provider.peerId,
        country: msg.country,
        startTime: Date.now(),
      })

      log(ws.peerId.slice(0,8), `SESSION_CREATED id=${sessionId.slice(0,8)} requester=${ws.peerId.slice(0,8)} provider=${provider.peerId.slice(0,8)} country=${msg.country}`)

      send(provider, { type: 'session_request', sessionId, targetHost: msg.targetHost ?? '', targetPort: msg.targetPort ?? 443 })
      send(ws, { type: 'session_created', sessionId })
      break
    }

    case 'session_offer': {
      const session = sessions.get(msg.sessionId)
      if (!session) { log(ws.peerId.slice(0,8), `SESSION_OFFER_NO_SESSION id=${msg.sessionId?.slice(0,8)}`); return }
      const requester = peers.get(session.requesterId)
      if (requester) {
        log(ws.peerId.slice(0,8), `FORWARDING_OFFER to requester=${session.requesterId.slice(0,8)}`)
        send(requester, { type: 'session_offer', sessionId: msg.sessionId, offer: msg.offer })
      } else {
        log(ws.peerId.slice(0,8), `OFFER_REQUESTER_GONE id=${session.requesterId.slice(0,8)}`)
      }
      break
    }

    case 'webrtc_answer': {
      const session = sessions.get(msg.sessionId)
      if (!session) { log(ws.peerId.slice(0,8), `ANSWER_NO_SESSION`); return }
      const provider = peers.get(session.providerId)
      if (provider) {
        log(ws.peerId.slice(0,8), `FORWARDING_ANSWER to provider=${session.providerId.slice(0,8)}`)
        send(provider, { type: 'webrtc_answer', sessionId: msg.sessionId, answer: msg.answer })
      }
      break
    }

    case 'webrtc_ice': {
      const session = sessions.get(msg.sessionId)
      if (!session) return
      const targetId = ws.role === 'requester' ? session.providerId : session.requesterId
      const target = peers.get(targetId)
      if (target) {
        send(target, { type: 'webrtc_ice', sessionId: msg.sessionId, candidate: msg.candidate })
      }
      break
    }

    case 'agent_ready': {
      // Agent acknowledged session — tell requester session is active
      const agentSession = sessions.get(msg.sessionId)
      if (agentSession) {
        const requester = peers.get(agentSession.requesterId)
        if (requester) send(requester, { type: 'agent_session_ready', sessionId: msg.sessionId })
        // Record provider userId on the session for DB write-back
        agentSession.providerUserId = ws.userId
        log(ws.peerId.slice(0,8), `AGENT_READY session=${msg.sessionId.slice(0,8)} providerUserId=${ws.userId?.slice(0,8)}`)
        // Write provider_id back to DB so bytes can be credited on session end
        if (ws.userId && API_BASE) {
          fetch(`${API_BASE}/api/session/end`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'x-relay-secret': RELAY_SECRET },
            body: JSON.stringify({ sessionId: msg.sessionId, providerUserId: ws.userId }),
          }).catch(() => {})
        }
      }
      break
    }

    case 'proxy_request': {
      // Requester sends fetch request → forward to agent provider
      const proxySession = sessions.get(msg.sessionId)
      if (!proxySession) return
      const provider = peers.get(proxySession.providerId)
      if (provider?.agentMode && provider.supportsHttp !== false) {
        send(provider, { type: 'proxy_request', sessionId: msg.sessionId, request: msg.request })
      }
      break
    }

    case 'proxy_response': {
      handleProxyMessage(ws, msg)
      break
    }

    case 'tunnel_ready':
    case 'tunnel_data':
    case 'tunnel_close': {
      handleProxyMessage(ws, msg)
      break
    }

    case 'end_session': {
      log(ws.peerId.slice(0,8), `END_SESSION role=${ws.role}`)
      cleanupSession(ws)
      break
    }

    case 'ping':
      break // keepalive from extension service worker — ignore silently

    default:
      log(ws.peerId.slice(0,8), `UNKNOWN_MSG type=${msg.type}`)
  }
}

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data))
  }
}

function findProvider(country, requesterId, requestingUserId, { requireTunnel = false } = {}) {
  for (const [, peer] of peers) {
    if (
      peer.role === 'provider' &&
      peer.country === country &&
      !peer.sessionId &&
      peer.readyState === WebSocket.OPEN &&
      peer.trustScore >= 30 &&
      peer.peerId !== requesterId &&
      peer.userId !== requestingUserId &&
      peer.supportsHttp !== false &&
      (!requireTunnel || peer.supportsTunnel)
    ) {
      return peer
    }
  }
  return null
}

function cleanupSession(ws) {
  if (!ws.sessionId) return
  const session = sessions.get(ws.sessionId)
  if (session) {
    const otherId = ws.role === 'provider' ? session.requesterId : session.providerId
    const other = peers.get(otherId)
    if (other) {
      send(other, { type: 'session_ended', reason: 'peer_disconnected' })
      other.sessionId = null  // clear the other peer's busy flag
    }
    sessions.delete(ws.sessionId)
    log(ws.peerId.slice(0,8), `SESSION_CLEANED id=${ws.sessionId.slice(0,8)}`)
  }
  ws.sessionId = null
}

const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    const socket = ws
    if (!socket.isAlive) {
      log(socket.peerId?.slice(0,8), `HEARTBEAT_TIMEOUT terminating`)
      socket.terminate()
      return
    }
    socket.isAlive = false
    socket.ping()
  })
}, 30_000)

wss.on('close', () => clearInterval(heartbeat))

// ── HTTP Proxy server (port 8081) ───────────────────────────────────────────
// Extension points Chrome proxy here. For HTTPS CONNECT tunnels, the relay
// forwards the raw TCP stream through the provider agent's connection.

const proxyPending = new Map() // requestId/tunnelId → pending

// Track HTTP proxy session by IP+port → sessionId
const proxySessionMap = new Map()

const httpProxyServer = createServer((req, res) => {
  // Session ID comes as proxy credentials username (set by extension onAuthRequired)
  const authHeader = req.headers['proxy-authorization'] || ''
  const credSessionId = authHeader.startsWith('Basic ')
    ? Buffer.from(authHeader.slice(6), 'base64').toString().split(':')[0]
    : null
  const sessionId = credSessionId || req.headers['x-peermesh-session'] || proxySessionMap.get(req.socket.remotePort)
  const sessionEntry = sessionId ? sessions.get(sessionId) : null
  const sessionCountry = sessionEntry?.country ?? null

  let provider = sessionEntry ? peers.get(sessionEntry.providerId) : null
  if (!provider || provider.readyState !== WebSocket.OPEN) {
    provider = findAnyAgentProvider(sessionCountry, { requireTunnel: false })
  }

  if (!provider) {
    res.writeHead(503, { 'Content-Type': 'text/plain' })
    res.end('No PeerMesh provider available. Make sure you are connected in the extension.')
    return
  }

  const requestId = randomUUID()
  const chunks = []
  req.on('data', c => chunks.push(c))
  req.on('end', () => {
    const targetUrl = req.url.startsWith('http') ? req.url : `http://${req.headers.host}${req.url}`
    const request = { requestId, url: targetUrl, method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() || null }

    proxyPending.set(requestId, {
      resolve: (data) => {
        const headers = { ...data.headers }
        delete headers['content-encoding']
        delete headers['transfer-encoding']
        res.writeHead(data.status || 200, headers)
        res.end(data.body || '')
      },
      reject: () => { res.writeHead(502); res.end('Bad Gateway') },
    })

    const actualSessionId = sessionId || [...sessions.entries()].find(([, s]) => s.providerId === provider.peerId)?.[0]
    send(provider, { type: 'proxy_request', sessionId: actualSessionId, request })

    setTimeout(() => {
      if (proxyPending.has(requestId)) {
        proxyPending.delete(requestId)
        res.writeHead(504); res.end('Gateway Timeout')
      }
    }, 30000)
  })
})

httpProxyServer.on('connect', (req, clientSocket, head) => {
  // HTTPS CONNECT tunnel — forward raw TCP through provider agent
  const [hostname, portStr] = (req.url || '').split(':')
  const port = parseInt(portStr) || 443

  // Session ID from proxy credentials (Basic auth username = sessionId)
  const authHeader = req.headers['proxy-authorization'] || ''
  const headerSessionId = authHeader.startsWith('Basic ')
    ? Buffer.from(authHeader.slice(6), 'base64').toString().split(':')[0]
    : authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  const connectSessionId = headerSessionId || proxySessionMap.get(clientSocket.remotePort)
  const connectSession = connectSessionId ? sessions.get(connectSessionId) : null
  const connectCountry = connectSession?.country ?? null

  let provider = connectSession ? peers.get(connectSession.providerId) : null
  if (!provider || provider.readyState !== WebSocket.OPEN) {
    provider = findAnyAgentProvider(connectCountry, { requireTunnel: true })
  }
  if (!provider) {
    clientSocket.write('HTTP/1.1 503 No Provider Available\r\n\r\n')
    clientSocket.destroy()
    return
  }

  const tunnelId = randomUUID()
  const actualSessionId = connectSessionId ?? [...sessions.entries()].find(([, s]) => s.providerId === provider.peerId)?.[0]

  // Tell agent to open TCP connection to target and relay data
  send(provider, { type: 'open_tunnel', tunnelId, hostname, port, sessionId: actualSessionId })

  // Store client socket — agent will respond with tunnel_ready
  proxyPending.set(tunnelId, { clientSocket, head })

  setTimeout(() => {
    if (proxyPending.has(tunnelId)) {
      proxyPending.delete(tunnelId)
      clientSocket.write('HTTP/1.1 504 Timeout\r\n\r\n')
      clientSocket.destroy()
    }
  }, 15000)
})

// Handle proxy responses and tunnel data from agents (added to handleMessage)
function handleProxyMessage(ws, msg) {
  if (msg.type === 'proxy_response') {
    // Response to HTTP request
    const pending = proxyPending.get(msg.response?.requestId)
    if (pending?.resolve) {
      pending.resolve(msg.response)
      proxyPending.delete(msg.response.requestId)
    }
    // Also forward to WS requester if exists
    const respSession = sessions.get(msg.sessionId)
    if (respSession) {
      const requester = peers.get(respSession.requesterId)
      if (requester) send(requester, { type: 'proxy_response', sessionId: msg.sessionId, response: msg.response })
    }
  }

  if (msg.type === 'tunnel_ready') {
    // Agent opened TCP connection — now pipe data
    const pending = proxyPending.get(msg.tunnelId)
    if (!pending) return
    proxyPending.delete(msg.tunnelId)

    const { clientSocket, head } = pending
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')

    // Data flows: clientSocket ↔ relay WS ↔ agent WS ↔ target server
    clientSocket.on('data', (data) => {
      send(ws, { type: 'tunnel_data', tunnelId: msg.tunnelId, data: data.toString('base64') })
    })
    clientSocket.on('end', () => send(ws, { type: 'tunnel_close', tunnelId: msg.tunnelId }))
    clientSocket.on('error', () => send(ws, { type: 'tunnel_close', tunnelId: msg.tunnelId }))

    if (head?.length) {
      send(ws, { type: 'tunnel_data', tunnelId: msg.tunnelId, data: head.toString('base64') })
    }

    // Store for incoming data from agent
    proxyPending.set(`socket_${msg.tunnelId}`, clientSocket)
  }

  if (msg.type === 'tunnel_data') {
    const clientSocket = proxyPending.get(`socket_${msg.tunnelId}`)
    if (clientSocket && !clientSocket.destroyed) {
      clientSocket.write(Buffer.from(msg.data, 'base64'))
    }
  }

  if (msg.type === 'tunnel_close') {
    const clientSocket = proxyPending.get(`socket_${msg.tunnelId}`)
    if (clientSocket && !clientSocket.destroyed) clientSocket.destroy()
    proxyPending.delete(`socket_${msg.tunnelId}`)
    proxyPending.delete(msg.tunnelId)
  }
}

function findAnyAgentProvider(country = null, { requireTunnel = false } = {}) {
  for (const [, peer] of peers) {
    if (
      peer.role === 'provider' &&
      peer.agentMode &&
      peer.supportsHttp !== false &&
      (!requireTunnel || peer.supportsTunnel) &&
      peer.readyState === WebSocket.OPEN &&
      (country === null || peer.country === country)
    ) {
      return peer
    }
  }
  return null
}

httpProxyServer.listen(PROXY_PORT, () => {
  log('RELAY', `HTTP proxy on port ${PROXY_PORT}`)
})

server.listen(PORT, () => {
  log('RELAY', `PeerMesh relay running on port ${PORT}`)
})
