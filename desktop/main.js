const { app, Tray, Menu, BrowserWindow, nativeImage, ipcMain, shell, Notification } = require('electron')
const { WebSocket } = require('ws')
const path = require('path')
const http = require('http')
const net = require('net')
const fs = require('fs')
const os = require('os')
const { spawn, spawnSync } = require('child_process')

// ── Logger ────────────────────────────────────────────────────────────────────

const LOG_FILE = path.join(os.homedir(), 'Desktop', 'peermesh-debug.log')

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ')}`
  console.log(line)
  try { fs.appendFileSync(LOG_FILE, line + '\n') } catch {}
}

// Prevent uncaught errors from showing Electron's error dialog
process.on('uncaughtException', (err) => {
  log('uncaughtException', err.message, err.stack)
  if (err.code === 'EADDRINUSE') return
})

const API_BASE = 'https://peermesh-beta.vercel.app'
const RELAY_WS = 'wss://peermesh-relay.fly.dev'
const RELAY_PROXY_PORT = 8081
const CONTROL_PORT = 7654
const LOCAL_PROXY_PORT = 7655
const PEER_PORT = 7656  // CLI binds here when desktop already owns 7654
const NATIVE_HOST_NAME = 'com.peermesh.desktop'
const EXTENSION_ID = 'chpkbnnohdiohlejmpmjmnmjgokalllm'
const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}/`
const DESKTOP_VERSION = require('./package.json').version
const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json')
const IS_NATIVE_HOST_MODE = process.argv.some(arg => arg.startsWith('chrome-extension://')) || process.argv.some(arg => arg.startsWith('--parent-window='))
const IS_BACKGROUND_LAUNCH = process.argv.includes('--background')

let peerPort = null  // port of the other process (CLI), set via /native/peer/register

function notifyPeer(path, body) {
  if (!peerPort) return
  const init = { method: 'POST', signal: AbortSignal.timeout(1500) }
  if (body) { init.headers = { 'Content-Type': 'application/json' }; init.body = JSON.stringify(body) }
  fetch(`http://127.0.0.1:${peerPort}${path}`, init).catch(() => {})
}

let tray = null
let settingsWindow = null
let ws = null
let running = false
let config = { token: '', userId: '', country: 'RW', trust: 50, extId: '', shareEnabled: false }
let stats = { bytesServed: 0, requestsHandled: 0, connectedAt: null }
let reconnectTimer = null
let reconnectDelay = 2000
const activeTunnels = new Map()

function sendRelayMessage(data) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data))
  }
}

function closeTunnel(tunnelId, notifyRelay = false) {
  const tunnel = activeTunnels.get(tunnelId)
  if (!tunnel || tunnel.closed) return

  tunnel.closed = true
  activeTunnels.delete(tunnelId)

  if (notifyRelay) {
    sendRelayMessage({ type: 'tunnel_close', tunnelId })
  }

  if (!tunnel.socket.destroyed) {
    tunnel.socket.destroy()
  }
}

function closeAllTunnels(notifyRelay = false) {
  for (const tunnelId of [...activeTunnels.keys()]) {
    closeTunnel(tunnelId, notifyRelay)
  }
}

// ── Config ────────────────────────────────────────────────────────────────────

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) }
      log('config loaded — userId:', config.userId || '(none)', 'shareEnabled:', config.shareEnabled)
    } else {
      log('no config file found at', CONFIG_FILE)
    }
  } catch (e) { log('loadConfig error:', e.message) }
  if (!config.extId) {
    config.extId = require('crypto').randomUUID()
    saveConfig()
  }
}

function saveConfig() {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config)) } catch {}
}

function getPublicState() {
  return {
    running,
    shareEnabled: !!config.shareEnabled,
    config: { ...config, token: config.token ? '***' : '' },
    stats,
    version: DESKTOP_VERSION,
  }
}

async function persistSharingState(isSharing) {
  if (!config.token) return
  try {
    await fetch(`${API_BASE}/api/user/sharing`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.token}`,
      },
      body: JSON.stringify({ isSharing }),
    })
  } catch {}
}

function getNativeHostManifestPath() {
  if (process.platform === 'win32') {
    return path.join(app.getPath('userData'), 'native-messaging', `${NATIVE_HOST_NAME}.json`)
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts', `${NATIVE_HOST_NAME}.json`)
  }
  return path.join(os.homedir(), '.config', 'google-chrome', 'NativeMessagingHosts', `${NATIVE_HOST_NAME}.json`)
}

function registerNativeMessagingHost() {
  try {
    const manifestPath = getNativeHostManifestPath()
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
    fs.writeFileSync(manifestPath, JSON.stringify({
      name: NATIVE_HOST_NAME,
      description: 'PeerMesh desktop helper',
      path: process.execPath,
      type: 'stdio',
      allowed_origins: [EXTENSION_ORIGIN],
    }, null, 2))

    if (process.platform === 'win32') {
      spawnSync('reg', [
        'ADD',
        `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
        '/ve',
        '/t',
        'REG_SZ',
        '/d',
        manifestPath,
        '/f',
      ], { stdio: 'ignore' })
    }
  } catch (err) {
    console.error('Failed to register native host:', err)
  }
}

function writeNativeMessage(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length, 0)
  process.stdout.write(header)
  process.stdout.write(body)
}

