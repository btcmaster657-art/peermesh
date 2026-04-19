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
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import http from 'http'

// Ensure UTF-8 output on Windows so box-drawing characters render correctly
if (process.platform === 'win32') {
  try { process.stdout.setEncoding('utf8') } catch {}
  try { process.stderr.setEncoding('utf8') } catch {}
}

// ── Constants ─────────────────────────────────────────────────────────────────

const API_BASE    = 'https://peermesh-beta.vercel.app'
const RELAY_WS    = 'wss://peermesh-relay.fly.dev'
const CONFIG_DIR  = join(homedir(), '.peermesh')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')
const VERSION     = '1.0.26'
const DEBUG_LOG   = join(homedir(), 'Desktop', 'peermesh-debug.log')

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
const debugFlag   = args.includes('--debug')  // kept for compat but logging is always-on

const CONTROL_PORT = 7654
const PEER_PORT    = 7656

// ── Logger ────────────────────────────────────────────────────────────────────
// Always writes to log file. Console output only for user-facing messages.
// Format: [ISO_TIMESTAMP] [CLI] [LEVEL] [CATEGORY] message | ctx={}

function _write(level, category, message, ctx) {
  const ts = new Date().toISOString()
  const ctxStr = ctx && Object.keys(ctx).length ? ' | ' + Object.entries(ctx).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ') : ''
  const line = `[${ts}] [CLI] [${level.padEnd(5)}] [${category.padEnd(12)}] ${message}${ctxStr}`
  // Always write to log file
  try { appendFileSync(DEBUG_LOG, line + '\n') } catch {}
  // Also print to console if --debug flag is set
  if (debugFlag) console.log(line)
}

const clog = {
  info:  (cat, msg, ctx) => _write('INFO',  cat, msg, ctx),
  warn:  (cat, msg, ctx) => _write('WARN',  cat, msg, ctx),
  error: (cat, msg, ctx) => _write('ERROR', cat, msg, ctx),
  debug: (cat, msg, ctx) => _write('DEBUG', cat, msg, ctx),
}

function clogState(label) {
  _write('DEBUG', 'STATE', `[${label}]`, {
    running, ws: ws ? ws.readyState : 'null',
    myPort, peerPort, tunnels: activeTunnels.size, limitHit,
  })
}

const clogRequest  = (method, url, body) => _write('INFO',  'HTTP-OUT', `→ ${method} ${url}`, body ? { body } : undefined)
const clogResponse = (method, url, status, ctx) => _write('INFO',  'HTTP-IN',  `← ${status} ${method} ${url}`, ctx)
const clogRelay    = (dir, type, ctx) => _write('DEBUG', 'RELAY',    `${dir} ${type}`, ctx)
const clogTunnel   = (event, tunnelId, ctx) => _write('DEBUG', 'TUNNEL',   `${event} tunnel=${tunnelId?.slice(0,8)}`, ctx)
const clogControl  = (method, path, ctx) => _write('INFO',  'CONTROL',  `${method} ${path}`, ctx)

// ── Config ────────────────────────────────────────────────────────────────────

function loadConfig() {
  try {
    if (existsSync(CONFIG_FILE)) return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'))
  } catch (e) { clog.warn('CONFIG', 'loadConfig read error', { err: e.message }) }
  return {}
}

function saveConfig(cfg) {
  try {
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true })
    writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2))
    clog.debug('CONFIG', 'config saved')
  } catch (e) { clog.error('CONFIG', 'saveConfig error', { err: e.message }) }
}

// ── User-facing console output ────────────────────────────────────────────────

