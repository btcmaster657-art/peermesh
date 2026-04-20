const { app, Tray, Menu, BrowserWindow, nativeImage, ipcMain, shell, Notification } = require('electron')
const { WebSocket } = require('ws')
const path = require('path')
const http = require('http')
const net = require('net')
const fs = require('fs')
const os = require('os')
const { spawn, spawnSync } = require('child_process')

// â”€â”€ Logger â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const LOG_FILE = path.join(os.homedir(), 'Desktop', 'peermesh-debug.log')

// Structured logger â€” always writes to file, always to console
// Format: [ISO_TIMESTAMP] [DESKTOP] [LEVEL] [CATEGORY] message | ctx={}
function _write(level, category, message, ctx) {
  const ts = new Date().toISOString()
  const ctxStr = ctx && Object.keys(ctx).length ? ' | ' + Object.entries(ctx).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ') : ''
  const line = `[${ts}] [DESKTOP] [${level.padEnd(5)}] [${category.padEnd(12)}] ${message}${ctxStr}`
  console.log(line)
  try { fs.appendFileSync(LOG_FILE, line + '\n') } catch {}
}

const log = {
  info:  (cat, msg, ctx) => _write('INFO',  cat, msg, ctx),
  warn:  (cat, msg, ctx) => _write('WARN',  cat, msg, ctx),
  error: (cat, msg, ctx) => _write('ERROR', cat, msg, ctx),
  debug: (cat, msg, ctx) => _write('DEBUG', cat, msg, ctx),
  // legacy single-arg form used by older call sites
  plain: (msg, level = 'info') => _write(level.toUpperCase().padEnd(5), 'GENERAL', msg, null),
}

// Backwards-compat shim so existing `log('msg')` calls still work
function legacyLog(...args) {
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')
  _write('INFO', 'GENERAL', msg, null)
}
// Named aliases used throughout the file
const logState = (label) => {
  const activeSlots = slotStates.filter(slot => slot.running).length
  _write('DEBUG', 'STATE', `[${label}]`, {
    running: activeSlots > 0,
    shareEnabled: config.shareEnabled,
    peerSharing,
    peerPort,
    configuredSlots: config.connectionSlots ?? 1,
    activeSlots,
    wsStates: slotStates.map(slot => `${slot.index}:${slot.ws ? slot.ws.readyState : 'null'}`).join(','),
    tunnels: activeTunnels.size,
  })
}

const logRequest  = (method, url, body) => _write('INFO',  'HTTP-OUT', `â†’ ${method} ${url}`, body ? { body } : undefined)
const logResponse = (method, url, status, body) => _write('INFO',  'HTTP-IN',  `â† ${status} ${method} ${url}`, body ? { body } : undefined)
const logRelay    = (direction, type, ctx) => _write('DEBUG', 'RELAY',    `${direction} ${type}`, ctx)
const logTunnel   = (event, tunnelId, ctx) => _write('DEBUG', 'TUNNEL',   `${event} tunnel=${tunnelId?.slice(0,8)}`, ctx)
const logIpc      = (channel, ctx) => _write('DEBUG', 'IPC',      channel, ctx)
const logControl  = (method, path, ctx) => _write('INFO',  'CONTROL',  `${method} ${path}`, ctx)

// Prevent uncaught errors from showing Electron's error dialog
process.on('uncaughtException', (err) => {
  _write('ERROR', 'PROCESS', 'uncaughtException', { message: err.message, stack: err.stack })
  if (err.code === 'EADDRINUSE') return
})

const API_BASE = 'https://peermesh-beta.vercel.app'
const RELAY_WS = 'wss://peermesh-relay.fly.dev'
const RELAY_PROXY_PORT = 8081
const CONTROL_PORT = 7654
const LOCAL_PROXY_PORT = 7655
const PEER_PORT = 7656
const NATIVE_HOST_NAME = 'com.peermesh.desktop'
const EXTENSION_ID = 'chpkbnnohdiohlejmpmjmnmjgokalllm'
const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}/`
const DESKTOP_VERSION = require('./package.json').version
const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json')
const IS_NATIVE_HOST_MODE = process.argv.some(arg => arg.startsWith('chrome-extension://')) || process.argv.some(arg => arg.startsWith('--parent-window='))
const IS_BACKGROUND_LAUNCH = process.argv.includes('--background')

let peerPort = null
let peerSharing = false
let _sharingToggleBusy = false
let _cliWatchTimer = null

function notifyPeer(p, body) {
  if (!peerPort) return
  log.info('PEER', `notifyPeer â†’ ${p}`, { port: peerPort })
  const init = { method: 'POST', signal: AbortSignal.timeout(1500) }
  if (body) { init.headers = { 'Content-Type': 'application/json' }; init.body = JSON.stringify(body) }
  fetch(`http://127.0.0.1:${peerPort}${p}`, init)
    .then(() => log.debug('PEER', `notifyPeer OK ${p}`))
    .catch(e => log.warn('PEER', `notifyPeer failed ${p}`, { err: e.message }))
}

let tray = null
let settingsWindow = null
let running = false
let config = { token: '', userId: '', country: 'RW', trust: 50, extId: '', baseDeviceId: '', shareEnabled: false, connectionSlots: 1, todaySharedBytes: 0, todaySharedBytesDate: null, dailyShareLimitMb: null }
let stats = { bytesServed: 0, requestsHandled: 0, connectedAt: null }
const activeTunnels = new Map()
const SLOT_CAP = 32
let slotStates = []
let _userStopped = false
let limitHit = false

function clampSlots(value) {
  const parsed = parseInt(value, 10)
  if (!Number.isInteger(parsed)) return 1
  return Math.max(1, Math.min(SLOT_CAP, parsed))
}

function slotPrefix(slot) {
  return `[slot-${slot.index}]`
}

function createSlotState(index) {
  return {
    index,
    deviceId: `${config.baseDeviceId}_slot_${index}`,
    ws: null,
    running: false,
    reconnectTimer: null,
    reconnectDelay: 2000,
    heartbeatTimer: null,
    sessionBytes: 0,
    requestsHandled: 0,
    connectedAt: null,
    activeTunnels: new Map(),
  }
}

function ensureSlotStates() {
  const desired = clampSlots(config.connectionSlots ?? 1)
  while (slotStates.length < desired) slotStates.push(createSlotState(slotStates.length))
  if (slotStates.length > desired) slotStates = slotStates.slice(0, desired)
  for (const slot of slotStates) slot.deviceId = `${config.baseDeviceId}_slot_${slot.index}`
  return slotStates
}

function activeSlotCount() {
  return slotStates.filter(slot => slot.running).length
}

function getAggregateStats() {
  return slotStates.reduce((acc, slot) => {
    acc.bytesServed += slot.sessionBytes
    acc.requestsHandled += slot.requestsHandled
    return acc
  }, { bytesServed: 0, requestsHandled: 0 })
}

function getSlotSummary() {
  return slotStates.map(slot => ({
    index: slot.index,
    deviceId: slot.deviceId,
    running: slot.running,
    requestsHandled: slot.requestsHandled,
    bytesServed: slot.sessionBytes,
    connectedAt: slot.connectedAt,
  }))
}

function syncAggregateState() {
  const aggregate = getAggregateStats()
  running = activeSlotCount() > 0
  stats = {
    bytesServed: aggregate.bytesServed,
    requestsHandled: aggregate.requestsHandled,
    connectedAt: slotStates.find(slot => slot.connectedAt)?.connectedAt ?? null,
  }
}

function getSlotWarning(slots) {
  if (slots > 16) return 'Very high resource usage - recommended for servers or dedicated machines only.'
  if (slots > 8) return 'High resource usage - ensure a stable connection.'
  return null
}

function syncTodaySharedBytesDay() {
  const today = new Date().toISOString().slice(0, 10)
  if (config.todaySharedBytesDate !== today) {
    config.todaySharedBytesDate = today
    config.todaySharedBytes = 0
    limitHit = false
  }
}

function getDailyLimitBytes() {
  if (config.dailyShareLimitMb == null) return null
  return config.dailyShareLimitMb * 1024 * 1024
}

