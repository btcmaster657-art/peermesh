#!/usr/bin/env node
/**
 * PeerMesh Provider Agent — self-bootstrapping
 * Just run: node peermesh-agent.js
 * (installs its own dependencies automatically)
 */

import { execSync } from 'child_process'
import { existsSync } from 'fs'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Auto-install ws if not present
if (!existsSync(join(__dirname, 'node_modules', 'ws'))) {
  console.log('[setup] Installing dependencies...')
  try {
    execSync('npm install ws', { cwd: __dirname, stdio: 'inherit' })
    console.log('[setup] Done!')
  } catch (e) {
    console.error('[setup] npm install failed. Please run: npm install ws')
    process.exit(1)
  }
}

import { WebSocket } from 'ws'
import { createServer } from 'http'
import { connect } from 'net'

const CONTROL_PORT = 7654
const PROXY_PORT = 7655

// ── State ─────────────────────────────────────────────────────────────────────

let config = {
  relay: 'ws://localhost:8080',
  apiBase: 'http://localhost:3000',
  token: '',
  userId: '',
  country: 'RW',
  trust: 50,
}

let ws = null
let running = false
let reconnectTimer = null
let reconnectDelay = 2000
let stats = { bytesServed: 0, requestsHandled: 0, connectedAt: null, peerId: null }

// ── Logging ───────────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19)
  console.log(`[${ts}] ${msg}`)
}

// ── Abuse filter ──────────────────────────────────────────────────────────────

const BLOCKED = [/\.onion$/i, /^smtp\./i, /^mail\./i, /torrent/i]
const PRIVATE = [/^localhost$/i, /^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./]

function isAllowed(url) {
  try {
    const { hostname, protocol } = new URL(url)
    if (!['http:', 'https:'].includes(protocol)) return false
    if (BLOCKED.some(p => p.test(hostname))) return false
    if (PRIVATE.some(p => p.test(hostname))) return false
    return true
  } catch { return false }
}

// ── Fetch handler — real IP, no CORS ─────────────────────────────────────────

async function handleFetch(request) {
  const { requestId, url, method = 'GET', headers = {}, body = null } = request

  if (!isAllowed(url)) {
    return { requestId, status: 403, headers: {}, body: '', error: 'URL not allowed' }
  }

  try {
    log(`  → ${method} ${url}`)
    const res = await fetch(url, {
      method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Cache-Control': 'no-cache',
        ...headers,
      },
      body: body ?? undefined,
      redirect: 'follow',
    })

    const responseBody = await res.text()
    const responseHeaders = {}
    res.headers.forEach((v, k) => {
      if (!['content-encoding', 'transfer-encoding', 'connection', 'keep-alive'].includes(k)) {
        responseHeaders[k] = v
      }
    })

    stats.bytesServed += responseBody.length
    stats.requestsHandled++
    log(`  ← ${res.status} ${url} (${responseBody.length}b)`)

    return { requestId, status: res.status, headers: responseHeaders, body: responseBody, finalUrl: res.url }
  } catch (err) {
    log(`  ✗ ${url}: ${err.message}`)
    return { requestId, status: 502, headers: {}, body: '', error: err.message }
  }
}

// ── Relay WebSocket ───────────────────────────────────────────────────────────

async function handleMessage(msg) {
  switch (msg.type) {
    case 'connected':
      stats.peerId = msg.peerId
      log(`Connected to relay (peerId=${msg.peerId.slice(0, 8)})`)
      ws.send(JSON.stringify({
        type: 'register_provider',
        userId: config.userId,
        country: config.country,
        trustScore: config.trust,
        agentMode: true,
      }))
      break

    case 'registered':
      stats.connectedAt = new Date().toISOString()
      log(`✓ Registered as provider — country=${config.country}`)
      break

    case 'session_request':
      log(`→ Session request: ${msg.sessionId.slice(0, 8)}`)
      ws.send(JSON.stringify({ type: 'agent_ready', sessionId: msg.sessionId }))
      break

    case 'proxy_request':
      const response = await handleFetch(msg.request)
      ws.send(JSON.stringify({ type: 'proxy_response', sessionId: msg.sessionId, response }))
      break

    case 'open_tunnel': {
      // Relay wants us to open a TCP tunnel to target host
      const { tunnelId, hostname, port } = msg
      log(`  TUNNEL ${hostname}:${port}`)
      const socket = netConnect(port, hostname)
      const activeTunnels = new Map()

      socket.on('connect', () => {
        ws.send(JSON.stringify({ type: 'tunnel_ready', tunnelId }))
        activeTunnels.set(tunnelId, socket)
      })
      socket.on('data', (data) => {
        ws.send(JSON.stringify({ type: 'tunnel_data', tunnelId, data: data.toString('base64') }))
        stats.bytesServed += data.length
        stats.requestsHandled++
      })
      socket.on('end', () => ws.send(JSON.stringify({ type: 'tunnel_close', tunnelId })))
      socket.on('error', (e) => {
        log(`  TUNNEL ERROR ${hostname}: ${e.message}`)
        ws.send(JSON.stringify({ type: 'tunnel_close', tunnelId }))
      })
      break
    }

    case 'tunnel_data': {
      // Data from client — write to target socket
      // Note: tunnel sockets tracked globally in practice; simplified here
      break
    }

    case 'session_ended':
      log(`← Session ended`)
      break

    case 'error':
      log(`✗ Relay: ${msg.message}`)
      break
  }
}

