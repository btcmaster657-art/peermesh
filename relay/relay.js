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
const providerShareStatusCache = new Map()

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
  return `total=${all.length} providers=${providers.length} requesters=${requesters.length} | providers: [${providers.map(p => `${p.peerId.slice(0,8)} userId=${p.userId?.slice(0,8)} country=${p.country} busy=${!!p.sessionId} private=${!!p.privateOnly}`).join(', ')}]`
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
// excludePeerIds: skip specific peer connections (e.g. the provider that just dropped)

async function getProviderShareStatus(userId, baseDeviceId = null) {
  const cacheKey = baseDeviceId ? `${userId}:${baseDeviceId}` : userId
  const cached = providerShareStatusCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.value
  if (!userId || !API_BASE || !RELAY_SECRET) {
    if (cached) {
      log('LIMIT', `STATUS_STALE userId=${userId?.slice(0,8) ?? 'unknown'} using cached share status`)
      return cached.value
    }
    return { can_accept_sessions: false, total_bytes_today: 0, daily_limit_bytes: null }
  }

  try {
    const qs = new URLSearchParams({ providerUserId: userId })
    if (baseDeviceId) qs.set('baseDeviceId', baseDeviceId)
    const res = await fetch(`${API_BASE}/api/user/sharing?${qs}`, {
      headers: { 'x-relay-secret': RELAY_SECRET },
    })
    if (!res.ok) throw new Error(`status=${res.status}`)
    const value = await res.json()
    providerShareStatusCache.set(cacheKey, { value, expiresAt: Date.now() + 5000 })
    return value
  } catch (err) {
    logErr('LIMIT', `provider status lookup failed userId=${userId.slice(0,8)}`, err)
    if (cached) {
      log('LIMIT', `STATUS_STALE userId=${userId.slice(0,8)} using cached share status`)
      return cached.value
    }
    return { can_accept_sessions: false, total_bytes_today: 0, daily_limit_bytes: null }
  }
}

async function findProvider(country, requesterId, requestingUserId, {
  requireTunnel = false,
  preferredUserId = null,
  privateBaseDeviceId = null,
  privateOnly = false,
  excludePeerIds = [],
} = {}) {
  const isEligible = (peer) =>
    peer.role === 'provider' &&
    peer.country === country &&
    !peer.sessionId &&
    peer.readyState === WebSocket.OPEN &&
    peer.trustScore >= 30 &&
    peer.peerId !== requesterId &&
    peer.userId !== requestingUserId &&
    !excludePeerIds.includes(peer.peerId) &&
    (!privateBaseDeviceId || peer.baseDeviceId === privateBaseDeviceId) &&
    // Block public connections from reaching private-only slots
    (!peer.privateOnly || !!privateBaseDeviceId) &&
    peer.supportsHttp !== false &&
    (!requireTunnel || peer.supportsTunnel)

  if (preferredUserId) {
    for (const [, peer] of peers) {
      if (peer.userId === preferredUserId && isEligible(peer)) {
        const status = await getProviderShareStatus(peer.userId, peer.baseDeviceId)
        if (!status.can_accept_sessions) {
          log('LIMIT', `SKIP preferred provider userId=${preferredUserId.slice(0,8)} daily limit reached`)
          continue
        }
        log('AFFINITY', `HIT preferred provider userId=${preferredUserId.slice(0,8)} country=${country}`)
        return peer
      }
    }
    if (privateOnly) {
      log('PRIVATE', `MISS preferred provider userId=${preferredUserId.slice(0,8)} baseDeviceId=${privateBaseDeviceId?.slice(0,12) ?? 'unknown'}`)
      return null
    }
    log('AFFINITY', `MISS preferred provider userId=${preferredUserId.slice(0,8)} offline/busy - falling back`)
  }

  const eligible = []
  for (const [, peer] of peers) {
    if (isEligible(peer)) eligible.push(peer)
  }
  if (eligible.length === 0) return null
  eligible.sort((a, b) => (b.trustScore ?? 50) - (a.trustScore ?? 50))

  for (const peer of eligible) {
    const status = await getProviderShareStatus(peer.userId, peer.baseDeviceId)
    if (status.can_accept_sessions) return peer
    log('LIMIT', `SKIP provider peerId=${peer.peerId.slice(0,8)} userId=${peer.userId?.slice(0,8)} daily limit reached`)
  }

  return null
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
    targetHostSynced: false,
    providerMetadataSynced: false,
    reconnectAttempts: 0,
    privateBaseDeviceId: requesterWs.privateBaseDeviceId ?? null,
    lastActivity: Date.now(),
  })

  send(provider, { type: 'session_request', sessionId })
  send(requesterWs, { type: 'session_created', sessionId })
  log(requesterWs.peerId.slice(0,8), `SESSION_CREATED id=${sessionId.slice(0,8)} provider=${provider.peerId.slice(0,8)} country=${country}`)
  return sessionId
}