function enforceLocalLimit() {
  syncTodaySharedBytesDay()
  const limitBytes = getDailyLimitBytes()
  if (!limitBytes || limitHit || config.todaySharedBytes == null) return
  const totalToday = (config.todaySharedBytes ?? 0) + getAggregateStats().bytesServed
  if (totalToday < limitBytes) return

  limitHit = true
  log.warn('LIMIT', 'daily limit reached', { totalToday, limitBytes })
  showNotification('PeerMesh paused', `Daily share limit reached (${formatBytes(limitBytes)})`)
  stopRelay()
}

async function pollTodayBytes() {
  if (!config.token) return null
  syncTodaySharedBytesDay()
  logRequest('GET', `${API_BASE}/api/user/sharing`)
  try {
    const res = await fetch(`${API_BASE}/api/user/sharing${config.baseDeviceId ? `?baseDeviceId=${encodeURIComponent(config.baseDeviceId)}` : ''}`, {
      headers: { Authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(4000),
    })
    logResponse('GET', `${API_BASE}/api/user/sharing`, res.status)
    if (!res.ok) return null
    const data = await res.json()
    config.todaySharedBytes = data.total_bytes_today ?? 0
    config.todaySharedBytesDate = new Date().toISOString().slice(0, 10)
    config.dailyShareLimitMb = data.daily_share_limit_mb ?? null
    config.privateShareActive = !!(data.private_share?.enabled && data.private_share?.active)
    limitHit = data.daily_limit_bytes == null
      ? false
      : ((config.todaySharedBytes ?? 0) + getAggregateStats().bytesServed) >= data.daily_limit_bytes
    saveConfig()
    if (limitHit && config.shareEnabled) enforceLocalLimit()
    return data
  } catch (e) {
    log.warn('API', 'pollTodayBytes failed', { err: e.message })
    return null
  }
}

function sendRelayMessage(slot, data) {
  if (slot.ws?.readyState === WebSocket.OPEN) slot.ws.send(JSON.stringify(data))
}

function closeTunnel(slot, tunnelId, notifyRelay = false) {
  const tunnel = slot.activeTunnels.get(tunnelId)
  if (!tunnel || tunnel.closed) return
  tunnel.closed = true
  slot.activeTunnels.delete(tunnelId)
  activeTunnels.delete(tunnelId)
  if (notifyRelay) sendRelayMessage(slot, { type: 'tunnel_close', tunnelId })
  if (!tunnel.socket.destroyed) tunnel.socket.destroy()
  syncAggregateState()
  logTunnel('CLOSED', tunnelId, { notifyRelay, remaining: activeTunnels.size, slot: slot.index })
}

function closeAllTunnels(slot, notifyRelay = false) {
  const count = slot.activeTunnels.size
  for (const tunnelId of [...slot.activeTunnels.keys()]) closeTunnel(slot, tunnelId, notifyRelay)
  if (count > 0) log.info('TUNNEL', `closeAllTunnels â€” closed ${count} tunnels`)
}

// â”€â”€ Config â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) }
      log.info('CONFIG', 'loaded', { userId: config.userId || '(none)', shareEnabled: config.shareEnabled, country: config.country })
    } else {
      log.warn('CONFIG', 'no config file found', { path: CONFIG_FILE })
    }
  } catch (e) { log.error('CONFIG', 'loadConfig error', { err: e.message }) }
  if (!config.extId) {
    config.extId = require('crypto').randomUUID()
    log.info('CONFIG', 'generated new extId', { extId: config.extId })
  }
  if (!config.baseDeviceId) config.baseDeviceId = config.extId
  config.connectionSlots = clampSlots(config.connectionSlots ?? 1)
  ensureSlotStates()
  saveConfig()
}

function saveConfig() {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config)) } catch {}
}

function getPublicState() {
  syncAggregateState()
  return {
    running,
    shareEnabled: !!config.shareEnabled,
    config: { ...config, token: config.token ? '***' : '' },
    baseDeviceId: config.baseDeviceId || null,
    connectionSlots: clampSlots(config.connectionSlots ?? 1),
    privateShareActive: !!(config.privateShareActive),
    slots: {
      configured: clampSlots(config.connectionSlots ?? 1),
      active: activeSlotCount(),
      statuses: getSlotSummary(),
      warning: getSlotWarning(clampSlots(config.connectionSlots ?? 1)),
    },
    stats,
    version: DESKTOP_VERSION,
  }
}

async function persistSharingState(isSharing) {
  if (!config.token) return
  logRequest('POST', `${API_BASE}/api/user/sharing`, { isSharing })
  try {
    const r = await fetch(`${API_BASE}/api/user/sharing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` },
      body: JSON.stringify({ isSharing }),
    })
    logResponse('POST', `${API_BASE}/api/user/sharing`, r.status)
  } catch (e) { log.warn('API', 'persistSharingState failed', { err: e.message }) }
}

function getNativeHostManifestPath() {
  if (process.platform === 'win32') return path.join(app.getPath('userData'), 'native-messaging', `${NATIVE_HOST_NAME}.json`)
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts', `${NATIVE_HOST_NAME}.json`)
  return path.join(os.homedir(), '.config', 'google-chrome', 'NativeMessagingHosts', `${NATIVE_HOST_NAME}.json`)
}

function registerNativeMessagingHost() {
  try {
    const manifestPath = getNativeHostManifestPath()
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
    fs.writeFileSync(manifestPath, JSON.stringify({
      name: NATIVE_HOST_NAME, description: 'PeerMesh desktop helper',
      path: process.execPath, type: 'stdio', allowed_origins: [EXTENSION_ORIGIN],
    }, null, 2))
    if (process.platform === 'win32') {
      spawnSync('reg', ['ADD', `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], { stdio: 'ignore' })
    }
    log.info('NATIVE', 'registered native messaging host', { manifestPath })
  } catch (err) { log.error('NATIVE', 'registerNativeMessagingHost failed', { err: err.message }) }
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
  const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore' })
  child.unref()
  log.info('PROCESS', 'launchMainApp â€” spawned background process')
}

async function waitForControlServer(timeoutMs = 15000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${CONTROL_PORT}/native/state`, { signal: AbortSignal.timeout(1500) })
      if (res.ok) { log.info('CONTROL', 'control server ready', { elapsed: Date.now() - started }); return true }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  log.warn('CONTROL', 'waitForControlServer timed out', { timeoutMs })
  return false
}

async function callControl(pathname, { method = 'GET', body } = {}) {
  const init = { method, signal: AbortSignal.timeout(4000), headers: {} }
  if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body) }
  logRequest(method, `localhost:${CONTROL_PORT}${pathname}`, body)
  const res = await fetch(`http://127.0.0.1:${CONTROL_PORT}${pathname}`, init)
  const text = await res.text()
  let data = {}
  try { data = text ? JSON.parse(text) : {} } catch {}
  logResponse(method, `localhost:${CONTROL_PORT}${pathname}`, res.status, data)
  if (!res.ok) throw new Error(data.error || `Control request failed (${res.status})`)
  return data
}

async function getNativeState() {
  try { return await callControl('/native/state') } catch {
    return { available: true, running: false, shareEnabled: false, configured: false, version: DESKTOP_VERSION }
  }
}

async function ensureDesktopApp() {
  try { await callControl('/native/state'); return true } catch {}
  launchMainApp()
  return waitForControlServer()
}

async function handleNativeHostMessage(message) {
  log.info('NATIVE', `nativeHost message: ${message.type}`, { payload: message.payload ? Object.keys(message.payload) : undefined })
  switch (message.type) {
    case 'status': return { success: true, ...(await getNativeState()) }
    case 'sync_auth': { const ok = await ensureDesktopApp(); if (!ok) return { success: false, error: 'Desktop helper did not start' }; return { success: true, ...(await callControl('/native/auth', { method: 'POST', body: message.payload || {} })) } }
    case 'start_sharing': { const ok = await ensureDesktopApp(); if (!ok) return { success: false, error: 'Desktop helper did not start' }; return { success: true, ...(await callControl('/native/share/start', { method: 'POST', body: message.payload || {} })) } }
    case 'stop_sharing': { const ok = await ensureDesktopApp(); if (!ok) return { success: false, error: 'Desktop helper did not start' }; return { success: true, ...(await callControl('/native/share/stop', { method: 'POST' })) } }
    case 'show_app': { const ok = await ensureDesktopApp(); if (!ok) return { success: false, error: 'Desktop helper did not start' }; return { success: true, ...(await callControl('/native/show', { method: 'POST' })) } }
    default: return { success: false, error: 'Unknown native host command' }
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
      } catch (err) { writeNativeMessage({ success: false, error: err.message || 'Native host error' }) }
    }
  })
  process.stdin.on('end', () => process.exit(0))
}

