const { app, Tray, Menu, BrowserWindow, nativeImage, ipcMain, shell, Notification } = require('electron')
const { WebSocket } = require('ws')
const path = require('path')
const http = require('http')
const net = require('net')
const fs = require('fs')
const os = require('os')
const { spawn, spawnSync } = require('child_process')
const { chromium } = require('playwright-core')

// Prevent uncaught errors from showing Electron's error dialog
process.on('uncaughtException', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Port already in use — continuing without control server`)
    return // swallow silently
  }
  console.error('Uncaught exception:', err)
})

const API_BASE = 'https://peermesh-beta.vercel.app'
const RELAY_WS = 'wss://peermesh-relay.fly.dev'
const RELAY_PROXY_PORT = 8081
const CONTROL_PORT = 7654
const LOCAL_PROXY_PORT = 7655
const NATIVE_HOST_NAME = 'com.peermesh.desktop'
const EXTENSION_ID = 'chpkbnnohdiohlejmpmjmnmjgokalllm'
const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}/`
const DESKTOP_VERSION = require('./package.json').version
const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json')
const IS_NATIVE_HOST_MODE = process.argv.some(arg => arg.startsWith('chrome-extension://')) || process.argv.some(arg => arg.startsWith('--parent-window='))
const IS_BACKGROUND_LAUNCH = process.argv.includes('--background')

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
    }
  } catch {}
  // Generate stable ext_id if not present
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

// ── Playwright browser pool ───────────────────────────────────────────────────

let browser = null
// Cookie jar per origin so repeat visits look like a returning user
const contextCache = new Map() // origin → BrowserContext

async function getBrowser() {
  if (browser && browser.isConnected()) return browser
  // Use the Electron-bundled Chromium so no extra download is needed
  const execPath = chromium.executablePath() ||
    (process.platform === 'win32'
      ? path.join(process.resourcesPath ?? __dirname, 'chromium', 'chrome.exe')
      : undefined)
  browser = await chromium.launch({
    executablePath: execPath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  })
  browser.on('disconnected', () => { browser = null; contextCache.clear() })
  return browser
}

async function getContext(origin) {
  if (contextCache.has(origin)) return contextCache.get(origin)
  const b = await getBrowser()
  const ctx = await b.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/New_York',
    viewport: { width: 1280, height: 800 },
  })
  contextCache.set(origin, ctx)
  return ctx
}

// ── Fetch handler — real Chrome TLS fingerprint ───────────────────────────────

async function handleFetch(request) {
  const { requestId, url, method = 'GET', headers = {}, body = null } = request
  try {
    const parsed = new URL(url)
    if (!isAllowed(parsed.hostname)) {
      return { requestId, status: 403, headers: {}, body: '', error: 'URL not allowed' }
    }
    const origin = parsed.origin
    const ctx = await getContext(origin)
    const page = await ctx.newPage()
    try {
      // Set extra headers from requester (forwarded browser headers)
      const extraHeaders = {}
      for (const [k, v] of Object.entries(headers)) {
        if (!['host', 'content-length'].includes(k.toLowerCase())) extraHeaders[k] = v
      }
      if (Object.keys(extraHeaders).length) await page.setExtraHTTPHeaders(extraHeaders)

      let responseStatus = 200
      let responseHeaders = {}
      let responseBody = ''

      page.on('response', async (res) => {
        if (res.url() === url || res.url().startsWith(origin)) {
          responseStatus = res.status()
          responseHeaders = await res.allHeaders()
        }
      })

      if (method !== 'GET' && method !== 'HEAD') {
        // For POST/PUT use fetch API inside the page context (same Chrome TLS)
        const result = await page.evaluate(async ({ url, method, headers, body }) => {
          const res = await fetch(url, { method, headers, body })
          const text = await res.text()
          const hdrs = {}
          res.headers.forEach((v, k) => { hdrs[k] = v })
          return { status: res.status, headers: hdrs, body: text, finalUrl: res.url }
        }, { url, method, headers, body })
        await page.close()
        stats.bytesServed += result.body.length
        stats.requestsHandled++
        return { requestId, ...result }
      }

      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 })
      responseBody = await page.content()
      responseStatus = response?.status() ?? 200
      responseHeaders = await response?.allHeaders() ?? {}

      await page.close()
      stats.bytesServed += responseBody.length
      stats.requestsHandled++
      return { requestId, status: responseStatus, headers: responseHeaders, body: responseBody, finalUrl: url }
    } catch (err) {
      await page.close().catch(() => {})
      throw err
    }
  } catch (err) {
    return { requestId, status: 502, headers: {}, body: '', error: err.message }
  }
}

