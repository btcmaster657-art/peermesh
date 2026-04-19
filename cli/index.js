#!/usr/bin/env node
/**
 * PeerMesh Provider CLI
 *
 * Install globally (Mac / Windows / Linux):
 *   npm install -g peermesh-provider
 *
 * Or run without installing:
 *   npx peermesh-provider
 *
 * Options:
 *   --limit <MB>     Set daily bandwidth limit in MB and save to your account
 *   --no-limit       Remove your daily limit
 *   --reset          Clear saved credentials and re-authenticate
 *   --status         Show today's usage and limit then exit
 */

import { WebSocket } from 'ws'
import { connect } from 'net'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import http from 'http'

// ── Constants ─────────────────────────────────────────────────────────────────

const API_BASE    = 'https://peermesh-beta.vercel.app'
const RELAY_WS    = 'wss://peermesh-relay.fly.dev'
const CONFIG_DIR  = join(homedir(), '.peermesh')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')
const VERSION     = '1.0.16'

const BLOCKED = [/\.onion$/i, /^smtp\./i, /^mail\./i, /torrent/i]
const PRIVATE = [/^localhost$/i, /^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./]

// ── Args ──────────────────────────────────────────────────────────────────────

const args        = process.argv.slice(2)
const limitIdx    = args.indexOf('--limit')
const limitArg    = limitIdx !== -1 ? args[limitIdx + 1] : undefined
const noLimit     = args.includes('--no-limit')
const resetFlag   = args.includes('--reset')
const statusFlag  = args.includes('--status')
const serveFlag   = args.includes('--serve')

const CONTROL_PORT = 7654  // primary — whoever starts first owns this
const PEER_PORT    = 7656  // secondary — the other process registers here

// ── Config ────────────────────────────────────────────────────────────────────

function loadConfig() {
  try {
    if (existsSync(CONFIG_FILE)) return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'))
  } catch {}
  return {}
}

function saveConfig(cfg) {
  try {
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true })
    writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2))
  } catch {}
}

// ── Logging ───────────────────────────────────────────────────────────────────

function log(msg, level = 'info') {
  const ts = new Date().toTimeString().slice(0, 8)
  const icon = level === 'error' ? '✗' : level === 'warn' ? '⚠' : '●'
  console.log(`  ${icon}  [${ts}] ${msg}`)
}

function formatBytes(b) {
  if (!b || b < 1024) return `${b ?? 0}B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)}MB`
  return `${(b / 1024 / 1024 / 1024).toFixed(2)}GB`
}

function banner() {
  console.log('')
  console.log('  ╔══════════════════════════════════════════╗')
  console.log(`  ║      PEERMESH PROVIDER  v${VERSION}          ║`)
  console.log('  ║   Share your connection. Stay free.      ║')
  console.log('  ╚══════════════════════════════════════════╝')
  console.log('')
}

// ── State ─────────────────────────────────────────────────────────────────────

let config = loadConfig()
// Self-heal: clear any corrupted country value saved from the args bug
if (config.country?.startsWith('--')) { config.country = undefined; saveConfig(config) }
let ws = null
let running = false
let reconnectTimer = null
let reconnectDelay = 2000
let heartbeatTimer = null
let sessionBytes = 0       // bytes served this session
let limitHit = false
const activeTunnels = new Map()

if (!config.deviceId) {
  config.deviceId = 'cli_' + Math.random().toString(36).slice(2, 10)
  saveConfig(config)
}
const DEVICE_ID = config.deviceId

// ── Filters ───────────────────────────────────────────────────────────────────

function isAllowed(hostname) {
  return !BLOCKED.some(p => p.test(hostname)) && !PRIVATE.some(p => p.test(hostname))
}

// ── Relay ─────────────────────────────────────────────────────────────────────

function sendMsg(data) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data))
}