// â”€â”€ Abuse filter â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const BLOCKED = [/\.onion$/i, /^smtp\./i, /^mail\./i, /torrent/i]
const PRIVATE = [
  /^localhost$/i, /^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./,
  /^::1$/, /^fc[0-9a-f]{2}:/i, /^fd[0-9a-f]{2}:/i, /^fe[89ab][0-9a-f]:/i,
]

function isAllowed(hostname) {
  return !BLOCKED.some(p => p.test(hostname)) && !PRIVATE.some(p => p.test(hostname))
}

// â”€â”€ Fetch handler â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function addBytes(slot, bytes) {
  slot.sessionBytes += bytes
  syncAggregateState()
  flushStats(bytes)
  enforceLocalLimit()
}

async function handleFetch(slot, request) {
  const { requestId, url, method = 'GET', headers = {}, body = null } = request
  log.info('PROXY', `${slotPrefix(slot)} fetch request`, { requestId: requestId?.slice(0,8), method, url })
  try {
    const parsed = new URL(url)
    if (!isAllowed(parsed.hostname)) {
      log.warn('PROXY', 'blocked URL', { hostname: parsed.hostname, requestId: requestId?.slice(0,8), slot: slot.index })
      return { requestId, status: 403, headers: {}, body: '', error: 'URL not allowed' }
    }
    // Route through CONNECT tunnel so TLS fingerprint is the browser's, not Node's
    const port = parsed.port ? parseInt(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80)
    const hostname = parsed.hostname
    return await new Promise((resolve) => {
      const tunnelWs = openTunnelWs(hostname, port)
      if (!tunnelWs) { resolve({ requestId, status: 503, headers: {}, body: '', error: 'No proxy session' }); return }
      let responseData = Buffer.alloc(0)
      let ready = false
      const timer = setTimeout(() => { tunnelWs.terminate(); resolve({ requestId, status: 504, headers: {}, body: '', error: 'Timeout' }) }, 20000)
      tunnelWs.on('message', (data) => {
        const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data)
        if (!ready) {
          responseData = Buffer.concat([responseData, chunk])
          const headerEnd = responseData.indexOf('\r\n\r\n')
          if (headerEnd === -1) return
          const firstLine = responseData.slice(0, responseData.indexOf('\r\n')).toString()
          if (!firstLine.includes('200')) { clearTimeout(timer); tunnelWs.close(); resolve({ requestId, status: 502, headers: {}, body: '', error: 'Tunnel rejected' }); return }
          ready = true
          const path = parsed.pathname + parsed.search
          const reqHeaders = Object.entries({ 'Host': hostname, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.5', 'Cache-Control': 'no-cache', 'Connection': 'close', ...headers }).map(([k, v]) => `${k}: ${v}`).join('\r\n')
          const reqBody = body ? Buffer.from(body) : null
          const contentLength = reqBody ? `\r\nContent-Length: ${reqBody.length}` : ''
          tunnelWs.send(Buffer.from(`${method} ${path} HTTP/1.1\r\n${reqHeaders}${contentLength}\r\n\r\n`))
          if (reqBody) tunnelWs.send(reqBody)
          responseData = responseData.slice(headerEnd + 4)
          return
        }
        responseData = Buffer.concat([responseData, chunk])
      })
      tunnelWs.on('close', () => {
        clearTimeout(timer)
        const headerEnd = responseData.indexOf('\r\n\r\n')
        if (headerEnd === -1) { resolve({ requestId, status: 502, headers: {}, body: '', error: 'Bad Gateway' }); return }
        const headerStr = responseData.slice(0, headerEnd).toString()
        const lines = headerStr.split('\r\n')
        const statusMatch = lines[0].match(/HTTP\/\S+ (\d+)/)
        const status = statusMatch ? parseInt(statusMatch[1]) : 200
        const responseHeaders = {}
        for (const line of lines.slice(1)) { const idx = line.indexOf(':'); if (idx > 0) responseHeaders[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim() }
        delete responseHeaders['transfer-encoding']; delete responseHeaders['content-encoding']
        const responseBody = responseData.slice(headerEnd + 4).toString()
        addBytes(slot, responseBody.length)
        log.info('PROXY', `${slotPrefix(slot)} fetch response via tunnel`, { requestId: requestId?.slice(0,8), status, bytes: responseBody.length })
        resolve({ requestId, status, headers: responseHeaders, body: responseBody })
      })
      tunnelWs.on('error', (err) => { clearTimeout(timer); resolve({ requestId, status: 502, headers: {}, body: '', error: err.message }) })
    })
  } catch (err) {
    log.error('PROXY', `${slotPrefix(slot)} fetch error`, { requestId: requestId?.slice(0,8), url, err: err.message })
    return { requestId, status: 502, headers: {}, body: '', error: err.message }
  }
}

// â”€â”€ Relay â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

let heartbeatTimer = null

function stopHeartbeat(slot) {
  if (slot?.heartbeatTimer) { clearInterval(slot.heartbeatTimer); slot.heartbeatTimer = null }
  if (!slot || !config.token || !config.userId) return
  log.debug('HEARTBEAT', 'heartbeat timer stopped', { slot: slot.index })
  logRequest('DELETE', `${API_BASE}/api/user/sharing`, { device_id: slot.deviceId })
  fetch(`${API_BASE}/api/user/sharing`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` },
    body: JSON.stringify({ device_id: slot.deviceId }),
  })
    .then(r => logResponse('DELETE', `${API_BASE}/api/user/sharing`, r.status))
    .catch(e => log.warn('API', 'stopHeartbeat DELETE failed', { err: e.message, slot: slot.index }))
}

function sendHeartbeat(slot) {
  if (!slot || !config.token || !config.userId) return
  logRequest('PUT', `${API_BASE}/api/user/sharing`, { device_id: slot.deviceId })
  fetch(`${API_BASE}/api/user/sharing`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` },
    body: JSON.stringify({ device_id: slot.deviceId }),
  })
    .then(r => { logResponse('PUT', `${API_BASE}/api/user/sharing`, r.status); if (!r.ok) r.json().then(b => log.warn('HEARTBEAT', 'PUT failed', { status: r.status, body: b, slot: slot.index })) })
    .catch(e => log.warn('HEARTBEAT', 'PUT error', { err: e.message, slot: slot.index }))
}