function syncSessionMetadata(session, reason = 'update') {
  if (!API_BASE || !RELAY_SECRET || !session?.dbSessionId) return

  const payload = {
    dbSessionId: session.dbSessionId,
    providerUserId: session.providerUserId ?? null,
    providerKind: session.providerKind ?? null,
    targetHost: session.targetHost ?? null,
  }

  fetch(`${API_BASE}/api/session/end`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'x-relay-secret': RELAY_SECRET },
    body: JSON.stringify(payload),
  })
    .then(async (res) => {
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        log('RELAY', `SESSION_METADATA_${reason.toUpperCase()} status=${res.status} dbSessionId=${session.dbSessionId?.slice(0,8)} body=${body.slice(0,120)}`)
        return
      }
      log('RELAY', `SESSION_METADATA_${reason.toUpperCase()} dbSessionId=${session.dbSessionId?.slice(0,8)} provider=${session.providerUserId?.slice(0,8) ?? 'none'} host=${session.targetHost ?? 'none'}`)
    })
    .catch((err) => logErr('RELAY', `SESSION_METADATA_${reason.toUpperCase()} failed dbSessionId=${session.dbSessionId?.slice(0,8)}`, err))
}

// ── Auto-reconnect — called when provider drops while requester is still live ─

async function attemptReconnect(requesterWs, droppedSession) {
  const { country, dbSessionId, reconnectAttempts, providerUserId, requesterUserId, providerId, privateBaseDeviceId } = droppedSession

  if ((reconnectAttempts ?? 0) >= MAX_RECONNECT_ATTEMPTS) {
    log(requesterWs.peerId.slice(0,8), `RECONNECT giving up after ${MAX_RECONNECT_ATTEMPTS} attempts`)
    send(requesterWs, { type: 'session_ended', reason: 'no_peers_available' })
    return
  }

  // Exclude only the exact dropped peer connection. Other slots from the same user can still serve.
  const excludePeerIds = providerId ? [providerId] : []
  const preferred = privateBaseDeviceId ? providerUserId : getAffinity(requesterUserId, country)
  // Don't prefer the one that just dropped
  const preferredUserId = privateBaseDeviceId ? providerUserId : (preferred === providerUserId ? null : preferred)

  const nextProvider = await findProvider(country, requesterWs.peerId, requesterUserId, {
    excludePeerIds,
    preferredUserId,
    privateBaseDeviceId: privateBaseDeviceId ?? null,
    privateOnly: !!privateBaseDeviceId,
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

  // Tell requester a reconnect happened so extension/desktop can update proxySession.
  // Include relayEndpoint so the requester can update its /proxy-session correctly —
  // the requester is already on this relay (its WS never moved), so requesterWs.relayUrl is authoritative.
  send(requesterWs, {
    type: 'session_reconnected',
    sessionId: newSessionId,
    country,
    relayEndpoint: requesterWs.relayUrl ?? '',
    attempt: (reconnectAttempts ?? 0) + 1,
  })
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', peers: peers.size, sessions: sessions.size }))
    return
  }

  if (url.pathname === '/check-private') {
    const secret = req.headers['x-relay-secret'] ?? ''
    if (RELAY_SECRET && secret !== RELAY_SECRET) {
      res.writeHead(401)
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }
    const baseDeviceId = url.searchParams.get('baseDeviceId')
    const providerUserId = url.searchParams.get('providerUserId')
    if (!baseDeviceId || !providerUserId) {
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'baseDeviceId and providerUserId required' }))
      return
    }
    let online = false
    let country = null
    for (const [, peer] of peers) {
      if (
        peer.role === 'provider' &&
        peer.userId === providerUserId &&
        peer.baseDeviceId === baseDeviceId &&
        peer.readyState === WebSocket.OPEN
      ) {
        online = true
        country = peer.country
        break
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ online, country }))
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
        if (sess && !sess.targetHost) {
          sess.targetHost = hostname
          syncSessionMetadata(sess, 'target_host')
        }
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

  const host = req.headers['host'] ?? ''
  const relayUrl = host ? `wss://${host}` : ''

  Object.assign(ws, {
    peerId, role: null, country: null, userId: null,
    trustScore: 50, sessionId: null, providerKind: 'unknown',
    baseDeviceId: null,
    supportsHttp: true, supportsTunnel: false,
    privateOnly: false,
    bytesTransferred: 0, isAlive: true,
    relayUrl,
    clientIp: req.headers['fly-client-ip'] || (req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress || null,
  })

  log(peerId.slice(0,8), `CONNECTED from ${clientIp}`)
  send(ws, { type: 'connected', peerId })

  ws.on('pong', () => { ws.isAlive = true })

  ws.on('message', async (data) => {
    try {
      ws.bytesTransferred += data.length
      if (ws.bytesTransferred > 1_073_741_824) {
        send(ws, { type: 'error', message: 'Byte limit reached' })
        ws.terminate()
        return
      }
      const msg = JSON.parse(data.toString())
      if (msg.type !== 'ping') log(peerId.slice(0,8), `MSG_IN type=${msg.type}`, msg.userId ? `userId=${msg.userId.slice(0,8)}` : '')
      await handleMessage(ws, msg)
    } catch (e) {
      log(peerId.slice(0,8), `PARSE_ERROR ${e.message}`)
    }
  })

  ws.on('close', (code, reason) => {
    log(peerId.slice(0,8), `DISCONNECTED code=${code} role=${ws.role} userId=${ws.userId?.slice(0,8)}`)
    peers.delete(peerId)
    cleanupSession(ws)
    log(peerId.slice(0,8), `PEERS AFTER DISCONNECT`, peersSnapshot())
  })

  ws.on('error', (err) => log(peerId.slice(0,8), `SOCKET_ERROR ${err.message}`))
})

