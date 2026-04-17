import { WebSocketServer, WebSocket } from 'ws'
import { createServer } from 'http'
import { randomUUID } from 'crypto'

const PORT = parseInt(process.env.PORT ?? '8080')
const API_BASE = process.env.API_BASE ?? 'https://peermesh-beta.vercel.app'
const RELAY_SECRET = process.env.RELAY_SECRET ?? ''

const peers = new Map()
const sessions = new Map()
// proxyClients: sessionId → WebSocket (extension's /proxy connection)
const proxyClients = new Map()

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

// ── Main signalling WebSocket (/, /ws) ────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true })

// ── Proxy tunnel WebSocket (/proxy?session=<id>) ──────────────────────────────
// Extension opens this after agent_session_ready to get a raw binary tunnel
// through the provider. Works on port 443 — no dedicated IPv4 needed.
const proxyWss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname === '/proxy') {
    proxyWss.handleUpgrade(req, socket, head, (ws) => proxyWss.emit('connection', ws, req))
  } else {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  }
})

// ── /proxy connection handler ─────────────────────────────────────────────────
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

  log('PROXY', `open session=${sessionId.slice(0,8)} from ${clientIp}`)
  proxyClients.set(sessionId, ws)

  // Extension → provider: forward binary frames as base64 JSON
  ws.on('message', (data) => {
    if (provider.readyState === WebSocket.OPEN) {
      const b64 = Buffer.isBuffer(data) ? data.toString('base64') : Buffer.from(data).toString('base64')
      send(provider, { type: 'proxy_ws_data', sessionId, data: b64 })
    }
  })

  ws.on('close', () => {
    proxyClients.delete(sessionId)
    send(provider, { type: 'proxy_ws_close', sessionId })
    log('PROXY', `closed session=${sessionId.slice(0,8)}`)
  })

  ws.on('error', () => proxyClients.delete(sessionId))

  // Notify provider that a proxy client connected
  send(provider, { type: 'proxy_ws_open', sessionId })
})

// ── Main signalling connection handler ────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const peerId = randomUUID()
  const clientIp = req.headers['x-forwarded-for'] ?? req.socket.remoteAddress

  Object.assign(ws, {
    peerId, role: null, country: null, userId: null,
    trustScore: 50, sessionId: null, providerKind: 'unknown',
    supportsHttp: true, supportsTunnel: false,
    bytesTransferred: 0, isAlive: true,
  })

  log(peerId.slice(0,8), `CONNECTED from ${clientIp}`)
  log(peerId.slice(0,8), `PEERS AFTER CONNECT`, peersSnapshot())
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
      log(peerId.slice(0,8), `MSG_IN type=${msg.type}`, msg.userId ? `userId=${msg.userId.slice(0,8)}` : '')
      handleMessage(ws, msg)
    } catch (e) {
      log(peerId.slice(0,8), `PARSE_ERROR ${e.message}`)
    }
  })

  ws.on('close', (code, reason) => {
    log(peerId.slice(0,8), `DISCONNECTED code=${code} reason=${reason?.toString() || 'none'} role=${ws.role} userId=${ws.userId?.slice(0,8)}`)
    peers.delete(peerId)
    cleanupSession(ws)
    log(peerId.slice(0,8), `PEERS AFTER DISCONNECT`, peersSnapshot())
  })

  ws.on('error', (err) => log(peerId.slice(0,8), `SOCKET_ERROR ${err.message}`))
})