function closeTunnel(tunnelId, notify = false) {
  const t = activeTunnels.get(tunnelId)
  if (!t || t.closed) return
  t.closed = true
  activeTunnels.delete(tunnelId)
  if (notify) sendMsg({ type: 'tunnel_close', tunnelId })
  if (!t.socket.destroyed) t.socket.destroy()
}

function closeAllTunnels() {
  for (const id of [...activeTunnels.keys()]) closeTunnel(id, false)
}

// ── Bytes tracking — synced to DB ─────────────────────────────────────────────

let _pendingBytes = 0
let _flushTimer = null

function addBytes(n, limitBytes) {
  sessionBytes += n
  _pendingBytes += n

  // Flush to DB every 5s
  if (!_flushTimer) {
    _flushTimer = setTimeout(async () => {
      _flushTimer = null
      const toFlush = _pendingBytes
      _pendingBytes = 0
      if (!toFlush || !config.token) return
      try {
        await fetch(`${API_BASE}/api/user/sharing`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` },
          body: JSON.stringify({ bytes: toFlush }),
        })
      } catch {}
    }, 5000)
  }

  // Check limit — read fresh total_bytes_shared_today from DB via heartbeat response
  if (limitBytes && !limitHit && config.todaySharedBytes != null) {
    const totalToday = (config.todaySharedBytes ?? 0) + sessionBytes
    if (totalToday >= limitBytes) {
      limitHit = true
      console.log('')
      console.log('  ┌─────────────────────────────────────────┐')
      console.log(`  │  Daily limit of ${formatBytes(limitBytes).padEnd(8)} reached.          │`)
      console.log('  │  Sharing stopped. Run again tomorrow.    │')
      console.log('  │  Change your limit at peermesh.app       │')
      console.log('  └─────────────────────────────────────────┘')
      console.log('')
      stopRelay()
      process.exit(0)
    }
  }
}

function sendHeartbeat(limitBytes) {
  if (!config.token || !config.userId) return
  fetch(`${API_BASE}/api/user/sharing`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` },
    body: JSON.stringify({ device_id: DEVICE_ID }),
  })
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      if (!data) return
      // Store today's shared bytes from DB so limit check is accurate
      // The DB tracks total_bytes_shared; we approximate today's by storing a baseline
      // on startup and comparing. The heartbeat response doesn't return today's bytes
      // directly, so we rely on the GET /api/user/sharing poll below.
    })
    .catch(() => {})
}

async function pollTodayBytes() {
  if (!config.token) return
  try {
    const res = await fetch(`${API_BASE}/api/user/sharing`, {
      headers: { 'Authorization': `Bearer ${config.token}` },
    })
    if (!res.ok) return
    const data = await res.json()
    // Store the baseline total_bytes_shared at start of today
    const today = new Date().toDateString()
    if (config.usageDate !== today) {
      // New day — reset baseline to current total
      config.usageDate = today
      config.usageBytesBaseline = data.total_bytes_shared ?? 0
      config.todaySharedBytes = 0
      saveConfig(config)
    } else {
      // Today's bytes = current total minus baseline
      const baseline = config.usageBytesBaseline ?? data.total_bytes_shared ?? 0
      config.todaySharedBytes = Math.max(0, (data.total_bytes_shared ?? 0) - baseline)
      saveConfig(config)
    }
    return data
  } catch {}
}