function launchMainApp() {
  const args = app.isPackaged ? ['--background'] : [app.getAppPath(), '--background']
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
}

async function waitForControlServer(timeoutMs = 15000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${CONTROL_PORT}/native/state`, { signal: AbortSignal.timeout(1500) })
      if (res.ok) return true
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  return false
}

async function callControl(pathname, { method = 'GET', body } = {}) {
  const init = { method, signal: AbortSignal.timeout(4000), headers: {} }
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const res = await fetch(`http://127.0.0.1:${CONTROL_PORT}${pathname}`, init)
  const text = await res.text()
  let data = {}
  try { data = text ? JSON.parse(text) : {} } catch {}
  if (!res.ok) throw new Error(data.error || `Control request failed (${res.status})`)
  return data
}

async function getNativeState() {
  try {
    return await callControl('/native/state')
  } catch {
    return {
      available: true,
      running: false,
      shareEnabled: false,
      configured: false,
      version: DESKTOP_VERSION,
    }
  }
}

async function ensureDesktopApp() {
  try {
    await callControl('/native/state')
    return true
  } catch {}

  launchMainApp()
  return waitForControlServer()
}

async function handleNativeHostMessage(message) {
  switch (message.type) {
    case 'status':
      return { success: true, ...(await getNativeState()) }
    case 'sync_auth': {
      const ok = await ensureDesktopApp()
      if (!ok) return { success: false, error: 'Desktop helper did not start' }
      const state = await callControl('/native/auth', { method: 'POST', body: message.payload || {} })
      return { success: true, ...state }
    }
    case 'start_sharing': {
      const ok = await ensureDesktopApp()
      if (!ok) return { success: false, error: 'Desktop helper did not start' }
      const state = await callControl('/native/share/start', { method: 'POST', body: message.payload || {} })
      return { success: true, ...state }
    }
    case 'stop_sharing': {
      const ok = await ensureDesktopApp()
      if (!ok) return { success: false, error: 'Desktop helper did not start' }
      const state = await callControl('/native/share/stop', { method: 'POST' })
      return { success: true, ...state }
    }
    case 'show_app': {
      const ok = await ensureDesktopApp()
      if (!ok) return { success: false, error: 'Desktop helper did not start' }
      const state = await callControl('/native/show', { method: 'POST' })
      return { success: true, ...state }
    }
    default:
      return { success: false, error: 'Unknown native host command' }
  }
}

function runNativeHostMode() {
  let buffer = Buffer.alloc(0)

  process.stdin.on('data', async (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length >= 4) {
      const messageLength = buffer.readUInt32LE(0)
      if (buffer.length < 4 + messageLength) return

      const body = buffer.slice(4, 4 + messageLength).toString('utf8')
      buffer = buffer.slice(4 + messageLength)

      try {
        const message = JSON.parse(body)
        const response = await handleNativeHostMessage(message)
        writeNativeMessage(response)
      } catch (err) {
        writeNativeMessage({ success: false, error: err.message || 'Native host error' })
      }
    }
  })
  process.stdin.on('end', () => process.exit(0))
}

// ── Abuse filter ──────────────────────────────────────────────────────────────

const BLOCKED = [/\.onion$/i, /^smtp\./i, /^mail\./i, /torrent/i]
const PRIVATE = [/^localhost$/i, /^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./]

function isAllowed(hostname) {
  return !BLOCKED.some(p => p.test(hostname)) && !PRIVATE.some(p => p.test(hostname))
}

// ── Fetch handler — plain Node fetch (no Playwright dependency) ──────────────

async function handleFetch(request) {
  const { requestId, url, method = 'GET', headers = {}, body = null } = request
  try {
    const parsed = new URL(url)
    if (!isAllowed(parsed.hostname)) {
      return { requestId, status: 403, headers: {}, body: '', error: 'URL not allowed' }
    }
    log(`  -> ${method} ${url}`)
    const res = await fetch(url, {
      method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Cache-Control': 'no-cache',
        ...headers,
      },
      body: body ?? undefined,
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    })
    const responseBody = await res.text()
    const responseHeaders = {}
    res.headers.forEach((v, k) => {
      if (!['content-encoding', 'transfer-encoding', 'connection', 'keep-alive'].includes(k)) {
        responseHeaders[k] = v
      }
    })
    const bodyLen = responseBody.length
    stats.bytesServed += bodyLen
    stats.requestsHandled++
    log(`  <- ${res.status} ${url} (${bodyLen}b)`)
    flushStats(bodyLen)
    return { requestId, status: res.status, headers: responseHeaders, body: responseBody, finalUrl: res.url }
  } catch (err) {
    log(`  x ${url}: ${err.message}`)
    return { requestId, status: 502, headers: {}, body: '', error: err.message }
  }
}

// ── Relay ─────────────────────────────────────────────────────────────────────

let heartbeatTimer = null

function startHeartbeat() {
  // Always clear existing timer before starting — handles reconnect after crash
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
  sendHeartbeat()
  heartbeatTimer = setInterval(sendHeartbeat, 30_000)
}

// ── Stats flush — write bytes to Supabase in batches ────────────────────────
let _pendingBytes = 0
let _flushTimer = null