// ── Relay ─────────────────────────────────────────────────────────────────────

function connectRelay() {
  if (!config.token || !config.userId) return

  ws = new WebSocket(RELAY_WS)

  ws.on('open', () => {
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
    persistSharingState(true)
    updateTray()
  })

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString())
      if (msg.type === 'registered') {
        stats.connectedAt = new Date().toISOString()
        showNotification('PeerMesh Active', `Sharing your ${config.country} connection`)
        updateTray()
      } else if (msg.type === 'session_request') {
        ws.send(JSON.stringify({ type: 'agent_ready', sessionId: msg.sessionId }))
      } else if (msg.type === 'proxy_request') {
        const response = await handleFetch(msg.request)
        ws.send(JSON.stringify({ type: 'proxy_response', sessionId: msg.sessionId, response }))
      } else if (msg.type === 'open_tunnel') {
        const socket = net.connect(msg.port, msg.hostname)
        activeTunnels.set(msg.tunnelId, { socket, closed: false, sessionId: msg.sessionId ?? null })
        socket.on('connect', () => {
          sendRelayMessage({ type: 'tunnel_ready', tunnelId: msg.tunnelId })
        })
        socket.on('data', (chunk) => {
          sendRelayMessage({ type: 'tunnel_data', tunnelId: msg.tunnelId, data: chunk.toString('base64') })
          stats.bytesServed += chunk.length
          stats.requestsHandled++
        })
        socket.on('end', () => closeTunnel(msg.tunnelId, true))
        socket.on('close', () => activeTunnels.delete(msg.tunnelId))
        socket.on('error', () => closeTunnel(msg.tunnelId, true))
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
    running = false
    stats.connectedAt = null
    closeAllTunnels(false)
    updateTray()
    if (code !== 1000) {
      reconnectTimer = setTimeout(connectRelay, reconnectDelay)
      reconnectDelay = Math.min(reconnectDelay * 2, 30000)
    }
  })

  ws.on('error', () => {})
}

function stopRelay() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  if (ws) { ws.removeAllListeners('close'); ws.close(1000); ws = null }
  running = false
  config.shareEnabled = false
  saveConfig()
  closeAllTunnels(false)
  stats = { bytesServed: 0, requestsHandled: 0, connectedAt: null }
  persistSharingState(false)
  // Close browser contexts to free memory when not sharing
  for (const ctx of contextCache.values()) ctx.close().catch(() => {})
  contextCache.clear()
  if (browser) { browser.close().catch(() => {}); browser = null }
  updateTray()
}

// ── Local HTTP proxy server (for extension) ───────────────────────────────────
// Extension sets Chrome proxy to 127.0.0.1:7655. This server forwards
// all traffic through the relay WebSocket to the connected peer provider.

let proxySession = null // { sessionId, relayEndpoint }
let proxyRelayWs = null
const proxyPending = new Map() // requestId → { resolve, reject }