function connectSlot(slot) {
  if (!config.token || !config.userId) return
  if (slot.ws && (slot.ws.readyState === WebSocket.OPEN || slot.ws.readyState === WebSocket.CONNECTING)) return
  log.info('RELAY', `${slotPrefix(slot)} connecting`, { deviceId: slot.deviceId, relay: RELAY_WS })
  slot.ws = new WebSocket(RELAY_WS)

  slot.ws.on('open', () => {
    slot.reconnectDelay = 2000
    if (!config.shareEnabled) {
      log.warn('RELAY', `${slotPrefix(slot)} shareEnabled=false after open`)
      slot.ws.close(1000)
      return
    }
    const reg = {
      type: 'register_provider',
      userId: config.userId,
      country: config.country,
      trustScore: config.trust,
      agentMode: true,
      providerKind: 'desktop',
      supportsHttp: true,
      supportsTunnel: true,
      deviceId: slot.deviceId,
      baseDeviceId: config.baseDeviceId,
    }
    logRelay('SEND', 'register_provider', { slot: slot.index, deviceId: slot.deviceId })
    slot.ws.send(JSON.stringify(reg))
    if (slot.heartbeatTimer) clearInterval(slot.heartbeatTimer)
    slot.heartbeatTimer = setInterval(() => {
      sendHeartbeat(slot)
      if (slot.index === 0) pollTodayBytes()
    }, 30_000)
    sendHeartbeat(slot)
    if (slot.index === 0) pollTodayBytes()
    updateTray()
  })

  slot.ws.on('ping', () => { try { slot.ws.pong() } catch {} })

  slot.ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString())
      if (msg.type === 'tunnel_data' || msg.type === 'proxy_ws_data') {
        log.debug('RELAY', `RECV ${msg.type}`, { slot: slot.index, tunnelId: msg.tunnelId?.slice(0,8), sessionId: msg.sessionId?.slice(0,8), bytes: msg.data?.length })
      } else {
        logRelay('RECV', msg.type, { slot: slot.index, sessionId: msg.sessionId?.slice(0,8), tunnelId: msg.tunnelId?.slice(0,8), message: msg.message, hostname: msg.hostname, port: msg.port })
      }

      if (msg.type === 'registered') {
        slot.running = true
        slot.connectedAt = new Date().toISOString()
        syncAggregateState()
        if (slot.index === 0) {
          persistSharingState(true)
          showNotification('PeerMesh Active', `Sharing your ${config.country} connection`)
        }
        updateTray()
      } else if (msg.type === 'error') {
        log.error('RELAY', `${slotPrefix(slot)} relay error`, { message: msg.message })
        if (msg.message?.includes('Replaced')) {
          slot.ws.removeAllListeners('close')
          slot.ws.close(1000)
          slot.running = false
          slot.connectedAt = null
          syncAggregateState()
          updateTray()
        }
      } else if (msg.type === 'proxy_ws_data') {
        const tunnel = activeTunnels.get(`ws_${msg.sessionId}`)
        if (tunnel?.socket && !tunnel.socket.destroyed) tunnel.socket.write(Buffer.from(msg.data, 'base64'))
      } else if (msg.type === 'proxy_ws_close') {
        const tunnel = activeTunnels.get(`ws_${msg.sessionId}`)
        if (tunnel) { if (!tunnel.socket.destroyed) tunnel.socket.destroy(); activeTunnels.delete(`ws_${msg.sessionId}`) }
      } else if (msg.type === 'session_request') {
        sendRelayMessage(slot, { type: 'agent_ready', sessionId: msg.sessionId })
      } else if (msg.type === 'proxy_request') {
        slot.requestsHandled++
        syncAggregateState()
        const response = await handleFetch(slot, msg.request)
        sendRelayMessage(slot, { type: 'proxy_response', sessionId: msg.sessionId, response })
      } else if (msg.type === 'open_tunnel') {
        slot.requestsHandled++
        syncAggregateState()
        const socket = net.connect(msg.port, msg.hostname)
        const tunnel = { socket, closed: false, sessionId: msg.sessionId ?? null, slotIndex: slot.index }
        slot.activeTunnels.set(msg.tunnelId, tunnel)
        activeTunnels.set(msg.tunnelId, tunnel)
        socket.on('connect', () => sendRelayMessage(slot, { type: 'tunnel_ready', tunnelId: msg.tunnelId }))
        socket.on('data', (chunk) => {
          sendRelayMessage(slot, { type: 'tunnel_data', tunnelId: msg.tunnelId, data: chunk.toString('base64') })
          addBytes(slot, chunk.length)
        })
        socket.on('end', () => closeTunnel(slot, msg.tunnelId, true))
        socket.on('close', () => { slot.activeTunnels.delete(msg.tunnelId); activeTunnels.delete(msg.tunnelId); syncAggregateState() })
        socket.on('error', () => closeTunnel(slot, msg.tunnelId, true))
      } else if (msg.type === 'tunnel_data') {
        const tunnel = slot.activeTunnels.get(msg.tunnelId)
        if (tunnel?.socket && !tunnel.socket.destroyed) tunnel.socket.write(Buffer.from(msg.data, 'base64'))
      } else if (msg.type === 'tunnel_close') {
        closeTunnel(slot, msg.tunnelId, false)
      } else if (msg.type === 'session_ended') {
        closeAllTunnels(slot, false)
        updateTray()
      }
    } catch (e) {
      log.error('RELAY', `${slotPrefix(slot)} message handler exception`, { err: e.message })
    }
  })

  slot.ws.on('close', (code, reason) => {
    slot.running = false
    slot.connectedAt = null
    closeAllTunnels(slot, false)
    slot.ws = null
    syncAggregateState()
    updateTray()
    if (code !== 1000 && !_userStopped && config.shareEnabled) {
      slot.reconnectTimer = setTimeout(() => connectSlot(slot), slot.reconnectDelay)
      slot.reconnectDelay = Math.min(slot.reconnectDelay * 2, 30000)
    } else {
      log.info('RELAY', `${slotPrefix(slot)} no reconnect`, { code, reason: reason?.toString() || '(none)' })
    }
  })

  slot.ws.on('error', (e) => log.error('RELAY', `${slotPrefix(slot)} WebSocket error`, { code: e.code, err: e.message }))
}

function connectRelay() {
  if (!config.token || !config.userId) { log.warn('RELAY', 'connectRelay skipped - no token/userId'); return }
  syncTodaySharedBytesDay()
  if (limitHit) {
    log.warn('RELAY', 'connectRelay skipped - daily limit already reached')
    config.shareEnabled = false
    saveConfig()
    updateTray()
    return
  }
  _userStopped = false
  ensureSlotStates().forEach(slot => connectSlot(slot))
  syncAggregateState()
  log.info('RELAY', 'connectRelay START', { userId: config.userId, country: config.country, relay: RELAY_WS, slots: config.connectionSlots })
  logState('pre-connect')
}

function stopRelay() {
  log.info('RELAY', 'stopRelay called')
  logState('pre-stop')
  _userStopped = true
  config.shareEnabled = false
  saveConfig()
  for (const slot of slotStates) {
    if (slot.reconnectTimer) { clearTimeout(slot.reconnectTimer); slot.reconnectTimer = null }
    stopHeartbeat(slot)
    if (slot.ws) { slot.ws.removeAllListeners('close'); slot.ws.close(1000); slot.ws = null }
    closeAllTunnels(slot, false)
    slot.running = false
    slot.connectedAt = null
    slot.sessionBytes = 0
    slot.requestsHandled = 0
  }
  syncAggregateState()
  persistSharingState(false)
  logState('post-stop')
  updateTray()
}

let proxySession = null

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
    log.warn('LOCAL-PROXY', 'HTTP rejected â€” no session', { url: req.url })
    res.writeHead(503); res.end('No PeerMesh session'); return
  }
  const parsed = new URL(req.url.startsWith('http') ? req.url : `http://${req.headers.host}${req.url}`)
  const hostname = parsed.hostname
  const port = parseInt(parsed.port) || 80
  log.info('LOCAL-PROXY', `HTTP ${req.method}`, { target: `${hostname}:${port}`, url: parsed.href.slice(0, 80) })

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
          log.warn('LOCAL-PROXY', 'HTTP tunnel rejected', { firstLine })
          res.writeHead(502); res.end('Bad Gateway'); tunnelWs.close(); return
        }
        ready = true
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
        const headerEnd = responseData.indexOf('\r\n\r\n')
        if (headerEnd !== -1) {
          const headerStr = responseData.slice(0, headerEnd).toString()
          const lines = headerStr.split('\r\n')
          const statusMatch = lines[0].match(/HTTP\/\S+ (\d+)/)
          const status = statusMatch ? parseInt(statusMatch[1]) : 200
          const hdrs = {}
          for (const line of lines.slice(1)) { const idx = line.indexOf(':'); if (idx > 0) hdrs[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim() }
          delete hdrs['transfer-encoding']; delete hdrs['content-encoding']
          res.writeHead(status, hdrs); res.end(responseData.slice(headerEnd + 4))
          log.info('LOCAL-PROXY', `HTTP response sent`, { status, target: `${hostname}:${port}` })
        } else { res.writeHead(502); res.end('Bad Gateway') }
      } else if (!res.headersSent) { res.writeHead(502); res.end('Bad Gateway') }
    })

    tunnelWs.on('error', (e) => {
      log.error('LOCAL-PROXY', 'HTTP tunnel error', { target: `${hostname}:${port}`, err: e.message })
      if (!res.headersSent) { res.writeHead(502); res.end('Bad Gateway') }
    })

    setTimeout(() => {
      if (!res.headersSent) {
        log.warn('LOCAL-PROXY', 'HTTP timeout', { target: `${hostname}:${port}` })
        tunnelWs.terminate(); res.writeHead(504); res.end('Timeout')
      }
    }, 30000)
  })
})