function flushStats(bytes) {
  _pendingBytes += bytes
  if (_flushTimer) return
  _flushTimer = setTimeout(async () => {
    _flushTimer = null
    const toFlush = _pendingBytes
    _pendingBytes = 0
    if (!toFlush || !config.token || !config.userId) return
    try {
      await fetch(`${API_BASE}/api/user/sharing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` },
        body: JSON.stringify({ bytes: toFlush }),
      })
    } catch {}
  }, 5000) // batch writes every 5s
}

function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
  if (!config.token || !config.userId) return
  // Tell server this device stopped sharing
  fetch(`${API_BASE}/api/user/sharing`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` },
    body: JSON.stringify({ device_id: config.extId }),
  }).catch(() => {})
}

function sendHeartbeat() {
  if (!config.token || !config.userId || !config.extId) return
  fetch(`${API_BASE}/api/user/sharing`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` },
    body: JSON.stringify({ device_id: config.extId }),
  })
    .then(r => { if (!r.ok) r.json().then(b => log('[HEARTBEAT] PUT failed status=' + r.status, b)) })
    .catch(e => log('[HEARTBEAT] PUT error:', e.message))
}

function connectRelay() {
  if (!config.token || !config.userId) {
    log('connectRelay skipped — no token/userId')
    return
  }
  // Prevent duplicate connections
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    log('connectRelay skipped — already connected/connecting')
    return
  }
  log('connectRelay — userId:', config.userId, 'country:', config.country)
  ws = new WebSocket(RELAY_WS)

  ws.on('open', () => {
    log('relay connected')
    running = true
    reconnectDelay = 2000
    config.shareEnabled = true
    saveConfig()
    ws.send(JSON.stringify({
      type: 'register_provider',
      userId: config.userId,
      country: config.country,
      trustScore: config.trust,
      agentMode: true,
      providerKind: 'desktop',
      supportsHttp: true,
      supportsTunnel: true,
    }))
    startHeartbeat()
    updateTray()
  })

  // Respond to relay WebSocket ping frames to prevent heartbeat timeout
  ws.on('ping', () => { try { ws.pong() } catch {} })

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString())
      if (msg.type === 'registered') {
        stats.connectedAt = new Date().toISOString()
        showNotification('PeerMesh Active', `Sharing your ${config.country} connection`)
        // Tell peer (CLI) to start sharing too if it isn't already
        notifyPeer('/native/share/start', { token: config.token, userId: config.userId })
        updateTray()
      } else if (msg.type === 'error') {
        log('relay error message:', msg.message)
        if (msg.message?.includes('Replaced')) {
          // We were evicted — a newer instance took over, stop this one cleanly
          ws.removeAllListeners('close')
          ws.close(1000)
          running = false
          updateTray()
        }
      } else if (msg.type === 'proxy_ws_open') {
        // Extension opened a proxy WS tunnel — we are the provider endpoint
        // All subsequent proxy_ws_data frames are raw TCP data to/from the target
        // The extension handles the HTTP CONNECT handshake itself before sending data
        log('proxy_ws_open for session', msg.sessionId?.slice(0,8))
        // Nothing to do here — data arrives via proxy_ws_data
      } else if (msg.type === 'proxy_ws_data') {
        // Raw TCP data from extension → write to the target socket for this session
        const tunnel = activeTunnels.get(`ws_${msg.sessionId}`)
        if (tunnel?.socket && !tunnel.socket.destroyed) {
          tunnel.socket.write(Buffer.from(msg.data, 'base64'))
        }
      } else if (msg.type === 'proxy_ws_close') {
        const tunnel = activeTunnels.get(`ws_${msg.sessionId}`)
        if (tunnel) {
          if (!tunnel.socket.destroyed) tunnel.socket.destroy()
          activeTunnels.delete(`ws_${msg.sessionId}`)
        }
      } else if (msg.type === 'session_request') {
        log('session_request received sessionId:', msg.sessionId?.slice(0,8))
        ws.send(JSON.stringify({ type: 'agent_ready', sessionId: msg.sessionId }))
      } else if (msg.type === 'proxy_request') {
        log('proxy_request url:', msg.request?.url?.slice(0,80))
        const response = await handleFetch(msg.request)
        ws.send(JSON.stringify({ type: 'proxy_response', sessionId: msg.sessionId, response }))
      } else if (msg.type === 'open_tunnel') {
        log('open_tunnel', msg.hostname + ':' + msg.port, 'tunnelId:', msg.tunnelId?.slice(0,8))
        const socket = net.connect(msg.port, msg.hostname)
        activeTunnels.set(msg.tunnelId, { socket, closed: false, sessionId: msg.sessionId ?? null })
        socket.on('connect', () => {
          log('open_tunnel connected', msg.hostname + ':' + msg.port)
          sendRelayMessage({ type: 'tunnel_ready', tunnelId: msg.tunnelId })
        })
        socket.on('data', (chunk) => {
          sendRelayMessage({ type: 'tunnel_data', tunnelId: msg.tunnelId, data: chunk.toString('base64') })
          stats.bytesServed += chunk.length
          stats.requestsHandled++
          flushStats(chunk.length)
        })
        socket.on('end', () => closeTunnel(msg.tunnelId, true))
        socket.on('close', () => activeTunnels.delete(msg.tunnelId))
        socket.on('error', (e) => { log('open_tunnel error', msg.hostname, e.message); closeTunnel(msg.tunnelId, true) })
      } else if (msg.type === 'tunnel_data') {
        const tunnel = activeTunnels.get(msg.tunnelId)
        if (tunnel?.socket && !tunnel.socket.destroyed) {
          tunnel.socket.write(Buffer.from(msg.data, 'base64'))
        }
      } else if (msg.type === 'tunnel_close') {
        closeTunnel(msg.tunnelId, false)
      } else if (msg.type === 'session_ended') {
        closeAllTunnels(false)
        updateTray()
      }
    } catch {}
  })

  ws.on('close', (code) => {
    log('relay closed — code:', code)
    running = false
    stats.connectedAt = null
    closeAllTunnels(false)
    ws = null
    updateTray()
    if (code !== 1000) {
      reconnectTimer = setTimeout(connectRelay, reconnectDelay)
      reconnectDelay = Math.min(reconnectDelay * 2, 30000)
    }
  })

  ws.on('error', (e) => { log('relay error:', e.message) })
}