function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
  if (!config.token) return
  fetch(`${API_BASE}/api/user/sharing`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` },
    body: JSON.stringify({ device_id: DEVICE_ID }),
  }).catch(() => {})
}

// ── Fetch handler ─────────────────────────────────────────────────────────────

async function handleFetch(request, limitBytes) {
  const { requestId, url, method = 'GET', headers = {}, body = null } = request
  try {
    const parsed = new URL(url)
    if (!isAllowed(parsed.hostname)) return { requestId, status: 403, headers: {}, body: '', error: 'Blocked' }
    const res = await fetch(url, {
      method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        ...headers,
      },
      body: body ?? undefined,
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    })
    const responseBody = await res.text()
    const responseHeaders = {}
    res.headers.forEach((v, k) => {
      if (!['content-encoding', 'transfer-encoding', 'connection', 'keep-alive'].includes(k)) responseHeaders[k] = v
    })
    addBytes(responseBody.length, limitBytes)
    return { requestId, status: res.status, headers: responseHeaders, body: responseBody, finalUrl: res.url }
  } catch (err) {
    return { requestId, status: 502, headers: {}, body: '', error: err.message }
  }
}

// ── Control server ────────────────────────────────────────────────────────────
// Tries to own CONTROL_PORT (7654). If desktop already owns it, falls back to
// PEER_PORT (7656) so the two can coexist and cross-notify each other.

let myPort = null   // the port this CLI process actually bound
let peerPort = null // the port the other process is on (for cross-notify)

function notifyPeer(path, body) {
  if (!peerPort) return
  const init = { method: 'POST', signal: AbortSignal.timeout(1500) }
  if (body) { init.headers = { 'Content-Type': 'application/json' }; init.body = JSON.stringify(body) }
  fetch(`http://127.0.0.1:${peerPort}${path}`, init).catch(() => {})
}

function buildHandler(port) {
  return http.createServer((req, res) => {
    const origin = req.headers.origin || ''
    res.setHeader('Access-Control-Allow-Origin',
      origin.includes('peermesh') || origin.includes('localhost') || origin.startsWith('chrome-extension://') ? origin : '')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    const url = new URL(req.url, `http://localhost:${port}`)

    function state() {
      return {
        available: true,
        running,
        shareEnabled: running,
        configured: !!(config.token && config.userId),
        userId: config.userId ?? null,
        version: VERSION,
        where: 'cli',
        stats: { bytesServed: sessionBytes, requestsHandled: 0, connectedAt: null, peerId: null },
      }
    }

    if (req.method === 'GET' && url.pathname === '/native/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(state()))
      return
    }

    if (req.method === 'POST' && url.pathname === '/native/share/start') {
      let body = ''
      req.on('data', d => body += d)
      req.on('end', () => {
        try {
          const data = JSON.parse(body || '{}')
          if (data.token)  config.token  = data.token
          if (data.userId) config.userId = data.userId
          if (data.trust)  config.trust  = data.trust
          saveConfig(config)
          if (!running) connectRelay(_controlLimitBytes)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(state()))
        } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })) }
      })
      return
    }

    if (req.method === 'POST' && url.pathname === '/native/share/stop') {
      stopRelay()
      // Also stop the peer process (desktop on the other port)
      if (peerPort) {
        fetch(`http://127.0.0.1:${peerPort}/native/share/stop`, { method: 'POST', signal: AbortSignal.timeout(1500) }).catch(() => {})
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(state()))
      return
    }

    if (req.method === 'POST' && url.pathname === '/quit') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      stopRelay()
      setTimeout(() => process.exit(0), 300)
      return
    }

    // Peer registration — the other process tells us its port
    if (req.method === 'POST' && url.pathname === '/native/peer/register') {
      let body = ''
      req.on('data', d => body += d)
      req.on('end', () => {
        try { peerPort = JSON.parse(body).port } catch {}
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      })
      return
    }

    res.writeHead(404); res.end()
  })
}