async function handleMessage(ws, msg) {
  switch (msg.type) {

    case 'register_provider': {
      log(ws.peerId.slice(0,8), `REGISTER_PROVIDER userId=${msg.userId?.slice(0,8)} country=${msg.country} deviceId=${msg.deviceId?.slice(0,8)}`)
      ws.deviceId = msg.deviceId ?? null
      ws.baseDeviceId = msg.baseDeviceId ?? msg.deviceId ?? null
      for (const [id, peer] of peers) {
        if (peer.userId === msg.userId && peer.role === 'provider' && id !== ws.peerId) {
          // Only evict if same device reconnecting — different devices are allowed
          if (msg.deviceId && peer.deviceId && peer.deviceId !== msg.deviceId) continue
          if (peer.sessionId) {
            const oldSession = sessions.get(peer.sessionId)
            if (oldSession) {
              // Transfer session ownership to the new WS before terminating the old one
              // so cleanupSession on the old peer's close event is a no-op and does not
              // trigger a spurious attemptReconnect that would drop the requester.
              oldSession.providerId = ws.peerId
              ws.sessionId = peer.sessionId
              peer.sessionId = null  // ← prevent cleanupSession from firing on old peer close
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
      ws.privateOnly = false
      // Fetch private share status BEFORE adding to pool to avoid race window
      if (ws.userId && ws.baseDeviceId && API_BASE && RELAY_SECRET) {
        try {
          const data = await getProviderShareStatus(ws.userId, ws.baseDeviceId)
          if (data?.private_share?.enabled && data.private_share.active) {
            ws.privateOnly = true
            log(ws.peerId.slice(0,8), `PRIVATE_ONLY set for userId=${ws.userId?.slice(0,8)} baseDeviceId=${ws.baseDeviceId?.slice(0,12)}`)
          }
        } catch {}
      }
      peers.set(ws.peerId, ws)
      send(ws, { type: 'registered', peerId: ws.peerId })
      log(ws.peerId.slice(0,8), `REGISTERED_PROVIDER country=${ws.country} userId=${ws.userId?.slice(0,8)}`)
      log(ws.peerId.slice(0,8), `PEERS AFTER REGISTER`, peersSnapshot())
      break
    }

    case 'request_session': {
      const requireTunnel = !!msg.requireTunnel
      const privateBaseDeviceId = msg.privateBaseDeviceId ?? null
      const privateOnly = !!privateBaseDeviceId
      log(ws.peerId.slice(0,8), `REQUEST_SESSION country=${msg.country} userId=${msg.userId?.slice(0,8)}`)
      log(ws.peerId.slice(0,8), `PEERS AT REQUEST TIME`, peersSnapshot())

      // Seed in-memory affinity from DB value passed by client on connect
      if (!privateOnly && msg.preferredProviderUserId && msg.userId && msg.country) {
        setAffinity(msg.userId, msg.country, msg.preferredProviderUserId)
        log('AFFINITY', `SEEDED from DB requester=${msg.userId.slice(0,8)} → provider=${msg.preferredProviderUserId.slice(0,8)} country=${msg.country}`)
      }

      const preferredUserId = privateOnly
        ? (msg.privateProviderUserId ?? msg.preferredProviderUserId ?? null)
        : getAffinity(msg.userId, msg.country)

      ws.privateBaseDeviceId = privateBaseDeviceId

      const provider = await findProvider(msg.country, ws.peerId, msg.userId, {
        requireTunnel,
        preferredUserId,
        privateBaseDeviceId,
        privateOnly,
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
            if (privateBaseDeviceId && peer.baseDeviceId !== privateBaseDeviceId) reasons.push('wrong_private_device')
            if (!privateBaseDeviceId && peer.privateOnly) reasons.push('private_only_slot')
            if (peer.supportsHttp === false) reasons.push('no_http')
            if (requireTunnel && !peer.supportsTunnel) reasons.push('no_tunnel')
            const shareStatus = await getProviderShareStatus(peer.userId, peer.baseDeviceId)
            if (!shareStatus.can_accept_sessions) reasons.push('daily_limit_reached')
            log(ws.peerId.slice(0,8), `  PROVIDER_REJECTED ${peer.peerId.slice(0,8)} | ${reasons.join(', ')}`)
          }
        }
        send(ws, { type: 'error', message: privateOnly ? 'Private share is offline or busy' : `No peers available in ${msg.country}` })
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
        // If providerUserId is already set on the session, agent_ready was already
        // processed once — this is a provider reconnect mid-session. Send
        // session_reconnected so the extension updates agentSessionId + proxySession
        // rather than ignoring a duplicate agent_session_ready.
        if (agentSession.providerUserId) {
          send(requester, {
            type: 'session_reconnected',
            sessionId: msg.sessionId,
            country: agentSession.country,
            relayEndpoint: requester.relayUrl ?? '',
            attempt: 1,
          })
        } else {
          send(requester, { type: 'agent_session_ready', sessionId: msg.sessionId })
        }
        log(ws.peerId.slice(0,8), `AGENT_READY session=${msg.sessionId.slice(0,8)} → requester notified`)
      }
      agentSession.providerUserId = ws.userId
      agentSession.providerKind = ws.providerKind ?? null
      syncSessionMetadata(agentSession, 'provider_assign')
      break
    }

    case 'proxy_request': {
      const proxySession = sessions.get(msg.sessionId)
      if (!proxySession) return
      const provider = peers.get(proxySession.providerId)
      if (!provider || !provider.agentMode) return
      proxySession.lastActivity = Date.now()
      const reqBytes = JSON.stringify(msg.request ?? {}).length
      proxySession.bytesRequester = (proxySession.bytesRequester ?? 0) + reqBytes
      if (msg.request?.url && !proxySession.targetHost) {
        try {
          proxySession.targetHost = new URL(msg.request.url).hostname
          syncSessionMetadata(proxySession, 'target_host')
        } catch {}
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
        tunnelSession.lastActivity = Date.now()
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
  const provider = peers.get(session.providerId)
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
      providerKind: provider?.providerKind ?? null,
    }),
  })
    .then(async (r) => {
      if (!r.ok) {
        const body = await r.text().catch(() => '')
        log('RELAY', `SESSION_END_REPORT relaySession=${sessionId.slice(0,8)} dbSession=${dbSessionId.slice(0,8)} status=${r.status} bytes=${bytesUsed} body=${body.slice(0,120)}`)
        return
      }
      log('RELAY', `SESSION_END_REPORT relaySession=${sessionId.slice(0,8)} dbSession=${dbSessionId.slice(0,8)} status=${r.status} bytes=${bytesUsed} provider=${session.providerUserId?.slice(0,8) ?? 'none'} host=${session.targetHost ?? 'none'}`)
    })
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

// ── Session idle watchdog ─────────────────────────────────────────────────────
// If a session has had no activity for 90s, check the provider is still alive.
// If the provider WS is gone or unresponsive, trigger auto-reconnect immediately
// rather than waiting up to 60s for the heartbeat to catch it.
const SESSION_IDLE_MS = 90_000
const sessionWatchdog = setInterval(() => {
  const now = Date.now()
  for (const [sessionId, session] of sessions) {
    if (now - session.lastActivity < SESSION_IDLE_MS) continue
    const provider = peers.get(session.providerId)
    const requester = peers.get(session.requesterId)
    if (!requester || requester.readyState !== WebSocket.OPEN) continue
    if (!provider || provider.readyState !== WebSocket.OPEN) {
      log(requester.peerId.slice(0,8), `SESSION_WATCHDOG provider gone sessionId=${sessionId.slice(0,8)}`)
      requester.sessionId = null
      sessions.delete(sessionId)
      attemptReconnect(requester, { ...session, reconnectAttempts: 0 })
    }
  }
}, 30_000)

wss.on('close', () => { clearInterval(heartbeat); clearInterval(sessionWatchdog) })

server.listen(PORT, () => {
  log('RELAY', `PeerMesh relay on port ${PORT}`)
})