localProxyServer.on('connect', (req, clientSocket, head) => {
  const [hostname, portStr] = (req.url || '').split(':')
  const port = parseInt(portStr) || 443
  log.info('LOCAL-PROXY', `CONNECT request`, { target: `${hostname}:${port}`, sessionId: proxySession?.sessionId?.slice(0,8) || 'NONE' })

  if (!proxySession?.sessionId) {
    log.warn('LOCAL-PROXY', 'CONNECT rejected â€” no proxySession', { target: `${hostname}:${port}` })
    clientSocket.write('HTTP/1.1 503 No PeerMesh Session\r\n\r\n')
    clientSocket.destroy(); return
  }

  let opened = false
  const tunnelWs = openTunnelWs(hostname, port, () => { opened = true })
  if (!tunnelWs) { clientSocket.write('HTTP/1.1 503 No PeerMesh Session\r\n\r\n'); clientSocket.destroy(); return }
  log.debug('LOCAL-PROXY', 'opening tunnel WS', { target: `${hostname}:${port}` })

  tunnelWs.on('message', (data) => {
    const text = Buffer.isBuffer(data) ? data.toString() : data
    if (!clientSocket._connectSent && text.startsWith('HTTP/1.1 200')) {
      clientSocket._connectSent = true
      log.info('LOCAL-PROXY', 'tunnel ready â€” 200 sent to Chrome', { target: `${hostname}:${port}` })
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head?.length) tunnelWs.send(head)
      clientSocket.on('data', (chunk) => { if (tunnelWs.readyState === WebSocket.OPEN) tunnelWs.send(chunk) })
      clientSocket.on('end', () => tunnelWs.close())
      clientSocket.on('error', (e) => { log.warn('LOCAL-PROXY', 'clientSocket error', { err: e.message }); tunnelWs.close() })
      return
    }
    if (!clientSocket.destroyed) clientSocket.write(Buffer.isBuffer(data) ? data : Buffer.from(data))
  })

  tunnelWs.on('close', (code, reason) => {
    log.info('LOCAL-PROXY', 'tunnel WS closed', { target: `${hostname}:${port}`, code, reason: reason?.toString() || '' })
    if (!clientSocket.destroyed) clientSocket.destroy()
  })

  tunnelWs.on('error', (e) => {
    log.error('LOCAL-PROXY', 'tunnel WS error', { target: `${hostname}:${port}`, err: e.message })
    if (!opened) clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
    if (!clientSocket.destroyed) clientSocket.destroy()
  })

  setTimeout(() => {
    if (!opened) {
      log.warn('LOCAL-PROXY', 'tunnel timeout', { target: `${hostname}:${port}` })
      tunnelWs.terminate(); clientSocket.write('HTTP/1.1 504 Tunnel Timeout\r\n\r\n'); clientSocket.destroy()
    }
  }, 15000)
})

// â”€â”€ Control server â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const controlServer = http.createServer((req, res) => {
  const origin = req.headers.origin || ''
  res.setHeader('Access-Control-Allow-Origin', origin.includes('peermesh') || origin.includes('localhost') || origin.startsWith('chrome-extension://') ? origin : '')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  const url = new URL(req.url, `http://localhost:${CONTROL_PORT}`)
  logControl(req.method, url.pathname, { origin: origin.slice(0, 40) || undefined })

  if (req.method === 'GET' && url.pathname === '/health') {
    syncAggregateState()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ running, shareEnabled: !!config.shareEnabled, country: config.country, userId: config.userId?.slice(0, 8), proxyPort: RELAY_PROXY_PORT, stats, version: DESKTOP_VERSION }))
    return
  }
  if (req.method === 'GET' && url.pathname === '/native/state') {
    const publicState = getPublicState()
    const state = { available: true, configured: !!(config.token && config.userId), country: config.country, userId: config.userId, where: 'desktop', ...publicState }
    log.debug('CONTROL', '/native/state response', { running, shareEnabled: state.shareEnabled, peerSharing })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(state))
    return
  }
  if (req.method === 'POST' && url.pathname === '/native/auth') {
    let body = ''
    req.on('data', d => body += d)
    req.on('end', async () => {
      try {
        const data = JSON.parse(body || '{}')
        log.info('CONTROL', '/native/auth â€” verifying token', { userId: data.userId })
        if (data.token) {
          try {
            const vRes = await fetch(`${API_BASE}/api/extension-auth?verify=1&userId=${encodeURIComponent(data.userId || '')}`, { headers: { 'Authorization': `Bearer ${data.token}` }, signal: AbortSignal.timeout(5000) })
            log.info('CONTROL', '/native/auth verify result', { status: vRes.status, userId: data.userId })
            if (!vRes.ok) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Token verification failed' })); return }
          } catch (e) { log.warn('CONTROL', '/native/auth verify error (offline?)', { err: e.message }) }
        }
        config = { ...config, token: data.token ?? config.token, userId: data.userId ?? config.userId, country: data.country ?? config.country, trust: data.trust ?? config.trust }
        await pollTodayBytes()
        saveConfig(); updateTray()
        log.info('CONTROL', '/native/auth â€” config updated', { userId: config.userId, country: config.country })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ available: true, configured: !!(config.token && config.userId), country: config.country, userId: config.userId, where: 'desktop', ...getPublicState() }))
      } catch (e) { log.error('CONTROL', '/native/auth error', { err: e.message }); res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })) }
    })
    return
  }
  if (req.method === 'POST' && url.pathname === '/native/share/start') {
    let body = ''
    req.on('data', d => body += d)
    req.on('end', async () => {
      try {
        const data = JSON.parse(body || '{}')
        log.info('CONTROL', '/native/share/start', { userId: data.userId || config.userId, country: data.country || config.country })
        config = { ...config, token: data.token ?? config.token, userId: data.userId ?? config.userId, country: data.country ?? config.country, trust: data.trust ?? config.trust, connectionSlots: clampSlots(data.slots ?? data.connectionSlots ?? config.connectionSlots), shareEnabled: true }
        ensureSlotStates()
        await pollTodayBytes()
        saveConfig()
        logState('share/start')
        if (running) stopRelay()
        config.shareEnabled = true
        saveConfig()
        connectRelay()
        updateTray()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ available: true, configured: !!(config.token && config.userId), country: config.country, userId: config.userId, where: 'desktop', ...getPublicState() }))
      } catch (e) { log.error('CONTROL', '/native/share/start error', { err: e.message }); res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })) }
    })
    return
  }
  if (req.method === 'POST' && url.pathname === '/native/share/stop') {
    log.info('CONTROL', '/native/share/stop called')
    stopRelay()
    persistSharingState(false)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ available: true, configured: !!(config.token && config.userId), country: config.country, userId: config.userId, where: 'desktop', ...getPublicState() }))
    return
  }
  if (req.method === 'POST' && url.pathname === '/native/peer/register') {
    let body = ''
    req.on('data', d => body += d)
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body)
        const prevPeerPort = peerPort
        peerPort = parsed.port
        log.info('CONTROL', '/native/peer/register', { peerPort, prevPeerPort, where: parsed.where })
        logState('peer-registered')
      } catch (e) { log.warn('CONTROL', '/native/peer/register parse error', { err: e.message }) }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
    return
  }
  if (req.method === 'POST' && url.pathname === '/native/show') {
    log.info('CONTROL', '/native/show â€” opening window')
    showWindow()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ available: true, configured: !!(config.token && config.userId), country: config.country, userId: config.userId, where: 'desktop', ...getPublicState() }))
    return
  }
  if (req.method === 'POST' && url.pathname === '/start') {
    let body = ''
    req.on('data', d => body += d)
    req.on('end', () => {
      try {
        const data = JSON.parse(body)
        log.info('CONTROL', '/start called', { userId: data.userId || config.userId })
        config = { ...config, ...data, connectionSlots: clampSlots(data.slots ?? data.connectionSlots ?? config.connectionSlots), shareEnabled: true }
        saveConfig(); stopRelay(); config.shareEnabled = true; saveConfig(); connectRelay()
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true }))
      } catch (e) { log.error('CONTROL', '/start error', { err: e.message }); res.writeHead(400); res.end(JSON.stringify({ error: e.message })) }
    })
    return
  }
  if (req.method === 'POST' && url.pathname === '/quit') {
    log.info('CONTROL', '/quit called â€” scheduling app.quit')
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }))
    setTimeout(() => app.quit(), 500)
    return
  }
  if (req.method === 'POST' && url.pathname === '/stop') {
    log.info('CONTROL', '/stop called')
    stopRelay()
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true }))
    return
  }
  if (req.method === 'POST' && url.pathname === '/proxy-session') {
    let body = ''
    req.on('data', d => body += d)
    req.on('end', () => {
      try {
        const data = JSON.parse(body)
        proxySession = data
        log.info('CONTROL', 'proxy-session SET', { sessionId: data.sessionId?.slice(0,8), relay: data.relayEndpoint })
        logState('proxy-session-set')
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true }))
      } catch (e) { log.error('CONTROL', '/proxy-session error', { err: e.message }); res.writeHead(400); res.end() }
    })
    return
  }
  if (req.method === 'DELETE' && url.pathname === '/proxy-session') {
    log.info('CONTROL', 'proxy-session CLEARED')
    proxySession = null
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true }))
    return
  }
  log.warn('CONTROL', `404 ${req.method} ${url.pathname}`)
  res.writeHead(404); res.end()
})