function log(msg, level = 'info') {
  const ts = new Date().toTimeString().slice(0, 8)
  const icon = level === 'error' ? '✗' : level === 'warn' ? '⚠' : '●'
  console.log(`  ${icon}  [${ts}] ${msg}`)
  clog.info('USER', msg)
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
if (config.country?.startsWith('--')) { config.country = undefined; saveConfig(config) }
let ws = null
let running = false
let reconnectTimer = null
let reconnectDelay = 2000
let heartbeatTimer = null
let sessionBytes = 0
let limitHit = false
let _userStopped = false
const activeTunnels = new Map()

if (!config.deviceId) {
  config.deviceId = 'cli_' + Math.random().toString(36).slice(2, 10)
  saveConfig(config)
  clog.info('CONFIG', 'generated new deviceId', { deviceId: config.deviceId })
}
const DEVICE_ID = config.deviceId

clog.info('PROCESS', '=== CLI START ===', { version: VERSION, argv: process.argv.slice(2).join(' '), deviceId: DEVICE_ID, logFile: DEBUG_LOG })

// ── Filters ───────────────────────────────────────────────────────────────────

function isAllowed(hostname) {
  const blocked = BLOCKED.some(p => p.test(hostname))
  const private_ = PRIVATE.some(p => p.test(hostname))
  if (blocked || private_) clog.warn('FILTER', 'hostname blocked', { hostname, reason: blocked ? 'blocklist' : 'private' })
  return !blocked && !private_
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
  clogTunnel('CLOSED', tunnelId, { notify, remaining: activeTunnels.size })
}

function closeAllTunnels() {
  const count = activeTunnels.size
  for (const id of [...activeTunnels.keys()]) closeTunnel(id, false)
  if (count > 0) clog.info('TUNNEL', `closeAllTunnels — closed ${count}`)
}

// ── Bytes tracking ────────────────────────────────────────────────────────────

let _pendingBytes = 0
let _flushTimer = null

function addBytes(n, limitBytes) {
  sessionBytes += n
  _pendingBytes += n

  if (!_flushTimer) {
    _flushTimer = setTimeout(async () => {
      _flushTimer = null
      const toFlush = _pendingBytes
      _pendingBytes = 0
      if (!toFlush || !config.token) return
      clogRequest('POST', `${API_BASE}/api/user/sharing`, { bytes: toFlush })
      try {
        const r = await fetch(`${API_BASE}/api/user/sharing`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` },
          body: JSON.stringify({ bytes: toFlush }),
        })
        clogResponse('POST', `${API_BASE}/api/user/sharing`, r.status)
      } catch (e) { clog.warn('API', 'flushStats failed', { err: e.message }) }
    }, 5000)
  }

  if (limitBytes && !limitHit && config.todaySharedBytes != null) {
    const totalToday = (config.todaySharedBytes ?? 0) + sessionBytes
    clog.debug('LIMIT', 'bytes check', { totalToday, limitBytes, sessionBytes })
    if (totalToday >= limitBytes) {
      limitHit = true
      clog.warn('LIMIT', 'daily limit reached', { totalToday, limitBytes })
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
  clogRequest('PUT', `${API_BASE}/api/user/sharing`, { device_id: DEVICE_ID })
  fetch(`${API_BASE}/api/user/sharing`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` },
    body: JSON.stringify({ device_id: DEVICE_ID }),
  })
    .then(r => { clogResponse('PUT', `${API_BASE}/api/user/sharing`, r.status); return r.ok ? r.json() : null })
    .then(data => { if (data) clog.debug('HEARTBEAT', 'PUT ok', { data: JSON.stringify(data).slice(0,80) }) })
    .catch(e => clog.warn('HEARTBEAT', 'PUT error', { err: e.message }))
}

async function pollTodayBytes() {
  if (!config.token) return
  clogRequest('GET', `${API_BASE}/api/user/sharing`)
  try {
    const res = await fetch(`${API_BASE}/api/user/sharing`, { headers: { 'Authorization': `Bearer ${config.token}` } })
    clogResponse('GET', `${API_BASE}/api/user/sharing`, res.status)
    if (!res.ok) return
    const data = await res.json()
    const today = new Date().toDateString()
    if (config.usageDate !== today) {
      config.usageDate = today
      config.usageBytesBaseline = data.total_bytes_shared ?? 0
      config.todaySharedBytes = 0
      saveConfig(config)
      clog.info('USAGE', 'new day — baseline reset', { baseline: config.usageBytesBaseline })
    } else {
      const baseline = config.usageBytesBaseline ?? data.total_bytes_shared ?? 0
      config.todaySharedBytes = Math.max(0, (data.total_bytes_shared ?? 0) - baseline)
      saveConfig(config)
      clog.debug('USAGE', 'today bytes updated', { todaySharedBytes: config.todaySharedBytes, total: data.total_bytes_shared })
    }
    return data
  } catch (e) { clog.warn('API', 'pollTodayBytes error', { err: e.message }) }
}

function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; clog.debug('HEARTBEAT', 'timer cleared') }
  if (!config.token) return
  clogRequest('DELETE', `${API_BASE}/api/user/sharing`, { device_id: DEVICE_ID })
  fetch(`${API_BASE}/api/user/sharing`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` },
    body: JSON.stringify({ device_id: DEVICE_ID }),
  })
    .then(r => clogResponse('DELETE', `${API_BASE}/api/user/sharing`, r.status))
    .catch(e => clog.warn('HEARTBEAT', 'DELETE error', { err: e.message }))
}

// ── Fetch handler ─────────────────────────────────────────────────────────────

async function handleFetch(request, limitBytes) {
  const { requestId, url, method = 'GET', headers = {}, body = null } = request
  clog.info('PROXY', 'fetch request', { requestId: requestId?.slice(0,8), method, url })
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
    res.headers.forEach((v, k) => { if (!['content-encoding', 'transfer-encoding', 'connection', 'keep-alive'].includes(k)) responseHeaders[k] = v })
    const bytes = responseBody.length
    addBytes(bytes, limitBytes)
    clog.info('PROXY', 'fetch response', { requestId: requestId?.slice(0,8), status: res.status, bytes, finalUrl: res.url !== url ? res.url : undefined })
    return { requestId, status: res.status, headers: responseHeaders, body: responseBody, finalUrl: res.url }
  } catch (err) {
    clog.error('PROXY', 'fetch error', { requestId: requestId?.slice(0,8), url, err: err.message })
    return { requestId, status: 502, headers: {}, body: '', error: err.message }
  }
}

// ── Control server ────────────────────────────────────────────────────────────

let myPort = null
let peerPort = null

function notifyPeer(p, body) {
  if (!peerPort) return
  clog.info('PEER', `notifyPeer → ${p}`, { port: peerPort })
  const init = { method: 'POST', signal: AbortSignal.timeout(1500) }
  if (body) { init.headers = { 'Content-Type': 'application/json' }; init.body = JSON.stringify(body) }
  fetch(`http://127.0.0.1:${peerPort}${p}`, init)
    .then(r => clog.debug('PEER', `notifyPeer response`, { path: p, status: r.status }))
    .catch(e => clog.warn('PEER', `notifyPeer failed`, { path: p, err: e.message }))
}

function buildHandler(port) {
  return http.createServer((req, res) => {
    const origin = req.headers.origin || ''
    res.setHeader('Access-Control-Allow-Origin', origin.includes('peermesh') || origin.includes('localhost') || origin.startsWith('chrome-extension://') ? origin : '')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    const url = new URL(req.url, `http://localhost:${port}`)
    clogControl(req.method, url.pathname, { port, origin: origin.slice(0,40) || undefined })

    function state() {
      return { available: true, running, shareEnabled: running, configured: !!(config.token && config.userId), userId: config.userId ?? null, version: VERSION, where: 'cli', stats: { bytesServed: sessionBytes, requestsHandled: 0, connectedAt: null, peerId: null } }
    }

    if (req.method === 'GET' && url.pathname === '/native/state') {
      const s = state()
      clog.debug('CONTROL', '/native/state response', { running: s.running, shareEnabled: s.shareEnabled })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(s))
      return
    }

    if (req.method === 'POST' && url.pathname === '/native/share/start') {
      let body = ''
      req.on('data', d => body += d)
      req.on('end', () => {
        try {
          const data = JSON.parse(body || '{}')
          clog.info('CONTROL', '/native/share/start', { userId: data.userId, token: data.token ? '***' : undefined })
          if (data.token)  config.token  = data.token
          if (data.userId) config.userId = data.userId
          if (data.trust)  config.trust  = data.trust
          saveConfig(config)
          if (!running) { clog.info('CONTROL', 'starting relay from share/start'); connectRelay(_controlLimitBytes) }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(state()))
        } catch (e) { clog.error('CONTROL', '/native/share/start error', { err: e.message }); res.writeHead(400); res.end(JSON.stringify({ error: e.message })) }
      })
      return
    }

    if (req.method === 'POST' && url.pathname === '/native/share/stop') {
      clog.info('CONTROL', '/native/share/stop received — stopping relay and exiting')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(state()))
      stopRelay()
      setTimeout(() => { clog.info('PROCESS', 'process.exit(0) after share/stop'); process.exit(0) }, 300)
      // calledByPeer=true so shutdown() won't notify desktop back (they told us to stop)
      return
    }

    if (req.method === 'POST' && url.pathname === '/quit') {
      clog.info('CONTROL', '/quit received — stopping relay and exiting')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      stopRelay()
      setTimeout(() => { clog.info('PROCESS', 'process.exit(0) after /quit'); process.exit(0) }, 300)
      return
    }

    if (req.method === 'POST' && url.pathname === '/native/peer/register') {
      let body = ''
      req.on('data', d => body += d)
      req.on('end', () => {
        try {
          const data = JSON.parse(body)
          const prev = peerPort
          peerPort = data.port
          clog.info('CONTROL', '/native/peer/register', { peerPort, prevPeerPort: prev, where: data.where })
        } catch (e) { clog.warn('CONTROL', '/native/peer/register parse error', { err: e.message }) }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      })
      return
    }

    clog.warn('CONTROL', `404 ${req.method} ${url.pathname}`)
    res.writeHead(404); res.end()
  })
}