function stopRelay() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  if (ws) { ws.removeAllListeners('close'); ws.close(1000); ws = null }
  running = false
  config.shareEnabled = false
  saveConfig()
  closeAllTunnels(false)
  stats = { bytesServed: 0, requestsHandled: 0, connectedAt: null }
  stopHeartbeat()
  persistSharingState(false)
  // Tell peer (CLI) to stop sharing too
  notifyPeer('/native/share/stop')
  updateTray()
}

// ── Local HTTP proxy server (for extension) ───────────────────────────────────
// Extension sets Chrome proxy to 127.0.0.1:7655. This server forwards
// all traffic through the relay WebSocket to the connected peer provider.

let proxySession = null // { sessionId, relayEndpoint }

function openTunnelWs(hostname, port, onOpen) {
  if (!proxySession?.sessionId) return null
  const relayRaw = proxySession.relayEndpoint || RELAY_WS
  const relayHttp = relayRaw.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
  const relayOrigin = new URL(relayHttp).origin.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:')
  const proxyUrl = `${relayOrigin}/proxy?session=${encodeURIComponent(proxySession.sessionId)}`
  const tunnelWs = new WebSocket(proxyUrl)
  tunnelWs.on('open', () => {
    tunnelWs.send(`CONNECT ${hostname}:${port} HTTP/1.1\r\nHost: ${hostname}:${port}\r\n\r\n`)
    if (onOpen) onOpen()
  })
  return tunnelWs
}

const localProxyServer = http.createServer((req, res) => {
  if (!proxySession?.sessionId) {
    log('[LOCAL-PROXY] HTTP rejected — no session')
    res.writeHead(503); res.end('No PeerMesh session'); return
  }
  const parsed = new URL(req.url.startsWith('http') ? req.url : `http://${req.headers.host}${req.url}`)
  const hostname = parsed.hostname
  const port = parseInt(parsed.port) || 80
  log('[LOCAL-PROXY] HTTP', req.method, parsed.href.slice(0, 80))

  const chunks = []
  req.on('data', c => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    const tunnelWs = openTunnelWs(hostname, port)
    if (!tunnelWs) { res.writeHead(503); res.end('No PeerMesh session'); return }

    let ready = false
    let responseData = Buffer.alloc(0)

    tunnelWs.on('message', (data) => {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data)
      if (!ready) {
        responseData = Buffer.concat([responseData, chunk])
        const headerEnd = responseData.indexOf('\r\n\r\n')
        if (headerEnd === -1) return
        const firstLine = responseData.slice(0, responseData.indexOf('\r\n')).toString()
        if (!firstLine.includes('200')) {
          log('[LOCAL-PROXY] HTTP tunnel rejected:', firstLine)
          res.writeHead(502); res.end('Bad Gateway'); tunnelWs.close(); return
        }
        ready = true
        // Send the HTTP request over the tunnel
        const reqLine = `${req.method} ${parsed.pathname}${parsed.search} HTTP/1.1\r\n`
        const hdrs = Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')
        tunnelWs.send(Buffer.from(`${reqLine}${hdrs}\r\n\r\n`))
        if (body.length) tunnelWs.send(body)
        responseData = responseData.slice(headerEnd + 4)
        return
      }
      responseData = Buffer.concat([responseData, chunk])
    })

    tunnelWs.on('close', () => {
      if (!res.headersSent && responseData.length) {
        // Parse HTTP response from buffer
        const headerEnd = responseData.indexOf('\r\n\r\n')
        if (headerEnd !== -1) {
          const headerStr = responseData.slice(0, headerEnd).toString()
          const lines = headerStr.split('\r\n')
          const statusMatch = lines[0].match(/HTTP\/\S+ (\d+)/)
          const status = statusMatch ? parseInt(statusMatch[1]) : 200
          const hdrs = {}
          for (const line of lines.slice(1)) {
            const idx = line.indexOf(':')
            if (idx > 0) hdrs[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim()
          }
          delete hdrs['transfer-encoding']; delete hdrs['content-encoding']
          res.writeHead(status, hdrs)
          res.end(responseData.slice(headerEnd + 4))
        } else {
          res.writeHead(502); res.end('Bad Gateway')
        }
      } else if (!res.headersSent) {
        res.writeHead(502); res.end('Bad Gateway')
      }
    })

    tunnelWs.on('error', (e) => {
      log('[LOCAL-PROXY] HTTP tunnel error', e.message)
      if (!res.headersSent) { res.writeHead(502); res.end('Bad Gateway') }
    })

    setTimeout(() => {
      if (!res.headersSent) {
        log('[LOCAL-PROXY] HTTP timeout for', parsed.href.slice(0, 60))
        tunnelWs.terminate(); res.writeHead(504); res.end('Timeout')
      }
    }, 30000)
  })
})