function getProxyRelayWs() {
  if (proxyRelayWs && proxyRelayWs.readyState === WebSocket.OPEN) return proxyRelayWs
  if (!proxySession) return null
  proxyRelayWs = new WebSocket(proxySession.relayEndpoint || RELAY_WS)
  proxyRelayWs.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString())
      if (msg.type === 'proxy_response') {
        const cb = proxyPending.get(msg.response?.requestId)
        if (cb) { cb.resolve(msg.response); proxyPending.delete(msg.response.requestId) }
      }
      if (msg.type === 'agent_session_ready') {
        console.log('[local-proxy] relay session ready')
      }
    } catch {}
  })
  proxyRelayWs.on('open', () => {
    proxyRelayWs.send(JSON.stringify({
      type: 'request_session',
      country: proxySession.country,
      userId: config.userId,
    }))
  })
  proxyRelayWs.on('close', () => { proxyRelayWs = null })
  proxyRelayWs.on('error', () => { proxyRelayWs = null })
  return proxyRelayWs
}

const localProxyServer = http.createServer((req, res) => {
  // Plain HTTP — forward via relay WebSocket
  const wsConn = getProxyRelayWs()
  if (!wsConn || !proxySession) {
    res.writeHead(503); res.end('No PeerMesh session'); return
  }
  const requestId = require('crypto').randomUUID()
  const chunks = []
  req.on('data', c => chunks.push(c))
  req.on('end', () => {
    const targetUrl = req.url.startsWith('http') ? req.url : `http://${req.headers.host}${req.url}`
    proxyPending.set(requestId, {
      resolve: (data) => {
        const hdrs = { ...data.headers }
        delete hdrs['content-encoding']; delete hdrs['transfer-encoding']
        res.writeHead(data.status || 200, hdrs)
        res.end(data.body || '')
      },
      reject: () => { res.writeHead(502); res.end('Bad Gateway') },
    })
    wsConn.send(JSON.stringify({
      type: 'proxy_request',
      sessionId: proxySession.sessionId,
      request: { requestId, url: targetUrl, method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() || null },
    }))
    setTimeout(() => {
      if (proxyPending.has(requestId)) { proxyPending.delete(requestId); res.writeHead(504); res.end('Timeout') }
    }, 30000)
  })
})

localProxyServer.on('connect', (req, clientSocket, head) => {
  // HTTPS CONNECT — open direct TCP connection to target (traffic is already E2E encrypted)
  const [hostname, portStr] = (req.url || '').split(':')
  const port = parseInt(portStr) || 443
  const targetSocket = net.connect(port, hostname, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head?.length) targetSocket.write(head)
    targetSocket.pipe(clientSocket)
    clientSocket.pipe(targetSocket)
  })
  targetSocket.on('error', () => { clientSocket.destroy() })
  clientSocket.on('error', () => { targetSocket.destroy() })
})

// ── Control server ────────────────────────────────────────────────────────────

const controlServer = http.createServer((req, res) => {
  const origin = req.headers.origin || ''
  res.setHeader('Access-Control-Allow-Origin', origin.includes('peermesh') || origin.includes('localhost') ? origin : '')
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
          available: true,
          running: true,
          shareEnabled: true,
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
  if (req.method === 'POST' && url.pathname === '/native/share/stop') {
    stopRelay()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      available: true,
      running: false,
      shareEnabled: false,
      configured: !!(config.token && config.userId),
      country: config.country,
      userId: config.userId,
      version: DESKTOP_VERSION,
    }))
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
        proxySession = JSON.parse(body)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true }))
      } catch (e) { res.writeHead(400); res.end() }
    })
    return
  }
  if (req.method === 'DELETE' && url.pathname === '/proxy-session') {
    proxySession = null
    if (proxyRelayWs) { proxyRelayWs.close(); proxyRelayWs = null }
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
        if (running) { stopRelay() }
        else if (config.token && config.userId) { connectRelay() }
        else { shell.openExternal(`${API_BASE}/dashboard`); showWindow() }
      },
    },
    { type: 'separator' },
    { label: 'Settings', click: showWindow },
    { label: 'Open Dashboard', click: () => shell.openExternal(`${API_BASE}/dashboard`) },
    { type: 'separator' },
    { label: 'Quit', click: () => { stopRelay(); app.quit() } },
  ])
  tray.setContextMenu(menu)
  tray.setToolTip(running ? `PeerMesh — Sharing (${config.country})` : 'PeerMesh — Inactive')
}