function startControlServer() {
  clog.info('CONTROL', 'startControlServer — trying to bind', { port: CONTROL_PORT })
  const primary = buildHandler(CONTROL_PORT)
  primary.listen(CONTROL_PORT, '127.0.0.1', () => {
    myPort = CONTROL_PORT
    clog.info('PORT', `PORT RACE RESULT: CLI owns ${CONTROL_PORT} (primary)`)
    log('Control server on port ' + CONTROL_PORT)
    registerWithPeer(PEER_PORT)
  })
  primary.on('error', e => {
    if (e.code !== 'EADDRINUSE') { clog.error('PORT', 'control server error', { err: e.message, code: e.code }); log('Control server error: ' + e.message, 'error'); return }
    clog.warn('PORT', `${CONTROL_PORT} in use — desktop owns it, binding to PEER_PORT ${PEER_PORT}`)
    const secondary = buildHandler(PEER_PORT)
    secondary.listen(PEER_PORT, '127.0.0.1', async () => {
      myPort = PEER_PORT
      clog.info('PORT', `PORT RACE RESULT: CLI on PEER_PORT ${PEER_PORT} (desktop owns ${CONTROL_PORT})`)
      let desktopState = null
      try {
        clogRequest('GET', `http://127.0.0.1:${CONTROL_PORT}/native/state`)
        const r = await fetch(`http://127.0.0.1:${CONTROL_PORT}/native/state`, { signal: AbortSignal.timeout(1500) })
        if (r.ok) { desktopState = await r.json(); clogResponse('GET', `http://127.0.0.1:${CONTROL_PORT}/native/state`, r.status, { running: desktopState.running, version: desktopState.version }) }
      } catch (e) { clog.warn('PORT', 'desktop state check failed', { err: e.message }) }
      const desktopSharing = !!desktopState?.running
      clog.info('PORT', 'desktop state at CLI startup', { desktopSharing, version: desktopState?.version })
      log('Desktop detected on port ' + CONTROL_PORT + (desktopSharing ? ' (sharing active)' : ' (not sharing)') + ' — CLI running as peer on port ' + PEER_PORT)
      registerWithPeer(CONTROL_PORT)
      if (desktopSharing) { clog.info('PORT', 'desktop is sharing — CLI standing by'); log('Desktop is sharing — CLI standing by') }
    })
    secondary.on('error', e2 => { clog.error('PORT', 'PEER_PORT bind error', { err: e2.message }); log('Could not bind peer port: ' + e2.message, 'error') })
  })
}