function connectRelay() {
  if (!config.token || !config.userId) {
    log('Not configured — waiting for dashboard to set token and userId')
    return
  }

  log(`Connecting to relay: ${config.relay}`)
  ws = new WebSocket(config.relay)

  ws.on('open', () => { running = true; reconnectDelay = 2000 })
  ws.on('message', (data) => {
    try { handleMessage(JSON.parse(data.toString())) } catch (e) { log(`Parse error: ${e.message}`) }
  })
  ws.on('close', (code) => {
    running = false
    stats.connectedAt = null
    log(`Disconnected (code=${code}), reconnecting in ${reconnectDelay / 1000}s...`)
    reconnectTimer = setTimeout(connectRelay, reconnectDelay)
    reconnectDelay = Math.min(reconnectDelay * 2, 30000)
  })
  ws.on('error', (err) => log(`WS error: ${err.message}`))
}

function stopRelay() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  if (ws) { ws.removeAllListeners('close'); ws.close(); ws = null }
  running = false
  stats = { bytesServed: 0, requestsHandled: 0, connectedAt: null, peerId: null }
  log('Agent stopped')
}

// ── Local control HTTP server ─────────────────────────────────────────────────

const controlServer = createServer((req, res) => {
  // Allow requests from localhost only
  const origin = req.headers.origin || ''
  const isLocal = origin.includes('localhost') || origin.includes('127.0.0.1')

  res.setHeader('Access-Control-Allow-Origin', isLocal ? origin : '')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  const url = new URL(req.url, `http://localhost:${CONTROL_PORT}`)

  // GET /health — dashboard polls this to check if agent is running
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      running,
      country: config.country,
      userId: config.userId?.slice(0, 8),
      proxyPort: PROXY_PORT,
      stats,
      version: '1.0.0',
    }))
    return
  }

  // POST /start — dashboard sends config and starts the agent
  if (req.method === 'POST' && url.pathname === '/start') {
    let body = ''
    req.on('data', d => body += d)
    req.on('end', () => {
      try {
        const data = JSON.parse(body)
        config = { ...config, ...data }
        stopRelay()
        connectRelay()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true }))
        log(`Started via dashboard — userId=${config.userId?.slice(0, 8)} country=${config.country}`)
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
    })
    return
  }

  // POST /stop — dashboard stops the agent
  if (req.method === 'POST' && url.pathname === '/stop') {
    stopRelay()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ success: true }))
    return
  }

  // POST /shutdown — kill the process entirely (used by uninstaller)
  if (req.method === 'POST' && url.pathname === '/shutdown') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ success: true }))
    stopRelay()
    setTimeout(() => process.exit(0), 200)
    return
  }

  res.writeHead(404)
  res.end()
})

controlServer.listen(CONTROL_PORT, '127.0.0.1', () => {
  log(`PeerMesh Agent control server on http://localhost:${CONTROL_PORT}`)
  log(`Dashboard will configure and start the relay connection automatically.`)
})

// ── HTTP CONNECT proxy server (port 7655) ────────────────────────────────────
// Chrome proxy settings point here — all browser traffic routes through this
// machine's real IP to the target site

const proxyServer = createServer((req, res) => {
  // Handle plain HTTP requests
  const urlObj = new URL(req.url.startsWith('http') ? req.url : `http://${req.headers.host}${req.url}`)
  const hostname = urlObj.hostname
  const port = parseInt(urlObj.port) || 80

  if (!isAllowedHost(hostname)) {
    res.writeHead(403)
    res.end('Blocked')
    return
  }

  const socket = connect(port, hostname, () => {
    const headers = Object.entries(req.headers)
      .filter(([k]) => !['proxy-connection', 'proxy-authorization'].includes(k.toLowerCase()))
      .map(([k, v]) => `${k}: ${v}`).join('\r\n')

    socket.write(`${req.method} ${urlObj.pathname}${urlObj.search} HTTP/1.1\r\n${headers}\r\n\r\n`)
    req.pipe(socket)
    socket.pipe(res)
  })
  socket.on('error', () => { res.writeHead(502); res.end() })
})

proxyServer.on('connect', (req, clientSocket, head) => {
  // Handle HTTPS CONNECT tunneling
  const [hostname, portStr] = (req.url || '').split(':')
  const port = parseInt(portStr) || 443

  if (!isAllowedHost(hostname)) {
    clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
    clientSocket.destroy()
    return
  }

  const serverSocket = connect(port, hostname, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    serverSocket.write(head)
    serverSocket.pipe(clientSocket)
    clientSocket.pipe(serverSocket)
    stats.requestsHandled++
    stats.bytesServed += head.length
    log(`  TUNNEL ${hostname}:${port}`)
  })

  serverSocket.on('error', () => {
    clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
    clientSocket.destroy()
  })
  clientSocket.on('error', () => serverSocket.destroy())
})

function isAllowedHost(hostname) {
  if (!hostname) return false
  return !BLOCKED.some(p => p.test(hostname)) && !PRIVATE.some(p => p.test(hostname))
}

proxyServer.listen(PROXY_PORT, '0.0.0.0', () => {
  log(`HTTP proxy server on http://127.0.0.1:${PROXY_PORT} (all interfaces)`)
})

proxyServer.on('error', (err) => {
  log(`Proxy server error: ${err.message}`)
})

process.on('SIGINT', () => { stopRelay(); process.exit(0) })
process.on('SIGTERM', () => { stopRelay(); process.exit(0) })