function startControlServer() {
  const primary = buildHandler(CONTROL_PORT)
  primary.listen(CONTROL_PORT, '127.0.0.1', () => {
    myPort = CONTROL_PORT
    log('Control server on port ' + CONTROL_PORT)
    // Check if a peer is already on PEER_PORT and register with it
    registerWithPeer(PEER_PORT)
  })
  primary.on('error', e => {
    if (e.code !== 'EADDRINUSE') { log('Control server error: ' + e.message, 'error'); return }
    // Desktop owns 7654 — bind to PEER_PORT instead
    const secondary = buildHandler(PEER_PORT)
    secondary.listen(PEER_PORT, '127.0.0.1', async () => {
      myPort = PEER_PORT
      // Read desktop's actual relay state
      let desktopState = null
      try {
        const r = await fetch(`http://127.0.0.1:${CONTROL_PORT}/native/state`, { signal: AbortSignal.timeout(1500) })
        if (r.ok) desktopState = await r.json()
      } catch {}
      const desktopSharing = !!desktopState?.running
      log('Desktop detected on port ' + CONTROL_PORT + (desktopSharing ? ' (sharing active)' : ' (not sharing)') + ' — CLI running as peer on port ' + PEER_PORT)
      // Register our port with the desktop so it can cross-notify us
      registerWithPeer(CONTROL_PORT)
      // Desktop is already sharing — don't also connect CLI relay.
      // Two providers with the same userId would evict each other in a loop.
      // The main() handoff timer will connect CLI if desktop stops.
      if (desktopSharing) {
        log('Desktop is sharing — CLI standing by')
      }
    })
    secondary.on('error', e2 => log('Could not bind peer port: ' + e2.message, 'error'))
  })
}

function registerWithPeer(targetPort) {
  fetch(`http://127.0.0.1:${targetPort}/native/peer/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ port: myPort, where: 'cli' }),
    signal: AbortSignal.timeout(1500),
  })
    .then(() => { peerPort = targetPort })
    .catch(() => {}) // peer not running — that's fine
}

let _controlLimitBytes = null

// ── Connect relay ─────────────────────────────────────────────────────────────

function connectRelay(limitBytes) {
  if (!config.token || !config.userId) return
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return

  log('Connecting to relay...')
  ws = new WebSocket(RELAY_WS)

  ws.on('open', () => {
    running = true
    reconnectDelay = 2000
    ws.send(JSON.stringify({
      type: 'register_provider',
      userId: config.userId,
      country: config.country,
      trustScore: config.trust ?? 50,
      agentMode: true,
      providerKind: 'cli',
      supportsHttp: true,
      supportsTunnel: true,
    }))
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    heartbeatTimer = setInterval(() => {
      sendHeartbeat(limitBytes)
      pollTodayBytes()  // refresh today's byte count from DB every 30s
    }, 30_000)
    sendHeartbeat(limitBytes)
  })

  ws.on('ping', () => { try { ws.pong() } catch {} })

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString())
      switch (msg.type) {
        case 'registered':
          log(`Sharing active — country: auto-detected from IP`)
          // Mark is_sharing in DB so dashboard/extension see the correct state
          if (config.token) {
            fetch(`${API_BASE}/api/user/sharing`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` },
              body: JSON.stringify({ isSharing: true }),
            }).catch(() => {})
          }
          printStatus(limitBytes)
          break

        case 'error':
          if (msg.message?.includes('Replaced')) {
            ws.removeAllListeners('close'); ws.close(1000); running = false
          }
          break

        case 'session_request':
          ws.send(JSON.stringify({ type: 'agent_ready', sessionId: msg.sessionId }))
          break

        case 'proxy_request': {
          const response = await handleFetch(msg.request, limitBytes)
          ws.send(JSON.stringify({ type: 'proxy_response', sessionId: msg.sessionId, response }))
          break
        }

        case 'open_tunnel': {
          const { tunnelId, hostname, port } = msg
          if (!isAllowed(hostname)) { sendMsg({ type: 'tunnel_close', tunnelId }); break }
          const socket = connect(port, hostname)
          activeTunnels.set(tunnelId, { socket, closed: false })
          socket.on('connect', () => sendMsg({ type: 'tunnel_ready', tunnelId }))
          socket.on('data', chunk => {
            sendMsg({ type: 'tunnel_data', tunnelId, data: chunk.toString('base64') })
            addBytes(chunk.length, limitBytes)
          })
          socket.on('end', () => closeTunnel(tunnelId, true))
          socket.on('close', () => activeTunnels.delete(tunnelId))
          socket.on('error', () => closeTunnel(tunnelId, true))
          break
        }

        case 'tunnel_data': {
          const t = activeTunnels.get(msg.tunnelId)
          if (t?.socket && !t.socket.destroyed) t.socket.write(Buffer.from(msg.data, 'base64'))
          break
        }

        case 'tunnel_close':
          closeTunnel(msg.tunnelId, false)
          break

        case 'session_ended':
          closeAllTunnels()
          break
      }
    } catch {}
  })

  ws.on('close', (code) => {
    running = false
    closeAllTunnels()
    ws = null
    if (code !== 1000 && !limitHit) {
      log(`Disconnected — reconnecting in ${reconnectDelay / 1000}s...`, 'warn')
      reconnectTimer = setTimeout(() => connectRelay(limitBytes), reconnectDelay)
      reconnectDelay = Math.min(reconnectDelay * 2, 30000)
    }
  })

  ws.on('error', e => log(`Connection error: ${e.message}`, 'error'))
}