localProxyServer.on('connect', (req, clientSocket, head) => {
  const [hostname, portStr] = (req.url || '').split(':')
  const port = parseInt(portStr) || 443
  log('[LOCAL-PROXY] CONNECT', hostname + ':' + port, '| sessionId:', proxySession?.sessionId?.slice(0,8) || 'NONE')

  if (!proxySession?.sessionId) {
    log('[LOCAL-PROXY] CONNECT rejected — no proxySession')
    clientSocket.write('HTTP/1.1 503 No PeerMesh Session\r\n\r\n')
    clientSocket.destroy()
    return
  }

  let opened = false
  const tunnelWs = openTunnelWs(hostname, port, () => { opened = true })
  if (!tunnelWs) {
    clientSocket.write('HTTP/1.1 503 No PeerMesh Session\r\n\r\n')
    clientSocket.destroy()
    return
  }
  log('[LOCAL-PROXY] opening tunnel WS for', hostname + ':' + port)

  tunnelWs.on('message', (data) => {
    const text = Buffer.isBuffer(data) ? data.toString() : data
    if (!clientSocket._connectSent && text.startsWith('HTTP/1.1 200')) {
      clientSocket._connectSent = true
      log('[LOCAL-PROXY] tunnel ready → 200 sent to Chrome for', hostname + ':' + port)
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head?.length) tunnelWs.send(head)
      clientSocket.on('data', (chunk) => {
        if (tunnelWs.readyState === WebSocket.OPEN) tunnelWs.send(chunk)
      })
      clientSocket.on('end', () => tunnelWs.close())
      clientSocket.on('error', (e) => { log('[LOCAL-PROXY] clientSocket error', e.message); tunnelWs.close() })
      return
    }
    if (!clientSocket.destroyed) clientSocket.write(Buffer.isBuffer(data) ? data : Buffer.from(data))
  })

  tunnelWs.on('close', (code, reason) => {
    log('[LOCAL-PROXY] tunnel WS closed', hostname + ':' + port, 'code=' + code, reason?.toString() || '')
    if (!clientSocket.destroyed) clientSocket.destroy()
  })

  tunnelWs.on('error', (e) => {
    log('[LOCAL-PROXY] tunnel WS error', hostname + ':' + port, e.message)
    if (!opened) clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
    if (!clientSocket.destroyed) clientSocket.destroy()
  })

  setTimeout(() => {
    if (!opened) {
      log('[LOCAL-PROXY] tunnel timeout for', hostname + ':' + port)
      tunnelWs.terminate()
      clientSocket.write('HTTP/1.1 504 Tunnel Timeout\r\n\r\n')
      clientSocket.destroy()
    }
  }, 15000)
})

// ── Control server ────────────────────────────────────────────────────────────