// â”€â”€ Tray â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
  syncAggregateState()
  const configuredSlots = clampSlots(config.connectionSlots ?? 1)
  const activeSlots = activeSlotCount()
  const slotWarning = getSlotWarning(configuredSlots)
  const menuItems = [
    { label: 'PeerMesh', enabled: false },
    { type: 'separator' },
    { label: running ? `Sharing - ${config.country} (${configuredSlots} slots)` : (peerSharing ? 'Sharing (via CLI)' : 'Not sharing'), enabled: false },
    { label: running ? `${activeSlots} / ${configuredSlots} slots active - ${stats.requestsHandled} requests - ${formatBytes(stats.bytesServed)} served` : (peerSharing ? 'CLI is the active provider' : 'Click to start sharing'), enabled: false },
  ]
  if (slotWarning) menuItems.push({ label: slotWarning, enabled: false })
  menuItems.push(
    { type: 'separator' },
    {
      label: running ? 'Stop Sharing' : (peerSharing ? 'Stop Sharing (CLI)' : 'Start Sharing'),
      click: async () => {
        if (_sharingToggleBusy) { log.warn('TRAY', 'toggle click ignored - busy'); return }
        _sharingToggleBusy = true
        if (peerPort) {
          try {
            const r = await fetch(`http://127.0.0.1:${peerPort}/native/state`, { signal: AbortSignal.timeout(1500) })
            if (r.ok) { const d = await r.json(); peerSharing = !!d.running }
          } catch {}
        }
        const wasRunning = running
        const wasPeerSharing = peerSharing
        if (wasRunning || wasPeerSharing) {
          peerSharing = false
          if (_cliWatchTimer) { clearInterval(_cliWatchTimer); _cliWatchTimer = null }
          stopRelay()
          if (peerPort && wasPeerSharing) {
            try { await fetch(`http://127.0.0.1:${peerPort}/native/share/stop`, { method: 'POST', signal: AbortSignal.timeout(2000) }) } catch {}
          }
          peerPort = null
          updateTray()
        } else if (config.token && config.userId) {
          config.shareEnabled = true
          saveConfig()
          connectRelay()
        } else {
          shell.openExternal(`${API_BASE}/dashboard`)
          showWindow()
        }
        _sharingToggleBusy = false
        logState('post-toggle')
      },
    },
    { type: 'separator' },
    { label: 'Settings', click: showWindow },
    { label: 'Open Dashboard', click: () => shell.openExternal(`${API_BASE}/dashboard`) },
    { label: 'Open Debug Log', click: () => shell.openPath(LOG_FILE) },
    { type: 'separator' },
    { label: 'Quit', click: () => { stopRelay(); if (settingsWindow) { settingsWindow.removeAllListeners('close'); settingsWindow.destroy() } app.quit() } },
  )
  tray.setContextMenu(Menu.buildFromTemplate(menuItems))
  tray.setToolTip(running ? `PeerMesh - Sharing (${config.country}, ${configuredSlots} slots)` : 'PeerMesh - Inactive')
}

function showWindow() {
  if (settingsWindow) {
    if (settingsWindow.isMinimized()) settingsWindow.restore()
    settingsWindow.show(); settingsWindow.focus()
    return
  }
  settingsWindow = new BrowserWindow({
    width: 380, height: 520, resizable: false, title: 'PeerMesh', backgroundColor: '#0a0a0f',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  })
  settingsWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  settingsWindow.setMenuBarVisibility(false)
  settingsWindow.on('close', (e) => { e.preventDefault(); settingsWindow.hide() })
  log.info('WINDOW', 'settings window created')
}

function showNotification(title, body) {
  if (Notification.isSupported()) new Notification({ title, body, silent: true }).show()
}

// â”€â”€ IPC â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

ipcMain.handle('get-ext-id', () => { logIpc('get-ext-id'); return config.extId })

ipcMain.handle('check-website-auth', async () => {
  logIpc('check-website-auth', { extId: config.extId })
  try {
    logRequest('GET', `${API_BASE}/api/extension-auth?ext_id=***`)
    const res = await fetch(`${API_BASE}/api/extension-auth?ext_id=${config.extId}`)
    const data = await res.json()
    logResponse('GET', `${API_BASE}/api/extension-auth`, res.status)
    if (res.status === 403) return { error: data.error || 'Account not verified' }
    if (res.status === 401) return { error: 'Session expired â€” please sign in again' }
    if (res.status === 404) return { error: 'User not found' }
    if (!data.user) return { pending: true }
    if (!data.user.token || !data.user.id) return { error: 'Invalid auth response' }
    log.info('IPC', 'check-website-auth â€” user found', { userId: data.user.id })
    return { user: data.user }
  } catch (e) { log.error('IPC', 'check-website-auth error', { err: e.message }); return { error: 'Could not reach server' } }
})

ipcMain.handle('request-device-code', async () => {
  logIpc('request-device-code')
  try {
    logRequest('POST', `${API_BASE}/api/extension-auth`, { device: true })
    const res = await fetch(`${API_BASE}/api/extension-auth`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device: true }) })
    const data = await res.json()
    logResponse('POST', `${API_BASE}/api/extension-auth`, res.status, { user_code: data.user_code, interval: data.interval })
    if (!res.ok) return { error: 'Could not reach server' }
    return data
  } catch (e) { log.error('IPC', 'request-device-code error', { err: e.message }); return { error: 'Could not reach server' } }
})

ipcMain.handle('poll-device-code', async (_, { device_code }) => {
  try {
    const res = await fetch(`${API_BASE}/api/extension-auth?device_code=${encodeURIComponent(device_code)}`)
    const data = await res.json()
    if (data.status !== 'pending') {
      logIpc('poll-device-code result', { status: data.status, userId: data.user?.id })
    }
    return data
  } catch (e) { log.error('IPC', 'poll-device-code error', { err: e.message }); return { status: 'pending' } }
})

ipcMain.handle('open-auth', async (_, url) => {
  const safeUrl = url && !url.startsWith('http://localhost') ? url : `${API_BASE}/extension?activate=1`
  logIpc('open-auth', { url: safeUrl })
  const { response } = await require('electron').dialog.showMessageBox(settingsWindow || BrowserWindow.getFocusedWindow(), {
    type: 'question', title: 'Sign in to PeerMesh', message: 'Open sign-in page',
    detail: `Open this URL in your browser to sign in:\n\n${safeUrl}`,
    buttons: ['Open Browser', 'Copy Link', 'Cancel'], defaultId: 0, cancelId: 2,
  })
  if (response === 0) { shell.openExternal(safeUrl); log.info('IPC', 'open-auth â€” opened browser') }
  else if (response === 1) {
    require('electron').clipboard.writeText(safeUrl)
    log.info('IPC', 'open-auth â€” copied link to clipboard')
    if (settingsWindow) {
      settingsWindow.webContents.executeJavaScript(`
        const el = document.createElement('div')
        el.textContent = '\u2713 Link copied â€” paste in your browser'
        el.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:#1e1e2a;border:1px solid #00ff88;color:#e8e8f0;padding:10px 18px;border-radius:8px;font-family:\'Courier New\',monospace;font-size:11px;z-index:9999;pointer-events:none'
        document.body.appendChild(el)
        setTimeout(() => el.remove(), 2500)
      `).catch(() => {})
    }
  }
})