function stopRelay() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  stopHeartbeat()
  if (ws) { ws.removeAllListeners('close'); ws.close(1000); ws = null }
  running = false
  closeAllTunnels()
  if (config.token) {
    fetch(`${API_BASE}/api/user/sharing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` },
      body: JSON.stringify({ isSharing: false }),
    }).catch(() => {})
  }
}

// ── Status display ────────────────────────────────────────────────────────────

function printStatus(limitBytes) {
  const todayTotal = (config.todaySharedBytes ?? 0) + sessionBytes
  const limitStr = limitBytes ? `${formatBytes(todayTotal)} / ${formatBytes(limitBytes)} today` : `${formatBytes(todayTotal)} today (no limit)`
  console.log('')
  console.log('  ┌─────────────────────────────────────────┐')
  console.log(`  │  User:    ${(config.username ?? config.userId?.slice(0, 8) ?? '—').padEnd(31)}│`)
  console.log(`  │  Country: auto-detected from IP${' '.repeat(12)}│`)
  console.log(`  │  Shared:  ${limitStr.padEnd(31)}│`)
  console.log('  │                                         │')
  console.log('  │  Press Ctrl+C to stop                   │')
  console.log('  └─────────────────────────────────────────┘')
  console.log('')
}

// ── Device flow auth ──────────────────────────────────────────────────────────