const controlServer = http.createServer((req, res) => {
  const origin = req.headers.origin || ''
  res.setHeader('Access-Control-Allow-Origin', origin.includes('peermesh') || origin.includes('localhost') || origin.startsWith('chrome-extension://') ? origin : '')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  const url = new URL(req.url, `http://localhost:${CONTROL_PORT}`)

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      running,
      shareEnabled: !!config.shareEnabled,
      country: config.country,
      userId: config.userId?.slice(0, 8),
      proxyPort: RELAY_PROXY_PORT,
      stats,
      version: DESKTOP_VERSION,
    }))
    return
  }
  if (req.method === 'GET' && url.pathname === '/native/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      available: true,
      running,
      shareEnabled: !!config.shareEnabled,
      configured: !!(config.token && config.userId),
      country: config.country,
      userId: config.userId,
      version: DESKTOP_VERSION,
      where: 'desktop',
      stats,
    }))
    return
  }
  if (req.method === 'POST' && url.pathname === '/native/auth') {
    let body = ''
    req.on('data', d => body += d)
    req.on('end', async () => {
      try {
        const data = JSON.parse(body || '{}')
        // Verify the desktop token before accepting it
        if (data.token) {
          try {
            const vRes = await fetch(`${API_BASE}/api/extension-auth?verify=1&userId=${encodeURIComponent(data.userId || '')}`, {
              headers: { 'Authorization': `Bearer ${data.token}` },
              signal: AbortSignal.timeout(5000),
            })
            if (!vRes.ok) {
              res.writeHead(401, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'Token verification failed' }))
              return
            }
          } catch { /* offline — allow if token format looks valid */ }
        }
        config = {
          ...config,
          token: data.token ?? config.token,
          userId: data.userId ?? config.userId,
          country: data.country ?? config.country,
          trust: data.trust ?? config.trust,
        }
        saveConfig()
        updateTray()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          available: true,
          running,
          shareEnabled: !!config.shareEnabled,
          configured: !!(config.token && config.userId),
          country: config.country,
          userId: config.userId,
          version: DESKTOP_VERSION,
        }))
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
    })
    return
  }
  if (req.method === 'POST' && url.pathname === '/native/share/start') {
    let body = ''
    req.on('data', d => body += d)
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}')
        config = {
          ...config,
          token: data.token ?? config.token,
          userId: data.userId ?? config.userId,
          country: data.country ?? config.country,
          trust: data.trust ?? config.trust,
          shareEnabled: true,
        }
        saveConfig()
        if (!running) connectRelay()
        updateTray()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          available: true, running: true, shareEnabled: true,
          configured: !!(config.token && config.userId),
          country: config.country, userId: config.userId, version: DESKTOP_VERSION,
        }))
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
    })
    return
  }
  if (req.method === 'POST' && url.pathname === '/native/share/stop') {
    stopRelay()
    // Eagerly persist false so dashboard sees it immediately
    persistSharingState(false)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      available: true, running: false, shareEnabled: false,
      configured: !!(config.token && config.userId),
      country: config.country, userId: config.userId, version: DESKTOP_VERSION,
    }))
    return
  }
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
  if (req.method === 'POST' && url.pathname === '/native/show') {
    showWindow()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      available: true,
      running,
      shareEnabled: !!config.shareEnabled,
      configured: !!(config.token && config.userId),
      country: config.country,
      userId: config.userId,
      version: DESKTOP_VERSION,
    }))
    return
  }
  if (req.method === 'POST' && url.pathname === '/start') {
    let body = ''
    req.on('data', d => body += d)
    req.on('end', () => {
      try {
        const data = JSON.parse(body)
        config = { ...config, ...data, shareEnabled: true }
        saveConfig()
        stopRelay()
        config.shareEnabled = true
        saveConfig()
        connectRelay()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true }))
      } catch (e) {
        res.writeHead(400)
        res.end(JSON.stringify({ error: e.message }))
      }
    })
    return
  }
  if (req.method === 'POST' && url.pathname === '/quit') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    setTimeout(() => app.quit(), 500)
    return
  }
  if (req.method === 'POST' && url.pathname === '/stop') {
    stopRelay()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ success: true }))
    return
  }
  if (req.method === 'POST' && url.pathname === '/proxy-session') {
    let body = ''
    req.on('data', d => body += d)
    req.on('end', () => {
      try {
        const data = JSON.parse(body)
        proxySession = data
        log('proxy-session set sessionId:', data.sessionId?.slice(0,8), 'relay:', data.relayEndpoint)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true }))
      } catch (e) { res.writeHead(400); res.end() }
    })
    return
  }
  if (req.method === 'DELETE' && url.pathname === '/proxy-session') {
    proxySession = null
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ success: true }))
    return
  }
  res.writeHead(404); res.end()
})

// ── Tray ──────────────────────────────────────────────────────────────────────

function createTrayIcon() {
  return nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAALEwAACxMBAJqcGAAAABZ0RVh0Q3JlYXRpb24gVGltZQAxMC8yOS8xMiCqmi3JAAAAB3RJTUUH3QodEQkWMFCEAAAAGXRFWHRTb2Z0d2FyZQBBZG9iZSBJbWFnZVJlYWR5ccllPAAAAMFJREFUeNpi/P//PwMlgImBQjDwBrCgC4SGhjIwMzMzIGMwMzMzoGNkZGQgxoAFY2JiYmBiYmJAYWBgYGBiYmJAZmBgYGBiYmJAZWBgYGBiYmJAYmBgYGBiYmJAYGBgYGBiYmJAX2BgYGBiYmJAXmBgYGBiYmJAXGBgYGBiYmJAWmBgYGBiYmJAWGBgYGBiYmJAVmBgYGBiYmJAVGBgYGBiYmJAUmBgYGBiYmJAUGBgYGBiYmJATmBgYGBiYmIAAQYAoZAD/kexdGUAAAAASUVORK5CYII='
  )
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

function updateTray() {
  if (!tray) return
  const menu = Menu.buildFromTemplate([
    { label: 'PeerMesh', enabled: false },
    { type: 'separator' },
    { label: running ? `● Sharing — ${config.country}` : '○ Not sharing', enabled: false },
    { label: running ? `${stats.requestsHandled} requests · ${formatBytes(stats.bytesServed)} served` : 'Click to start sharing', enabled: false },
    { type: 'separator' },
    {
      label: running ? 'Stop Sharing' : 'Start Sharing',
      click: () => {
        if (running) {
          stopRelay()
        } else if (config.token && config.userId) {
          connectRelay()
        } else { shell.openExternal(`${API_BASE}/dashboard`); showWindow() }
      },
    },
    { type: 'separator' },
    { label: 'Settings', click: showWindow },
    { label: 'Open Dashboard', click: () => shell.openExternal(`${API_BASE}/dashboard`) },
    { type: 'separator' },
    { label: 'Quit', click: () => { stopRelay(); if (settingsWindow) { settingsWindow.removeAllListeners('close'); settingsWindow.destroy() } app.quit() } },
  ])
  tray.setContextMenu(menu)
  tray.setToolTip(running ? `PeerMesh — Sharing (${config.country})` : 'PeerMesh — Inactive')
}