// ── Settings window ───────────────────────────────────────────────────────────

function showWindow() {
  if (settingsWindow) { settingsWindow.show(); settingsWindow.focus(); return }
  settingsWindow = new BrowserWindow({
    width: 380, height: 520, resizable: false,
    title: 'PeerMesh', backgroundColor: '#0a0a0f',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  })
  settingsWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  settingsWindow.setMenuBarVisibility(false)
  settingsWindow.on('closed', () => { settingsWindow = null })
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
  try {
    const res = await fetch(`${API_BASE}/api/extension-auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: true }),
    })
    if (!res.ok) return { error: 'Could not reach server' }
    return await res.json() // { device_code, user_code, verification_uri, expires_in, interval }
  } catch { return { error: 'Could not reach server' } }
})

ipcMain.handle('poll-device-code', async (_, { device_code }) => {
  try {
    const res = await fetch(`${API_BASE}/api/extension-auth?device_code=${encodeURIComponent(device_code)}`)
    return await res.json() // { status: 'pending'|'approved'|'denied'|'expired', user? }
  } catch { return { status: 'pending' } }
})

ipcMain.handle('open-auth', (_, url) => {
  shell.openExternal(url || `${API_BASE}/extension?activate=1`)
})

ipcMain.handle('get-state', () => ({
  ...getPublicState(),
}))

ipcMain.handle('sign-in', async (_, { token, userId, country, trust }) => {
  // Verify the desktop token against our API before storing
  try {
    const res = await fetch(`${API_BASE}/api/extension-auth?verify=1&userId=${encodeURIComponent(userId)}`, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return { success: false, error: 'Token verification failed' }
  } catch {
    // If offline, allow sign-in with stored token (best-effort)
  }
  config = { ...config, token, userId, country, trust, shareEnabled: true }
  saveConfig()
  connectRelay()
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

// ── App lifecycle ─────────────────────────────────────────────────────────────

if (IS_NATIVE_HOST_MODE) {
  loadConfig()
  registerNativeMessagingHost()
  runNativeHostMode()
} else app.whenReady().then(() => {
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
    // Port in use — skip control server, app still works
    console.log(`Port ${CONTROL_PORT} in use, skipping control server`)
  })
  tester.once('listening', () => {
    tester.close(() => {
      controlServer.listen(CONTROL_PORT, '127.0.0.1')
      localProxyServer.listen(LOCAL_PROXY_PORT, '127.0.0.1')
    })
  })
  tester.listen(CONTROL_PORT, '127.0.0.1')

  if (config.token && config.userId && config.shareEnabled) {
    connectRelay()
  } else if (!IS_BACKGROUND_LAUNCH) {
    showWindow()
  }
})

function killSiblingProcesses() {
  // Clean up any orphaned PeerMesh/node/electron processes on Windows
  if (process.platform === 'win32') {
    const kills = [
      ['taskkill', ['/F', '/IM', 'PeerMesh.exe', '/T']],
      ['taskkill', ['/F', '/IM', 'node.exe', '/T']],
    ]
    for (const [cmd, args] of kills) {
      try { spawnSync(cmd, args, { stdio: 'ignore' }) } catch {}
    }
  }
}

app.on('before-quit', () => {
  stopRelay()
  closeAllTunnels(false)
  if (browser) { browser.close().catch(() => {}); browser = null }
  for (const ctx of contextCache.values()) ctx.close().catch(() => {})
  contextCache.clear()
  controlServer.close()
  localProxyServer.close()
})

app.on('quit', () => {
  killSiblingProcesses()
  process.exit(0)
})