ipcMain.handle('get-state', () => {
  const state = { ...getPublicState(), config: { ...getPublicState().config, hasAcceptedProviderTerms: config.hasAcceptedProviderTerms ?? false } }
  logIpc('get-state', { running: state.running, shareEnabled: state.shareEnabled })
  return state
})

ipcMain.handle('set-connection-slots', async (_, slots) => {
  const nextSlots = clampSlots(slots)
  const restart = running
  config.connectionSlots = nextSlots
  ensureSlotStates()
  saveConfig()
  if (restart) {
    stopRelay()
    config.shareEnabled = true
    saveConfig()
    connectRelay()
  } else {
    updateTray()
  }
  return { success: true, slots: nextSlots, state: getPublicState() }
})

ipcMain.handle('sign-in', async (_, { token, userId, country, trust }) => {
  logIpc('sign-in attempt', { userId, country })
  try {
    logRequest('GET', `${API_BASE}/api/extension-auth?verify=1&userId=${userId}`)
    const res = await fetch(`${API_BASE}/api/extension-auth?verify=1&userId=${encodeURIComponent(userId)}`, { headers: { 'Authorization': `Bearer ${token}` }, signal: AbortSignal.timeout(5000) })
    logResponse('GET', `${API_BASE}/api/extension-auth?verify`, res.status)
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      log.warn('IPC', 'sign-in verify failed', { status: res.status, body })
      return { success: false, error: 'Token verification failed' }
    }
  } catch (e) { log.warn('IPC', 'sign-in verify error (offline?)', { err: e.message }) }
  config = { ...config, token, userId, country, trust }
  try {
    logRequest('GET', `${API_BASE}/api/user/sharing`)
    const res = await fetch(`${API_BASE}/api/user/sharing`, { headers: { 'Authorization': `Bearer ${token}` }, signal: AbortSignal.timeout(4000) })
    logResponse('GET', `${API_BASE}/api/user/sharing`, res.status)
    if (res.ok) {
      const data = await res.json()
      config.hasAcceptedProviderTerms = data.has_accepted_provider_terms ?? false
      config.todaySharedBytes = data.total_bytes_today ?? 0
      config.todaySharedBytesDate = new Date().toISOString().slice(0, 10)
      config.dailyShareLimitMb = data.daily_share_limit_mb ?? null
      limitHit = data.daily_limit_bytes == null ? false : (config.todaySharedBytes ?? 0) >= data.daily_limit_bytes
    }
  } catch {}
  saveConfig(); updateTray(); showWindow()
  log.info('IPC', 'sign-in success', { userId, country })
  return { success: true }
})

ipcMain.handle('toggle-sharing', async () => {
  if (_sharingToggleBusy) { log.warn('IPC', 'toggle-sharing ignored â€” busy'); return { running, shareEnabled: !!config.shareEnabled } }
  _sharingToggleBusy = true
  // Live-check CLI state to avoid acting on stale peerSharing (up to 3s old)
  if (peerPort) {
    try {
      const r = await fetch(`http://127.0.0.1:${peerPort}/native/state`, { signal: AbortSignal.timeout(1500) })
      if (r.ok) { const d = await r.json(); peerSharing = !!d.running }
    } catch {}
  }
  const wasRunning = running
  const wasPeerSharing = peerSharing
  logIpc('toggle-sharing', { wasRunning, wasPeerSharing, peerPort })
  if (wasRunning || wasPeerSharing) {
    peerSharing = false
    if (_cliWatchTimer) { clearInterval(_cliWatchTimer); _cliWatchTimer = null; log.info('IPC', '_cliWatchTimer cleared on toggle-stop') }
    stopRelay()
    if (peerPort && wasPeerSharing) {
      log.info('IPC', 'sending share/stop to CLI peer', { peerPort })
      try {
        const r = await fetch(`http://127.0.0.1:${peerPort}/native/share/stop`, { method: 'POST', signal: AbortSignal.timeout(2000) })
        log.info('IPC', 'CLI share/stop response', { status: r.status })
      } catch (e) { log.warn('IPC', 'CLI share/stop fetch failed', { err: e.message }) }
    }
    peerPort = null
    updateTray()
  } else if (config.token) {
    log.info('IPC', 'toggle-sharing ON â€” starting sharing')
    config.shareEnabled = true; saveConfig(); connectRelay()
  }
  _sharingToggleBusy = false
  logState('post-toggle-sharing')
  return { running, shareEnabled: !!config.shareEnabled }
})

ipcMain.handle('sign-out', () => {
  logIpc('sign-out', { userId: config.userId })
  stopRelay()
  config = { token: '', userId: '', country: 'RW', trust: 50, extId: config.extId, baseDeviceId: config.baseDeviceId, shareEnabled: false, connectionSlots: clampSlots(config.connectionSlots ?? 1), hasAcceptedProviderTerms: false }
  saveConfig(); persistSharingState(false); updateTray()
  log.info('IPC', 'signed out')
  return { success: true }
})

ipcMain.handle('open-dashboard', () => { logIpc('open-dashboard'); shell.openExternal(`${API_BASE}/dashboard`) })