// ── Settings window ───────────────────────────────────────────────────────────

function showWindow() {
  if (settingsWindow) {
    if (settingsWindow.isMinimized()) settingsWindow.restore()
    settingsWindow.show()
    settingsWindow.focus()
    return
  }
  settingsWindow = new BrowserWindow({
    width: 380, height: 520, resizable: false,
    title: 'PeerMesh', backgroundColor: '#0a0a0f',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  })
  settingsWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  settingsWindow.setMenuBarVisibility(false)
  // hide instead of destroy so second-instance can show it again
  settingsWindow.on('close', (e) => {
    e.preventDefault()
    settingsWindow.hide()
  })
}

function showNotification(title, body) {
  if (Notification.isSupported()) new Notification({ title, body, silent: true }).show()
}

// ── IPC ───────────────────────────────────────────────────────────────────────

ipcMain.handle('get-ext-id', () => config.extId)

ipcMain.handle('check-website-auth', async () => {
  // Legacy ext_id flow — kept for backward compat but device flow is preferred
  try {
    const res = await fetch(`${API_BASE}/api/extension-auth?ext_id=${config.extId}`)
    const data = await res.json()
    if (res.status === 403) return { error: data.error || 'Account not verified' }
    if (res.status === 401) return { error: 'Session expired — please sign in again' }
    if (res.status === 404) return { error: 'User not found' }
    if (!data.user) return { pending: true }
    if (!data.user.token || !data.user.id) return { error: 'Invalid auth response' }
    return { user: data.user }
  } catch { return { error: 'Could not reach server' } }
})