function registerWithPeer(targetPort) {
  clogRequest('POST', `http://127.0.0.1:${targetPort}/native/peer/register`, { port: myPort, where: 'cli' })
  fetch(`http://127.0.0.1:${targetPort}/native/peer/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ port: myPort, where: 'cli' }),
    signal: AbortSignal.timeout(1500),
  })
    .then(r => { clogResponse('POST', `http://127.0.0.1:${targetPort}/native/peer/register`, r.status); peerPort = targetPort; clog.info('PEER', 'registered with peer', { peerPort }) })
    .catch(e => clog.debug('PEER', 'registerWithPeer — peer not running', { targetPort, err: e.message }))
}

let _controlLimitBytes = null

// ── Connect relay ─────────────────────────────────────────────────────────────

function connectRelay(limitBytes) {
  if (!config.token || !config.userId) { clog.warn('RELAY', 'connectRelay skipped — no token/userId'); return }
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) { clog.warn('RELAY', 'connectRelay skipped — already connected', { wsState: ws.readyState }); return }
  _userStopped = false
  clog.info('RELAY', 'connectRelay START', { userId: config.userId, country: config.country, relay: RELAY_WS, limitBytes })
  clogState('pre-connect')
  log('Connecting to relay...')
  ws = new WebSocket(RELAY_WS)

  ws.on('open', () => {
    running = true
    reconnectDelay = 2000
    clog.info('RELAY', 'WebSocket OPEN', { relay: RELAY_WS })
    const reg = { type: 'register_provider', userId: config.userId, country: config.country, trustScore: config.trust ?? 50, agentMode: true, providerKind: 'cli', supportsHttp: true, supportsTunnel: true }
    clogRelay('SEND', 'register_provider', reg)
    ws.send(JSON.stringify(reg))
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    heartbeatTimer = setInterval(() => { sendHeartbeat(limitBytes); pollTodayBytes() }, 30_000)
    clog.debug('HEARTBEAT', 'timer started', { intervalMs: 30000 })
    sendHeartbeat(limitBytes)
    clogState('post-register-send')
  })

  ws.on('ping', () => { try { ws.pong(); clog.debug('RELAY', 'ping → pong') } catch {} })

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString())
      // Log all messages; bulk data frames get DEBUG level
      if (msg.type === 'tunnel_data') {
        clog.debug('RELAY', 'RECV tunnel_data', { tunnelId: msg.tunnelId?.slice(0,8), bytes: msg.data?.length })
      } else {
        clogRelay('RECV', msg.type, { sessionId: msg.sessionId?.slice(0,8), tunnelId: msg.tunnelId?.slice(0,8), message: msg.message, hostname: msg.hostname, port: msg.port })
      }

      switch (msg.type) {
        case 'registered':
          clog.info('RELAY', 'REGISTERED — sharing active')
          clogState('registered')
          log(`Sharing active — country: auto-detected from IP`)
          if (config.token) {
            clogRequest('POST', `${API_BASE}/api/user/sharing`, { isSharing: true })
            fetch(`${API_BASE}/api/user/sharing`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` },
              body: JSON.stringify({ isSharing: true }),
            })
              .then(r => clogResponse('POST', `${API_BASE}/api/user/sharing`, r.status))
              .catch(e => clog.warn('API', 'isSharing POST error', { err: e.message }))
          }
          printStatus(limitBytes)
          break

        case 'error':
          clog.error('RELAY', 'relay error message', { message: msg.message })
          if (msg.message?.includes('Replaced')) {
            clog.warn('RELAY', 'EVICTED by newer instance — stopping cleanly')
            ws.removeAllListeners('close'); ws.close(1000); running = false
          }
          break

        case 'session_request':
          clog.info('RELAY', 'session_request — sending agent_ready', { sessionId: msg.sessionId?.slice(0,8) })
          ws.send(JSON.stringify({ type: 'agent_ready', sessionId: msg.sessionId }))
          clogRelay('SEND', 'agent_ready', { sessionId: msg.sessionId?.slice(0,8) })
          break

        case 'proxy_request': {
          clog.info('RELAY', 'proxy_request received', { sessionId: msg.sessionId?.slice(0,8), url: msg.request?.url?.slice(0,80) })
          const response = await handleFetch(msg.request, limitBytes)
          ws.send(JSON.stringify({ type: 'proxy_response', sessionId: msg.sessionId, response }))
          clogRelay('SEND', 'proxy_response', { sessionId: msg.sessionId?.slice(0,8), status: response.status, bytes: response.body?.length })
          break
        }

        case 'open_tunnel': {
          const { tunnelId, hostname, port } = msg
          clog.info('TUNNEL', 'open_tunnel request', { tunnelId: tunnelId?.slice(0,8), target: `${hostname}:${port}`, activeTunnels: activeTunnels.size })
          if (!isAllowed(hostname)) { clog.warn('TUNNEL', 'open_tunnel BLOCKED', { hostname }); sendMsg({ type: 'tunnel_close', tunnelId }); break }
          const socket = connect(port, hostname)
          activeTunnels.set(tunnelId, { socket, closed: false })
          socket.on('connect', () => {
            clog.info('TUNNEL', 'TCP connected', { tunnelId: tunnelId?.slice(0,8), target: `${hostname}:${port}` })
            sendMsg({ type: 'tunnel_ready', tunnelId })
            clogRelay('SEND', 'tunnel_ready', { tunnelId: tunnelId?.slice(0,8) })
          })
          socket.on('data', chunk => {
            sendMsg({ type: 'tunnel_data', tunnelId, data: chunk.toString('base64') })
            addBytes(chunk.length, limitBytes)
          })
          socket.on('end', () => { clog.debug('TUNNEL', 'TCP end', { tunnelId: tunnelId?.slice(0,8) }); closeTunnel(tunnelId, true) })
          socket.on('close', () => activeTunnels.delete(tunnelId))
          socket.on('error', e => { clog.error('TUNNEL', 'TCP error', { tunnelId: tunnelId?.slice(0,8), target: hostname, err: e.message }); closeTunnel(tunnelId, true) })
          break
        }

        case 'tunnel_data': {
          const t = activeTunnels.get(msg.tunnelId)
          if (t?.socket && !t.socket.destroyed) t.socket.write(Buffer.from(msg.data, 'base64'))
          break
        }

        case 'tunnel_close':
          clog.info('TUNNEL', 'tunnel_close received', { tunnelId: msg.tunnelId?.slice(0,8) })
          closeTunnel(msg.tunnelId, false)
          break

        case 'session_ended':
          clog.info('RELAY', 'session_ended — closing all tunnels')
          closeAllTunnels()
          break
      }
    } catch (e) { clog.error('RELAY', 'message handler exception', { err: e.message }) }
  })

  ws.on('close', (code, reason) => {
    clog.info('RELAY', 'WebSocket CLOSED', { code, reason: reason?.toString() || '(none)', wasRunning: running })
    running = false
    closeAllTunnels()
    ws = null
    clogState('ws-closed')
    if (code !== 1000 && !limitHit && !_userStopped) {
      clog.info('RELAY', `scheduling reconnect`, { delayMs: reconnectDelay })
      log(`Disconnected — reconnecting in ${reconnectDelay / 1000}s...`, 'warn')
      reconnectTimer = setTimeout(() => connectRelay(limitBytes), reconnectDelay)
      reconnectDelay = Math.min(reconnectDelay * 2, 30000)
    } else {
      clog.info('RELAY', 'no reconnect', { code, limitHit, _userStopped })
    }
  })

  ws.on('error', e => { clog.error('RELAY', 'WebSocket error', { code: e.code, err: e.message }); log(`Connection error: ${e.message}`, 'error') })
}

function stopRelay() {
  clog.info('RELAY', 'stopRelay called')
  clogState('pre-stop')
  _userStopped = true
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; clog.debug('RELAY', 'reconnect timer cleared') }
  stopHeartbeat()
  if (ws) { ws.removeAllListeners('close'); ws.close(1000); ws = null; clog.info('RELAY', 'WebSocket closed (code 1000)') }
  running = false
  closeAllTunnels()
  clogState('post-stop')
  if (config.token) {
    clogRequest('POST', `${API_BASE}/api/user/sharing`, { isSharing: false })
    fetch(`${API_BASE}/api/user/sharing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` },
      body: JSON.stringify({ isSharing: false }),
    })
      .then(r => clogResponse('POST', `${API_BASE}/api/user/sharing`, r.status))
      .catch(e => clog.warn('API', 'isSharing false POST error', { err: e.message }))
  }
}

// ── Status display ────────────────────────────────────────────────────────────

function printStatus(limitBytes) {
  const todayTotal = (config.todaySharedBytes ?? 0) + sessionBytes
  const limitStr = limitBytes ? `${formatBytes(todayTotal)} / ${formatBytes(limitBytes)} today` : `${formatBytes(todayTotal)} today (no limit)`
  clog.info('STATUS', 'sharing active status', { todayTotal, limitBytes, sessionBytes })
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
  clog.info('AUTH', 'requesting device code')

  let result
  try {
    clogRequest('POST', `${API_BASE}/api/extension-auth`, { device: true })
    const res = await fetch(`${API_BASE}/api/extension-auth`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device: true }) })
    result = await res.json()
    clogResponse('POST', `${API_BASE}/api/extension-auth`, res.status, { user_code: result.user_code, interval: result.interval })
  } catch (e) {
    clog.error('AUTH', 'device code request failed', { err: e.message })
    console.error('  ✗  Could not reach server. Check your internet connection.')
    process.exit(1)
  }

  if (result.error) { clog.error('AUTH', 'device code error', { error: result.error }); console.error(`  ✗  ${result.error}`); process.exit(1) }

  const { device_code, user_code, interval = 3 } = result
  const verification_uri = `${API_BASE}/extension?activate=1`
  clog.info('AUTH', 'device code received — waiting for user approval', { user_code, interval })

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
        clog.debug('AUTH', 'polling device code', { device_code: device_code?.slice(0,8) })
        const res = await fetch(`${API_BASE}/api/extension-auth?device_code=${encodeURIComponent(device_code)}`)
        const data = await res.json()
        clog.debug('AUTH', 'poll result', { status: data.status })
        if (data.status === 'approved' && data.user) { clearInterval(poll); clog.info('AUTH', 'device code approved', { userId: data.user.id }); resolve(data.user) }
        else if (data.status === 'denied') { clearInterval(poll); clog.warn('AUTH', 'device code denied'); reject(new Error('Sign-in was denied')) }
        else if (data.status === 'expired') { clearInterval(poll); clog.warn('AUTH', 'device code expired'); reject(new Error('Code expired — run again to get a new code')) }
      } catch (e) { clog.warn('AUTH', 'poll error', { err: e.message }) }
    }, interval * 1000)
    setTimeout(() => { clearInterval(poll); clog.warn('AUTH', 'device code poll timed out'); reject(new Error('Timed out waiting for sign-in')) }, 10 * 60 * 1000)
  })
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  banner()

  if (debugFlag) {
    clog.info('PROCESS', 'debug flag enabled — logs also printing to console')
    console.log(`  ●  [DEBUG] Logging to ${DEBUG_LOG}`)
    console.log('')
  } else {
    console.log(`  ●  Logging to ${DEBUG_LOG}`)
    console.log('')
  }

  if (resetFlag) {
    const deviceId = config.deviceId
    config = { deviceId }
    saveConfig(config)
    clog.info('CONFIG', 'credentials cleared via --reset')
    log('Credentials cleared — please sign in again')
    console.log('')
  }

  if (!config.token || !config.userId) {
    try {
      const user = await authenticate()
      config.token    = user.token
      config.userId   = user.id
      config.username = user.username
      config.country  = user.country ?? 'RW'
      config.trust    = user.trustScore ?? 50
      saveConfig(config)
      clog.info('AUTH', 'signed in', { userId: config.userId, username: config.username, country: config.country })
      console.log(`  ✓  Signed in as ${config.username ?? config.userId.slice(0, 8)}`)
      console.log('')
    } catch (err) {
      clog.error('AUTH', 'authentication failed', { err: err.message })
      console.error(`  ✗  ${err.message}`)
      process.exit(1)
    }
  } else {
    clog.info('AUTH', 'verifying saved token', { userId: config.userId })
    try {
      clogRequest('GET', `${API_BASE}/api/extension-auth?verify=1&userId=${config.userId}`)
      const res = await fetch(`${API_BASE}/api/extension-auth?verify=1&userId=${config.userId}`, { headers: { 'Authorization': `Bearer ${config.token}` }, signal: AbortSignal.timeout(5000) })
      clogResponse('GET', `${API_BASE}/api/extension-auth?verify`, res.status)
      if (!res.ok) {
        clog.warn('AUTH', 'token expired — re-authenticating', { status: res.status })
        log('Session expired — signing in again', 'warn')
        config.token = null; config.userId = null; saveConfig(config)
        return main()
      }
      clog.info('AUTH', 'token valid')
    } catch (e) {
      clog.warn('AUTH', 'token verify error (offline?) — continuing', { err: e.message })
      log('Could not verify session (offline?) — continuing with saved credentials', 'warn')
    }
    log(`Signed in as ${config.username ?? config.userId.slice(0, 8)}`)
  }

  const profile = await pollTodayBytes()
  clog.info('PROFILE', 'profile loaded', { daily_share_limit_mb: profile?.daily_share_limit_mb, has_accepted_terms: profile?.has_accepted_provider_terms, total_bytes: profile?.total_bytes_shared })

  if (noLimit || limitArg !== undefined) {
    const newLimit = noLimit ? null : parseInt(limitArg)
    if (limitArg !== undefined && (isNaN(newLimit) || newLimit < 0)) {
      clog.error('ARGS', '--limit invalid', { limitArg })
      console.error('  ✗  --limit must be a positive number in MB (e.g. --limit 500)')
      process.exit(1)
    }
    clog.info('LIMIT', 'setting daily limit', { newLimit })
    try {
      clogRequest('POST', `${API_BASE}/api/user/sharing`, { dailyLimitMb: newLimit })
      const r = await fetch(`${API_BASE}/api/user/sharing`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` }, body: JSON.stringify({ dailyLimitMb: newLimit }) })
      clogResponse('POST', `${API_BASE}/api/user/sharing`, r.status)
      log(newLimit ? `Daily limit set to ${newLimit}MB and saved to your account` : 'Daily limit removed from your account')
    } catch (e) { clog.warn('LIMIT', 'could not save limit to server', { err: e.message }); log('Could not save limit to server — will use local value', 'warn') }
  }

  let limitMb = null
  if (limitArg !== undefined && !noLimit) limitMb = parseInt(limitArg)
  else if (!noLimit && profile?.daily_share_limit_mb) limitMb = profile.daily_share_limit_mb
  const limitBytes = limitMb ? limitMb * 1024 * 1024 : null
  clog.info('LIMIT', 'effective limit', { limitMb, limitBytes })

  if (statusFlag) {
    const todayBytes = config.todaySharedBytes ?? 0
    clog.info('STATUS', '--status flag — printing and exiting', { todayBytes, limitMb })
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

  if (limitBytes && (config.todaySharedBytes ?? 0) >= limitBytes) {
    clog.warn('LIMIT', 'already at daily limit — exiting', { todaySharedBytes: config.todaySharedBytes, limitBytes })
    console.log('')
    console.log(`  ✗  Daily limit of ${formatBytes(limitBytes)} already reached for today.`)
    console.log('     Run again tomorrow, or change your limit:')
    console.log('       npx peermesh-provider --limit 1024')
    console.log('       npx peermesh-provider --no-limit')
    console.log('')
    process.exit(0)
  }

  console.log(`  Daily limit: ${limitMb ? `${limitMb}MB` : 'none (set with --limit <MB>)'}`)
  if (config.todaySharedBytes > 0) console.log(`  Used today:  ${formatBytes(config.todaySharedBytes)}`)
  console.log('')

  if (!serveFlag) {
    const alreadyAccepted = profile?.has_accepted_provider_terms === true
    clog.info('TERMS', 'provider terms check', { alreadyAccepted })
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

      clog.info('TERMS', 'user confirmation', { confirmed })
      if (!confirmed) { clog.info('TERMS', 'user declined — exiting'); console.log(''); console.log('  Cancelled.'); console.log(''); process.exit(0) }
      console.log('')
      try {
        clogRequest('POST', `${API_BASE}/api/user/sharing`, { acceptProviderTerms: true })
        const r = await fetch(`${API_BASE}/api/user/sharing`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` }, body: JSON.stringify({ acceptProviderTerms: true }) })
        clogResponse('POST', `${API_BASE}/api/user/sharing`, r.status)
        clog.info('TERMS', 'provider terms accepted and saved')
      } catch (e) { clog.warn('TERMS', 'could not save acceptance', { err: e.message }) }
    }
  }

  _controlLimitBytes = limitBytes
  clog.info('PROCESS', 'starting control server', { limitBytes })
  startControlServer()

  let desktopAlreadySharing = false
  try {
    clogRequest('GET', `http://127.0.0.1:${CONTROL_PORT}/native/state`)
    const r = await fetch(`http://127.0.0.1:${CONTROL_PORT}/native/state`, { signal: AbortSignal.timeout(1500) })
    if (r.ok) {
      const s = await r.json()
      desktopAlreadySharing = !!s.running
      clogResponse('GET', `http://127.0.0.1:${CONTROL_PORT}/native/state`, r.status, { running: s.running, shareEnabled: s.shareEnabled, version: s.version })
      clog.info('STARTUP', 'desktop state check', { desktopAlreadySharing, shareEnabled: s.shareEnabled })
    }
  } catch (e) { clog.debug('STARTUP', 'desktop state check failed — desktop not running', { err: e.message }) }

  if (desktopAlreadySharing) {
    clog.info('STARTUP', 'desktop is sharing — CLI standing by')
    log('Desktop is sharing — CLI standing by (press Ctrl+C to stop both)')
    clogState('standby')
    printStatus(limitBytes)

    const watchDesktop = setInterval(async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${CONTROL_PORT}/native/state`, { signal: AbortSignal.timeout(1500) })
        if (r.ok) {
          const s = await r.json()
          clog.debug('WATCHDESKTOP', 'desktop state poll', { running: s.running })
          if (!s.running) {
            clearInterval(watchDesktop)
            clog.info('WATCHDESKTOP', 'desktop stopped sharing — CLI exiting')
            log('Desktop stopped sharing — exiting')
            stopRelay()
            console.log(`  Session: ${formatBytes(sessionBytes)} served`)
            console.log(`  Today:   ${formatBytes((config.todaySharedBytes ?? 0) + sessionBytes)} total`)
            console.log('')
            process.exit(0)
          }
          return
        }
      } catch (e) { clog.debug('WATCHDESKTOP', 'desktop unreachable', { err: e.message }) }
      clearInterval(watchDesktop)
      clog.info('WATCHDESKTOP', 'desktop unreachable — CLI exiting')
      log('Desktop stopped — exiting')
      stopRelay()
      console.log(`  Session: ${formatBytes(sessionBytes)} served`)
      console.log(`  Today:   ${formatBytes((config.todaySharedBytes ?? 0) + sessionBytes)} total`)
      console.log('')
      process.exit(0)
    }, 3000)
  } else {
    clog.info('STARTUP', 'no desktop sharing detected — CLI connecting relay')
    clogState('pre-connect-main')
    connectRelay(limitBytes)
  }

  async function shutdown(calledByPeer = false) {
    console.log('')
    log('Stopping...')
    clog.info('PROCESS', 'shutdown() called', { sessionBytes, peerPort, calledByPeer })
    clogState('shutdown')
    if (peerPort && !calledByPeer) {
      clog.info('PROCESS', 'notifying desktop peer to stop', { peerPort })
      clogRequest('POST', `http://127.0.0.1:${peerPort}/native/share/stop`)
      try {
        const r = await fetch(`http://127.0.0.1:${peerPort}/native/share/stop`, { method: 'POST', signal: AbortSignal.timeout(2000) })
        clogResponse('POST', `http://127.0.0.1:${peerPort}/native/share/stop`, r.status)
      } catch (e) { clog.warn('PROCESS', 'desktop stop notify failed', { err: e.message }) }
    }
    stopRelay()
    const todayTotal = (config.todaySharedBytes ?? 0) + sessionBytes
    clog.info('PROCESS', 'session summary', { sessionBytes, todayTotal })
    console.log(`  Session: ${formatBytes(sessionBytes)} served`)
    console.log(`  Today:   ${formatBytes(todayTotal)} total`)
    console.log('')
    process.exit(0)
  }

  process.on('SIGINT',  () => { clog.info('PROCESS', 'SIGINT received'); shutdown() })
  process.on('SIGTERM', () => { clog.info('PROCESS', 'SIGTERM received'); stopRelay(); process.exit(0) })
}

main()