ipcMain.handle('accept-provider-terms', async (_, { checkOnly } = {}) => {
  logIpc('accept-provider-terms', { checkOnly })
  if (!config.token) return { success: false }
  if (checkOnly) {
    try {
      const res = await fetch(`${API_BASE}/api/user/sharing`, { headers: { 'Authorization': `Bearer ${config.token}` }, signal: AbortSignal.timeout(3000) })
      if (res.ok) {
        const data = await res.json()
        if (data.has_accepted_provider_terms === true) { config.hasAcceptedProviderTerms = true; saveConfig() }
        log.info('IPC', 'accept-provider-terms checkOnly result', { accepted: data.has_accepted_provider_terms })
        return { success: true, accepted: data.has_accepted_provider_terms === true }
      }
    } catch {}
    return { success: true, accepted: config.hasAcceptedProviderTerms ?? false }
  }
  try {
    const res = await fetch(`${API_BASE}/api/user/sharing`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` }, body: JSON.stringify({ acceptProviderTerms: true }) })
    if (res.ok) { config.hasAcceptedProviderTerms = true; saveConfig(); log.info('IPC', 'provider terms accepted and saved') }
  } catch (e) { log.warn('IPC', 'accept-provider-terms save failed', { err: e.message }) }
  return { success: true }
})

// â”€â”€ App lifecycle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

if (IS_NATIVE_HOST_MODE) {
  loadConfig()
  registerNativeMessagingHost()
  runNativeHostMode()
} else app.whenReady().then(() => {
  if (!app.requestSingleInstanceLock()) {
    log.warn('PROCESS', 'Another instance is already running â€” quitting')
    app.quit(); return
  }
  app.on('second-instance', () => { log.info('PROCESS', 'second-instance event â€” showing window'); showWindow() })

  log.info('PROCESS', '=== APP START ===', { version: DESKTOP_VERSION, background: IS_BACKGROUND_LAUNCH, argv: process.argv.slice(1).join(' ') })
  app.on('window-all-closed', (e) => e.preventDefault())
  app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true })

  loadConfig()

  tray = new Tray(createTrayIcon())
  tray.setToolTip('PeerMesh')
  tray.on('click', showWindow)
  updateTray()

  const net = require('net')
  const tester = net.createServer()
  tester.once('error', () => {
    log.warn('PORT', `port ${CONTROL_PORT} in use â€” CLI owns it, desktop binding to PEER_PORT ${PEER_PORT}`)
    logRequest('POST', `http://127.0.0.1:${CONTROL_PORT}/native/peer/register`, { port: PEER_PORT, where: 'desktop' })
    fetch(`http://127.0.0.1:${CONTROL_PORT}/native/peer/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port: PEER_PORT, where: 'desktop' }), signal: AbortSignal.timeout(1500),
    })
      .then(r => { logResponse('POST', `http://127.0.0.1:${CONTROL_PORT}/native/peer/register`, r.status); peerPort = CONTROL_PORT })
      .catch(e => log.warn('PORT', 'peer register failed', { err: e.message }))

    const peerServer = http.createServer((req, res) => {
      const origin = req.headers.origin || ''
      res.setHeader('Access-Control-Allow-Origin', origin.includes('peermesh') || origin.includes('localhost') || origin.startsWith('chrome-extension://') ? origin : '')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
      const url = new URL(req.url, `http://localhost:${PEER_PORT}`)
      log.debug('PEER-SERVER', `${req.method} ${url.pathname}`)

      if (req.method === 'GET' && url.pathname === '/native/state') {
        fetch(`http://127.0.0.1:${CONTROL_PORT}/native/state`, { signal: AbortSignal.timeout(1500) })
          .then(r => r.json())
          .then(d => { peerSharing = !!d.running; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ...d, where: 'desktop', peerWhere: 'cli' })) })
          .catch(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ available: true, running: false, shareEnabled: false, where: 'desktop' })) })
        return
      }
      if (req.method === 'POST' && url.pathname === '/native/share/stop') {
        log.info('PEER-SERVER', '/native/share/stop â€” desktop peer received stop signal (not forwarding back to CLI)')
        // Do NOT forward to CLI â€” they sent this to us; forwarding would cause a loop
        peerSharing = false
        config.shareEnabled = false
        saveConfig()
        if (running) stopRelay(); else updateTray()
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ available: true, running: false, shareEnabled: false }))
        return
      }
      if (req.method === 'POST' && url.pathname === '/native/peer/register') {
        let body = ''
        req.on('data', d => body += d)
        req.on('end', () => {
          try { const p = JSON.parse(body); peerPort = p.port; log.info('PEER-SERVER', '/native/peer/register', { peerPort, where: p.where }) } catch {}
          res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }))
        })
        return
      }
      res.writeHead(404); res.end()
    })

    peerServer.listen(PEER_PORT, '127.0.0.1', async () => {
      log.info('PORT', `PORT RACE RESULT: desktop peer server on ${PEER_PORT} (CLI owns ${CONTROL_PORT})`)
      try {
        const r = await fetch(`http://127.0.0.1:${CONTROL_PORT}/native/state`, { signal: AbortSignal.timeout(1500) })
        if (r.ok) { const d = await r.json(); peerSharing = !!d.running; log.info('PORT', 'CLI state at desktop startup', { cliRunning: d.running, cliVersion: d.version }) }
      } catch (e) { log.warn('PORT', 'CLI state check failed', { err: e.message }) }
      updateTray()

      function reclaimPrimary() {
        log.info('PORT', 'CLI gone â€” reclaiming port ' + CONTROL_PORT)
        logState('pre-reclaim')
        peerSharing = false; peerPort = null; config.shareEnabled = false; saveConfig(); updateTray()
        peerServer.close(() => {
          controlServer.listen(CONTROL_PORT, '127.0.0.1', () => {
            localProxyServer.listen(LOCAL_PROXY_PORT, '127.0.0.1')
            log.info('PORT', 'PORT RECLAIMED: desktop now owns ' + CONTROL_PORT)
            logState('post-reclaim')
          })
        })
      }

      const cliWatcher = setInterval(async () => {
        try {
          const r = await fetch(`http://127.0.0.1:${CONTROL_PORT}/native/state`, { signal: AbortSignal.timeout(1500) })
          if (r.ok) {
            const d = await r.json()
            if (!_sharingToggleBusy) {
              const prev = peerSharing
              peerSharing = !!d.running
              if (peerSharing !== prev) { log.info('PORT', 'cliWatcher peerSharing changed', { from: prev, to: peerSharing }); updateTray() }
            }
          } else {
            log.warn('PORT', 'cliWatcher non-ok response â€” reclaiming', { status: r.status })
            clearInterval(cliWatcher); reclaimPrimary()
          }
        } catch (e) {
          log.info('PORT', 'cliWatcher â€” CLI gone (unreachable)', { err: e.message })
          clearInterval(cliWatcher); reclaimPrimary()
        }
      }, 3000)
    })
    peerServer.on('error', e => log.error('PORT', 'Desktop peer server error', { err: e.message }))
  })

  tester.once('listening', () => {
    tester.close(() => {
      controlServer.listen(CONTROL_PORT, '127.0.0.1', async () => {
        log.info('PORT', `PORT RACE RESULT: desktop owns ${CONTROL_PORT} (primary)`)
        localProxyServer.listen(LOCAL_PROXY_PORT, '127.0.0.1')

        let cliAlreadySharing = false
        try {
          const r = await fetch(`http://127.0.0.1:${PEER_PORT}/native/state`, { signal: AbortSignal.timeout(1500) })
          if (r.ok) {
            const cliState = await r.json()
            log.info('PORT', 'CLI detected on PEER_PORT at startup', { where: cliState.where, running: cliState.running, version: cliState.version })
            if (cliState.where === 'cli') {
              await fetch(`http://127.0.0.1:${PEER_PORT}/native/peer/register`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ port: CONTROL_PORT, where: 'desktop' }), signal: AbortSignal.timeout(1500),
              })
              peerPort = PEER_PORT
              cliAlreadySharing = !!cliState.running
              peerSharing = cliAlreadySharing
              log.info('PORT', 'registered with CLI peer', { peerPort, cliAlreadySharing })
              if (cliAlreadySharing) log.info('PORT', 'CLI is sharing â€” desktop standing by')

              _cliWatchTimer = setInterval(async () => {
                try {
                  const r = await fetch(`http://127.0.0.1:${PEER_PORT}/native/state`, { signal: AbortSignal.timeout(1500) })
                  if (r.ok) {
                    const d = await r.json()
                    if (!_sharingToggleBusy) {
                      const prev = peerSharing
                      peerSharing = !!d.running
                      if (peerSharing !== prev) { log.info('PORT', '_cliWatchTimer peerSharing changed', { from: prev, to: peerSharing }); updateTray() }
                    }
                  } else {
                    log.warn('PORT', '_cliWatchTimer non-ok â€” clearing peer state', { status: r.status })
                    clearInterval(_cliWatchTimer); _cliWatchTimer = null; peerSharing = false; peerPort = null; updateTray()
                  }
                } catch (e) {
                  log.info('PORT', '_cliWatchTimer â€” CLI gone (unreachable)', { err: e.message })
                  clearInterval(_cliWatchTimer); _cliWatchTimer = null; peerSharing = false; peerPort = null; updateTray()
                }
              }, 3000)
            }
          }
        } catch (e) { log.debug('PORT', 'no CLI on PEER_PORT at startup', { err: e.message }) }

        log.info('PORT', 'startup check complete', { cliAlreadySharing, hasToken: !!config.token, hasUserId: !!config.userId, shareEnabled: config.shareEnabled })
        logState('startup')
        if (!cliAlreadySharing && config.token && config.userId && config.shareEnabled) {
          log.info('PORT', 'auto-connecting relay on startup')
          connectRelay()
        }
      })
    })
  })
  tester.listen(CONTROL_PORT, '127.0.0.1')

  if (config.token && config.userId && config.shareEnabled) {
    if (!IS_BACKGROUND_LAUNCH) showWindow()
  } else { showWindow() }
})

app.on('before-quit', () => {
  log.info('PROCESS', '=== APP QUIT ===')
  logState('before-quit')
  if (_cliWatchTimer) { clearInterval(_cliWatchTimer); _cliWatchTimer = null; log.info('PROCESS', '_cliWatchTimer cleared on quit') }
  stopRelay()
  closeAllTunnels(false)
  try { controlServer.close(); log.debug('PROCESS', 'controlServer closed') } catch {}
  try { localProxyServer.close(); log.debug('PROCESS', 'localProxyServer closed') } catch {}
  if (config.token && config.userId && config.extId) {
    fetch(`${API_BASE}/api/user/sharing`, { method: 'DELETE', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` }, body: JSON.stringify({ device_id: config.extId }) }).catch(() => {})
    fetch(`${API_BASE}/api/user/sharing`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` }, body: JSON.stringify({ isSharing: false }) }).catch(() => {})
  }
  if (process.platform === 'win32') { try { spawnSync('taskkill', ['/F', '/IM', 'node.exe', '/T'], { stdio: 'ignore' }) } catch {} }
  else { try { spawnSync('pkill', ['-f', 'peermesh'], { stdio: 'ignore' }) } catch {} }
})