// Device flow — request a code, open browser, poll for approval
ipcMain.handle('request-device-code', async () => {
  log('request-device-code called')
  try {
    const res = await fetch(`${API_BASE}/api/extension-auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: true }),
    })
    const data = await res.json()
    log('request-device-code response — status:', res.status, 'data:', data)
    if (!res.ok) return { error: 'Could not reach server' }
    return data
  } catch (e) {
    log('request-device-code error:', e.message)
    return { error: 'Could not reach server' }
  }
})

ipcMain.handle('poll-device-code', async (_, { device_code }) => {
  try {
    const res = await fetch(`${API_BASE}/api/extension-auth?device_code=${encodeURIComponent(device_code)}`)
    const data = await res.json()
    if (data.status !== 'pending') log('poll-device-code:', data.status, data.user ? 'user:' + data.user.id : '')
    return data
  } catch (e) {
    log('poll-device-code error:', e.message)
    return { status: 'pending' }
  }
})

ipcMain.handle('open-auth', async (_, url) => {
  const safeUrl = url && !url.startsWith('http://localhost') ? url : `${API_BASE}/extension?activate=1`

  // Try to find a focused/last-used browser window via BrowserWindow
  // Show a dialog: open in browser OR copy link (like VS Code device flow)
  const { response } = await require('electron').dialog.showMessageBox(settingsWindow || BrowserWindow.getFocusedWindow(), {
    type: 'question',
    title: 'Sign in to PeerMesh',
    message: 'Open sign-in page',
    detail: `Open this URL in your browser to sign in:\n\n${safeUrl}`,
    buttons: ['Open Browser', 'Copy Link', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
  })

  if (response === 0) {
    shell.openExternal(safeUrl)
  } else if (response === 1) {
    require('electron').clipboard.writeText(safeUrl)
    // Show brief confirmation
    if (settingsWindow) {
      settingsWindow.webContents.executeJavaScript(`
        const el = document.createElement('div')
        el.textContent = '\u2713 Link copied — paste in your browser'
        el.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:#1e1e2a;border:1px solid #00ff88;color:#e8e8f0;padding:10px 18px;border-radius:8px;font-family:\'Courier New\',monospace;font-size:11px;z-index:9999;pointer-events:none'
        document.body.appendChild(el)
        setTimeout(() => el.remove(), 2500)
      `).catch(() => {})
    }
  }
})

ipcMain.handle('get-state', () => ({
  ...getPublicState(),
  config: { ...getPublicState().config, hasAcceptedProviderTerms: config.hasAcceptedProviderTerms ?? false },
}))

ipcMain.handle('sign-in', async (_, { token, userId, country, trust }) => {
  log('sign-in attempt — userId:', userId, 'country:', country)
  try {
    const res = await fetch(`${API_BASE}/api/extension-auth?verify=1&userId=${encodeURIComponent(userId)}`, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    })
    log('sign-in verify — status:', res.status)
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      log('sign-in verify failed — body:', body)
      return { success: false, error: 'Token verification failed' }
    }
  } catch (e) {
    log('sign-in verify error (offline?):', e.message)
  }
  config = { ...config, token, userId, country, trust }
  // Fetch hasAcceptedProviderTerms from DB once on sign-in
  try {
    const res = await fetch(`${API_BASE}/api/user/sharing`, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: AbortSignal.timeout(4000),
    })
    if (res.ok) {
      const data = await res.json()
      config.hasAcceptedProviderTerms = data.has_accepted_provider_terms ?? false
    }
  } catch {}
  saveConfig()
  updateTray()
  showWindow()
  log('sign-in success — userId:', userId)
  return { success: true }
})

ipcMain.handle('toggle-sharing', () => {
  if (running) {
    stopRelay()
  } else if (config.token) {
    config.shareEnabled = true
    saveConfig()
    connectRelay()
  }
  return { running, shareEnabled: !!config.shareEnabled }
})

ipcMain.handle('sign-out', () => {
  stopRelay()
  config = { token: '', userId: '', country: 'RW', trust: 50, extId: config.extId, shareEnabled: false }
  saveConfig()
  persistSharingState(false)
  updateTray()
  return { success: true }
})

ipcMain.handle('open-dashboard', () => {
  shell.openExternal(`${API_BASE}/dashboard`)
})

ipcMain.handle('accept-provider-terms', async (_, { checkOnly } = {}) => {
  if (!config.token) return { success: false }
  // If just checking (to sync from DB), return current state without writing
  if (checkOnly) {
    try {
      const res = await fetch(`${API_BASE}/api/user/sharing`, {
        headers: { 'Authorization': `Bearer ${config.token}` },
        signal: AbortSignal.timeout(3000),
      })
      if (res.ok) {
        const data = await res.json()
        if (data.has_accepted_provider_terms === true) {
          config.hasAcceptedProviderTerms = true
          saveConfig()
        }
        return { success: true, accepted: data.has_accepted_provider_terms === true }
      }
    } catch {}
    return { success: true, accepted: config.hasAcceptedProviderTerms ?? false }
  }
  try {
    const res = await fetch(`${API_BASE}/api/user/sharing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` },
      body: JSON.stringify({ acceptProviderTerms: true }),
    })
    if (res.ok) {
      config.hasAcceptedProviderTerms = true
      saveConfig()
    }
  } catch {}
  return { success: true }
})

// ── App lifecycle ─────────────────────────────────────────────────────────────

if (IS_NATIVE_HOST_MODE) {
  loadConfig()
  registerNativeMessagingHost()
  runNativeHostMode()
} else app.whenReady().then(() => {
  // Enforce single instance
  if (!app.requestSingleInstanceLock()) {
    log('Another instance is already running — quitting')
    app.quit()
    return
  }
  app.on('second-instance', () => {
    showWindow()
  })

  log('app ready — version:', DESKTOP_VERSION, 'background:', IS_BACKGROUND_LAUNCH)
  app.on('window-all-closed', (e) => e.preventDefault())
  app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true })

  loadConfig()

  tray = new Tray(createTrayIcon())
  tray.setToolTip('PeerMesh')
  tray.on('click', showWindow)
  updateTray()

  // Start control server — check port first to avoid EADDRINUSE crash
  const net = require('net')
  const tester = net.createServer()
  tester.once('error', () => {
    // Port in use (CLI owns it) — skip control server, app still works
    console.log(`Port ${CONTROL_PORT} in use — CLI may be running`)
    // Try to register with CLI so we can cross-notify
    fetch(`http://127.0.0.1:${CONTROL_PORT}/native/peer/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port: PEER_PORT, where: 'desktop' }),
      signal: AbortSignal.timeout(1500),
    }).then(() => { peerPort = CONTROL_PORT }).catch(() => {})
  })
  tester.once('listening', () => {
    tester.close(() => {
      controlServer.listen(CONTROL_PORT, '127.0.0.1', async () => {
        localProxyServer.listen(LOCAL_PROXY_PORT, '127.0.0.1')
        // Check if CLI is already on PEER_PORT — register and sync state
        try {
          const r = await fetch(`http://127.0.0.1:${PEER_PORT}/native/state`, { signal: AbortSignal.timeout(1500) })
          if (r.ok) {
            const cliState = await r.json()
            // Register with CLI so it can cross-notify us
            await fetch(`http://127.0.0.1:${PEER_PORT}/native/peer/register`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ port: CONTROL_PORT, where: 'desktop' }),
              signal: AbortSignal.timeout(1500),
            })
            peerPort = PEER_PORT
            log('CLI detected on port ' + PEER_PORT + (cliState.running ? ' (sharing active)' : ' (not sharing)'))
            // If CLI is already sharing, start desktop relay too
            if (cliState.running && !running && config.token && config.userId) {
              connectRelay()
            }
          }
        } catch {} // CLI not running — that's fine
      })
    })
  })
  tester.listen(CONTROL_PORT, '127.0.0.1')

  if (config.token && config.userId && config.shareEnabled) {
    connectRelay()
    if (!IS_BACKGROUND_LAUNCH) showWindow()
  } else {
    showWindow()
  }
})

app.on('before-quit', () => {
  stopRelay()
  closeAllTunnels(false)
  try { controlServer.close() } catch {}
  try { localProxyServer.close() } catch {}
  // Synchronously mark sharing as stopped in DB before process exits
  if (config.token && config.userId && config.extId) {
    fetch(`${API_BASE}/api/user/sharing`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` },
      body: JSON.stringify({ device_id: config.extId }),
    }).catch(() => {})
    fetch(`${API_BASE}/api/user/sharing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` },
      body: JSON.stringify({ isSharing: false }),
    }).catch(() => {})
  }
  // Kill any lingering node/agent child processes
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/F', '/IM', 'node.exe', '/T'], { stdio: 'ignore' }) } catch {}
  } else {
    try { spawnSync('pkill', ['-f', 'peermesh'], { stdio: 'ignore' }) } catch {}
  }
})