async function authenticate() {
  console.log('  Requesting sign-in code...')
  console.log('')

  let result
  try {
    const res = await fetch(`${API_BASE}/api/extension-auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: true }),
    })
    result = await res.json()
  } catch {
    console.error('  ✗  Could not reach server. Check your internet connection.')
    process.exit(1)
  }

  if (result.error) { console.error(`  ✗  ${result.error}`); process.exit(1) }

  const { device_code, user_code, interval = 3 } = result
  const verification_uri = `${API_BASE}/extension?activate=1`

  console.log('  ┌─────────────────────────────────────────┐')
  console.log('  │  Sign in to PeerMesh                    │')
  console.log('  │                                         │')
  console.log(`  │  1. Open: ${verification_uri}  │`)
  console.log('  │                                         │')
  console.log('  │  2. Enter this code when prompted:      │')
  console.log('  │                                         │')
  console.log(`  │         ${user_code.padEnd(33)}│`)
  console.log('  │                                         │')
  console.log('  │  Waiting for approval...                │')
  console.log('  └─────────────────────────────────────────┘')
  console.log('')

  return new Promise((resolve, reject) => {
    const poll = setInterval(async () => {
      try {
        const res = await fetch(`${API_BASE}/api/extension-auth?device_code=${encodeURIComponent(device_code)}`)
        const data = await res.json()
        if (data.status === 'approved' && data.user) { clearInterval(poll); resolve(data.user) }
        else if (data.status === 'denied') { clearInterval(poll); reject(new Error('Sign-in was denied')) }
        else if (data.status === 'expired') { clearInterval(poll); reject(new Error('Code expired — run again to get a new code')) }
      } catch {}
    }, interval * 1000)
    setTimeout(() => { clearInterval(poll); reject(new Error('Timed out waiting for sign-in')) }, 10 * 60 * 1000)
  })
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  banner()

  if (resetFlag) {
    const deviceId = config.deviceId
    config = { deviceId }
    saveConfig(config)
    log('Credentials cleared — please sign in again')
    console.log('')
  }

  // Authenticate if needed
  if (!config.token || !config.userId) {
    try {
      const user = await authenticate()
      config.token    = user.token
      config.userId   = user.id
      config.username = user.username
      config.country  = user.country ?? 'RW'
      config.trust    = user.trustScore ?? 50
      saveConfig(config)
      console.log(`  ✓  Signed in as ${config.username ?? config.userId.slice(0, 8)}`)
      console.log('')
    } catch (err) {
      console.error(`  ✗  ${err.message}`)
      process.exit(1)
    }
  } else {
    // Verify token
    try {
      const res = await fetch(`${API_BASE}/api/extension-auth?verify=1&userId=${config.userId}`, {
        headers: { 'Authorization': `Bearer ${config.token}` },
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) {
        log('Session expired — signing in again', 'warn')
        config.token = null; config.userId = null; saveConfig(config)
        return main()
      }
    } catch {
      log('Could not verify session (offline?) — continuing with saved credentials', 'warn')
    }
    log(`Signed in as ${config.username ?? config.userId.slice(0, 8)}`)
  }

  // ── Fetch profile from DB — gets limit + today's bytes ────────────────────
  const profile = await pollTodayBytes()

  // ── Handle --limit / --no-limit flags — save to DB ────────────────────────
  if (noLimit || limitArg !== undefined) {
    const newLimit = noLimit ? null : parseInt(limitArg)
    if (limitArg !== undefined && (isNaN(newLimit) || newLimit < 0)) {
      console.error('  ✗  --limit must be a positive number in MB (e.g. --limit 500)')
      process.exit(1)
    }
    try {
      await fetch(`${API_BASE}/api/user/sharing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` },
        body: JSON.stringify({ dailyLimitMb: newLimit }),
      })
      log(newLimit ? `Daily limit set to ${newLimit}MB and saved to your account` : 'Daily limit removed from your account')
    } catch {
      log('Could not save limit to server — will use local value', 'warn')
    }
  }

  // ── Determine effective limit ─────────────────────────────────────────────
  // Priority: --limit arg > DB value > no limit
  let limitMb = null
  if (limitArg !== undefined && !noLimit) {
    limitMb = parseInt(limitArg)
  } else if (!noLimit && profile?.daily_share_limit_mb) {
    limitMb = profile.daily_share_limit_mb
  }
  const limitBytes = limitMb ? limitMb * 1024 * 1024 : null

  // ── Status flag — show and exit ───────────────────────────────────────────
  if (statusFlag) {
    const todayBytes = config.todaySharedBytes ?? 0
    console.log('')
    console.log('  ┌─────────────────────────────────────────┐')
    console.log(`  │  User:       ${(config.username ?? '—').padEnd(28)}│`)
    console.log(`  │  Country:    ${(config.country ?? '—').padEnd(28)}│`)
    console.log(`  │  Shared today: ${formatBytes(todayBytes).padEnd(26)}│`)
    console.log(`  │  Daily limit:  ${(limitMb ? `${limitMb}MB` : 'none').padEnd(26)}│`)
    console.log('  └─────────────────────────────────────────┘')
    console.log('')
    process.exit(0)
  }

  // ── Check if already at limit ─────────────────────────────────────────────
  if (limitBytes && (config.todaySharedBytes ?? 0) >= limitBytes) {
    console.log('')
    console.log(`  ✗  Daily limit of ${formatBytes(limitBytes)} already reached for today.`)
    console.log('     Run again tomorrow, or change your limit:')
    console.log('       npx peermesh-provider --limit 1024')
    console.log('       npx peermesh-provider --no-limit')
    console.log('')
    process.exit(0)
  }

  // ── Show config ───────────────────────────────────────────────────────────
  console.log(`  Daily limit: ${limitMb ? `${limitMb}MB` : 'none (set with --limit <MB>)'}`)
  if (config.todaySharedBytes > 0) console.log(`  Used today:  ${formatBytes(config.todaySharedBytes)}`)
  console.log('')

  // ── Before-sharing confirmation ─────────────────────────────────────────
  if (!serveFlag) {
    // Check DB for accepted terms — skip prompt if already accepted
    const alreadyAccepted = profile?.has_accepted_provider_terms === true
    if (!alreadyAccepted) {
      console.log('')
      console.log('  ┌─────────────────────────────────────────┐')
      console.log('  │  BEFORE YOU SHARE                       │')
      console.log('  │                                         │')
      console.log('  │  🌐 Your IP will be used by other users │')
      console.log('  │  🔒 All sessions are logged             │')
      console.log('  │  🚫 Blocked: .onion, SMTP, torrents     │')
      console.log('  │  ⚡ You can stop at any time (Ctrl+C)   │')
      console.log('  │  💸 Sharing earns you free credits      │')
      console.log('  │                                         │')
      console.log('  └─────────────────────────────────────────┘')
      console.log('')

      const confirmed = await new Promise(resolve => {
        process.stdout.write('  Start sharing? [Y/n]: ')
        process.stdin.setEncoding('utf8')
        process.stdin.resume()
        process.stdin.once('data', data => {
          process.stdin.pause()
          const answer = data.toString().trim().toLowerCase()
          resolve(answer === '' || answer === 'y')
        })
      })

      if (!confirmed) {
        console.log('')
        console.log('  Cancelled.')
        console.log('')
        process.exit(0)
      }
      console.log('')
      // Save acceptance to DB
      try {
        await fetch(`${API_BASE}/api/user/sharing`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` },
          body: JSON.stringify({ acceptProviderTerms: true }),
        })
      } catch {}
    }
  }

  // ── Start control server so dashboard/extension can detect CLI ─────────────
  _controlLimitBytes = limitBytes
  startControlServer()

  // ── Connect — only if desktop is not already sharing ─────────────────────
  // If desktop owns port 7654 and is sharing, connecting CLI relay too would
  // cause both to register with the same userId and evict each other in a loop.
  // We check desktop state; if it's sharing we stand by and let desktop handle it.
  let desktopAlreadySharing = false
  try {
    const r = await fetch(`http://127.0.0.1:${CONTROL_PORT}/native/state`, { signal: AbortSignal.timeout(1500) })
    if (r.ok) {
      const s = await r.json()
      desktopAlreadySharing = !!s.running
    }
  } catch {}

  if (desktopAlreadySharing) {
    log('Desktop is sharing — CLI standing by (press Ctrl+C to stop both)')
    printStatus(limitBytes)
  } else {
    connectRelay(limitBytes)
  }

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  async function shutdown() {
    console.log('')
    log('Stopping...')
    // Always stop desktop relay too (covers both: CLI sharing or CLI standing by)
    if (peerPort) {
      try { await fetch(`http://127.0.0.1:${peerPort}/native/share/stop`, { method: 'POST', signal: AbortSignal.timeout(2000) }) } catch {}
    }
    stopRelay()
    console.log(`  Session: ${formatBytes(sessionBytes)} served`)
    console.log(`  Today:   ${formatBytes((config.todaySharedBytes ?? 0) + sessionBytes)} total`)
    console.log('')
    process.exit(0)
  }
  process.on('SIGINT', () => { shutdown() })
  process.on('SIGTERM', () => { stopRelay(); process.exit(0) })
}

main()