function handleMessage(ws, msg) {
  switch (msg.type) {

    case 'register_provider': {
      for (const [id, peer] of peers) {
        if (peer.userId === msg.userId && peer.role === 'provider' && id !== ws.peerId) {
          log(id.slice(0,8), `EVICTING duplicate provider userId=${msg.userId?.slice(0,8)}`)
          if (peer.sessionId) {
            const oldSession = sessions.get(peer.sessionId)
            if (oldSession) {
              oldSession.providerId = ws.peerId
              ws.sessionId = peer.sessionId
              log(id.slice(0,8), `MIGRATING session ${peer.sessionId.slice(0,8)} to new connection`)
            }
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
      log(ws.peerId.slice(0,8), `REGISTERED_PROVIDER country=${ws.country} userId=${ws.userId?.slice(0,8)} trust=${ws.trustScore} agent=${ws.agentMode}`, `kind=${ws.providerKind} http=${ws.supportsHttp} tunnel=${ws.supportsTunnel}`)
      log(ws.peerId.slice(0,8), `PEERS AFTER REGISTER`, peersSnapshot())
      break
    }

    case 'request_session': {
      const requireTunnel = !!msg.requireTunnel
      log(ws.peerId.slice(0,8), `REQUEST_SESSION country=${msg.country} userId=${msg.userId?.slice(0,8)}`, `requireTunnel=${requireTunnel}`)
      log(ws.peerId.slice(0,8), `PEERS AT REQUEST TIME`, peersSnapshot())

      const provider = findProvider(msg.country, ws.peerId, msg.userId, { requireTunnel })

      if (!provider) {
        log(ws.peerId.slice(0,8), `NO_PROVIDER_FOUND for country=${msg.country}`)
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
        send(ws, { type: 'error', message: `No peers available in ${msg.country}` })
        return
      }

      const sessionId = randomUUID()
      ws.role = 'requester'
      ws.sessionId = sessionId
      ws.userId = msg.userId
      provider.sessionId = sessionId
      peers.set(ws.peerId, ws)

      sessions.set(sessionId, {
        requesterId: ws.peerId,
        providerId: provider.peerId,
        country: msg.country,
        startTime: Date.now(),
      })

      log(ws.peerId.slice(0,8), `SESSION_CREATED id=${sessionId.slice(0,8)} requester=${ws.peerId.slice(0,8)} provider=${provider.peerId.slice(0,8)} country=${msg.country}`)
      send(provider, { type: 'session_request', sessionId })
      send(ws, { type: 'session_created', sessionId })
      break
    }

    case 'agent_ready': {
      const agentSession = sessions.get(msg.sessionId)
      if (agentSession) {
        const requester = peers.get(agentSession.requesterId)
        if (requester) send(requester, { type: 'agent_session_ready', sessionId: msg.sessionId })
        agentSession.providerUserId = ws.userId
        log(ws.peerId.slice(0,8), `AGENT_READY session=${msg.sessionId.slice(0,8)} providerUserId=${ws.userId?.slice(0,8)}`)
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
      // Requester → provider: HTTP fetch request
      const proxySession = sessions.get(msg.sessionId)
      if (!proxySession) return
      const provider = peers.get(proxySession.providerId)
      if (provider?.agentMode) send(provider, { type: 'proxy_request', sessionId: msg.sessionId, request: msg.request })
      break
    }

    case 'proxy_response': {
      // Provider → requester: HTTP fetch response
      const respSession = sessions.get(msg.sessionId)
      if (respSession) {
        const requester = peers.get(respSession.requesterId)
        if (requester) send(requester, { type: 'proxy_response', sessionId: msg.sessionId, response: msg.response })
      }
      break
    }

    case 'proxy_ws_data': {
      // Provider → extension proxy WS: binary tunnel data
      const proxyClient = proxyClients.get(msg.sessionId)
      if (proxyClient?.readyState === WebSocket.OPEN) {
        proxyClient.send(Buffer.from(msg.data, 'base64'))
      }
      break
    }

    case 'proxy_ws_close': {
      const proxyClient = proxyClients.get(msg.sessionId)
      if (proxyClient) { proxyClient.close(); proxyClients.delete(msg.sessionId) }
      break
    }

    case 'end_session': {
      log(ws.peerId.slice(0,8), `END_SESSION role=${ws.role}`)
      cleanupSession(ws)
      break
    }

    case 'ping':
      break

    default:
      log(ws.peerId.slice(0,8), `UNKNOWN_MSG type=${msg.type}`)
  }
}

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data))
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
    ) return peer
  }
  return null
}

function cleanupSession(ws) {
  if (!ws.sessionId) return
  const session = sessions.get(ws.sessionId)
  if (session) {
    const otherId = ws.role === 'provider' ? session.requesterId : session.providerId
    const other = peers.get(otherId)
    if (other) { send(other, { type: 'session_ended', reason: 'peer_disconnected' }); other.sessionId = null }
    // Close any proxy WS client for this session
    const proxyClient = proxyClients.get(ws.sessionId)
    if (proxyClient) { proxyClient.close(); proxyClients.delete(ws.sessionId) }
    sessions.delete(ws.sessionId)
    log(ws.peerId.slice(0,8), `SESSION_CLEANED id=${ws.sessionId.slice(0,8)}`)
  }
  ws.sessionId = null
}

const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) { log(ws.peerId?.slice(0,8), `HEARTBEAT_TIMEOUT terminating`); ws.terminate(); return }
    ws.isAlive = false
    ws.ping()
  })
}, 30_000)

wss.on('close', () => clearInterval(heartbeat))

server.listen(PORT, () => {
  log('RELAY', `PeerMesh relay on port ${PORT} — signalling on / — proxy tunnel on /proxy`)
})
