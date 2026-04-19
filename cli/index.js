#!/usr/bin/env node

import { WebSocket } from 'ws'
import { connect } from 'net'
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import http from 'http'

if (process.platform === 'win32') {
  try { process.stdout.setEncoding('utf8') } catch {}
  try { process.stderr.setEncoding('utf8') } catch {}
}

const API_BASE = 'https://peermesh-beta.vercel.app'
const RELAY_WS = 'wss://peermesh-relay.fly.dev'
const CONFIG_DIR = join(homedir(), '.peermesh')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')
const VERSION     = '1.0.29'
const DEBUG_LOG = join(homedir(), 'Desktop', 'peermesh-debug.log')

const CONTROL_PORT = 7654
const PEER_PORT = 7656
const SLOT_CAP = 32

const BLOCKED = [/\.onion$/i, /^smtp\./i, /^mail\./i, /torrent/i]
const PRIVATE = [/^localhost$/i, /^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./]

const args = process.argv.slice(2)
const limitIdx = args.indexOf('--limit')
const limitArg = limitIdx !== -1 ? args[limitIdx + 1] : undefined
const slotsIdx = args.indexOf('--slots')
const slotsArg = slotsIdx !== -1 ? args[slotsIdx + 1] : undefined
const noLimit = args.includes('--no-limit')
const resetFlag = args.includes('--reset')
const statusFlag = args.includes('--status')
const serveFlag = args.includes('--serve')
const debugFlag = args.includes('--debug')

function _write(level, category, message, ctx) {
  const ts = new Date().toISOString()
  const ctxStr = ctx && Object.keys(ctx).length
    ? ' | ' + Object.entries(ctx).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')
    : ''
  const line = `[${ts}] [CLI] [${level.padEnd(5)}] [${category.padEnd(12)}] ${message}${ctxStr}`
  try { appendFileSync(DEBUG_LOG, line + '\n') } catch {}
  if (debugFlag) console.log(line)
}

const clog = {
  info: (cat, msg, ctx) => _write('INFO', cat, msg, ctx),
  warn: (cat, msg, ctx) => _write('WARN', cat, msg, ctx),
  error: (cat, msg, ctx) => _write('ERROR', cat, msg, ctx),
  debug: (cat, msg, ctx) => _write('DEBUG', cat, msg, ctx),
}

const clogRequest = (method, url, body) => _write('INFO', 'HTTP-OUT', `-> ${method} ${url}`, body ? { body } : undefined)
const clogResponse = (method, url, status, ctx) => _write('INFO', 'HTTP-IN', `<- ${status} ${method} ${url}`, ctx)
const clogRelay = (dir, type, ctx) => _write('DEBUG', 'RELAY', `${dir} ${type}`, ctx)
const clogTunnel = (event, tunnelId, ctx) => _write('DEBUG', 'TUNNEL', `${event} tunnel=${tunnelId?.slice(0, 8)}`, ctx)
const clogControl = (method, path, ctx) => _write('INFO', 'CONTROL', `${method} ${path}`, ctx)

function loadConfig() {
  try {
    if (existsSync(CONFIG_FILE)) return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'))
  } catch (e) {
    clog.warn('CONFIG', 'loadConfig read error', { err: e.message })
  }
  return {}
}

function saveConfig(cfg) {
  try {
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true })
    writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2))
  } catch (e) {
    clog.error('CONFIG', 'saveConfig error', { err: e.message })
  }
}

function log(msg, level = 'info') {
  const ts = new Date().toTimeString().slice(0, 8)
  const icon = level === 'error' ? 'x' : level === 'warn' ? '!' : '*'
  console.log(`  ${icon} [${ts}] ${msg}`)
  clog.info('USER', msg)
}

function formatBytes(bytes) {
  if (!bytes || bytes < 1024) return `${bytes ?? 0}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`
}

function banner() {
  console.log('')
  console.log(`  PeerMesh Provider v${VERSION}`)
  console.log('  Share your connection. Stay free.')
  console.log('')
}

function clampSlots(value) {
  const parsed = parseInt(value, 10)
  if (!Number.isInteger(parsed)) return 1
  return Math.max(1, Math.min(SLOT_CAP, parsed))
}

function parseSlotsFlag(value) {
  const parsed = parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > SLOT_CAP) {
    throw new Error(`--slots must be an integer between 1 and ${SLOT_CAP}`)
  }
  return parsed
}

function currentUsageDay() {
  return new Date().toDateString()
}

function syncUsageDay() {
  const today = currentUsageDay()
  if (config.usageDate !== today) {
    config.usageDate = today
    config.todayRequestsHandled = 0
    saveConfig(config)
  }
}

let config = loadConfig()
if (config.country?.startsWith('--')) {
  config.country = undefined
  saveConfig(config)
}

if (!config.baseDeviceId) config.baseDeviceId = config.deviceId || ('cli_' + Math.random().toString(36).slice(2, 10))
if (!config.deviceId) config.deviceId = config.baseDeviceId
if (!config.connectionSlots) config.connectionSlots = 1

const BASE_DEVICE_ID = config.baseDeviceId

let slotStates = []
let limitHit = false
let _userStopped = false
let myPort = null
let peerPort = null
let _controlLimitBytes = null
let _pendingBytes = 0
let _flushTimer = null

function getConnectionSlots() {
  return clampSlots(config.connectionSlots ?? 1)
}

function slotPrefix(slot) {
  return `[slot-${slot.index}]`
}

function slotLog(slot, message, level = 'info') {
  log(`${slotPrefix(slot)} ${message}`, level)
}

function createSlotState(index) {
  return {
    index,
    deviceId: `${BASE_DEVICE_ID}_slot_${index}`,
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
  const desired = getConnectionSlots()
  while (slotStates.length < desired) slotStates.push(createSlotState(slotStates.length))
  if (slotStates.length > desired) slotStates = slotStates.slice(0, desired)
  return slotStates
}

function activeSlotCount() {
  return slotStates.filter(slot => slot.running).length
}

function isRunning() {
  return activeSlotCount() > 0
}

function getAggregateStats() {
  return slotStates.reduce((acc, slot) => {
    acc.bytesServed += slot.sessionBytes
    acc.requestsHandled += slot.requestsHandled
    acc.tunnels += slot.activeTunnels.size
    return acc
  }, { bytesServed: 0, requestsHandled: 0, tunnels: 0 })
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

function clogState(label) {
  const aggregate = getAggregateStats()
  _write('DEBUG', 'STATE', `[${label}]`, {
    running: isRunning(),
    activeSlots: activeSlotCount(),
    configuredSlots: getConnectionSlots(),
    wsStates: slotStates.map(slot => `${slot.index}:${slot.ws ? slot.ws.readyState : 'null'}`).join(','),
    myPort,
    peerPort,
    tunnels: aggregate.tunnels,
    limitHit,
  })
}

function getStatePayload() {
  return {
    available: true,
    running: isRunning(),
    shareEnabled: isRunning(),
    configured: !!(config.token && config.userId),
    userId: config.userId ?? null,
    version: VERSION,
    where: 'cli',
    baseDeviceId: BASE_DEVICE_ID,
    connectionSlots: getConnectionSlots(),
    slots: {
      configured: getConnectionSlots(),
      active: activeSlotCount(),
      statuses: getSlotSummary(),
      warning: getSlotWarning(getConnectionSlots()),
    },
    stats: {
      bytesServed: getAggregateStats().bytesServed,
      requestsHandled: getAggregateStats().requestsHandled,
      connectedAt: slotStates.find(slot => slot.connectedAt)?.connectedAt ?? null,
      peerId: null,
    },
  }
}

function isAllowed(hostname) {
  const blocked = BLOCKED.some(pattern => pattern.test(hostname))
  const private_ = PRIVATE.some(pattern => pattern.test(hostname))
  if (blocked || private_) clog.warn('FILTER', 'hostname blocked', { hostname, reason: blocked ? 'blocklist' : 'private' })
  return !blocked && !private_
}

async function persistSharingState(isSharing) {
  if (!config.token) return
  clogRequest('POST', `${API_BASE}/api/user/sharing`, { isSharing })
  try {
    const res = await fetch(`${API_BASE}/api/user/sharing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` },
      body: JSON.stringify({ isSharing }),
    })
    clogResponse('POST', `${API_BASE}/api/user/sharing`, res.status)
  } catch (e) {
    clog.warn('API', 'persistSharingState failed', { err: e.message })
  }
}

async function flushPendingBytes() {
  if (_flushTimer) return
  _flushTimer = setTimeout(async () => {
    _flushTimer = null
    const toFlush = _pendingBytes
    _pendingBytes = 0
    if (!toFlush || !config.token) return
    clogRequest('POST', `${API_BASE}/api/user/sharing`, { bytes: toFlush })
    try {
      const res = await fetch(`${API_BASE}/api/user/sharing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` },
        body: JSON.stringify({ bytes: toFlush }),
      })
      clogResponse('POST', `${API_BASE}/api/user/sharing`, res.status)
    } catch (e) {
      clog.warn('API', 'flushStats failed', { err: e.message })
    }
  }, 5000)
}

function enforceLocalLimit(limitBytes) {
  if (!limitBytes || limitHit || config.todaySharedBytes == null) return
  const totalToday = (config.todaySharedBytes ?? 0) + getAggregateStats().bytesServed
  if (totalToday < limitBytes) return

  limitHit = true
  clog.warn('LIMIT', 'daily limit reached', { totalToday, limitBytes })
  console.log('')
  console.log(`  Daily limit of ${formatBytes(limitBytes)} reached.`)
  console.log('  Sharing stopped. Run again tomorrow or increase the limit in PeerMesh.')
  console.log('')
  stopRelay()
  process.exit(0)
}

function addBytes(slot, bytes, limitBytes) {
  slot.sessionBytes += bytes
  _pendingBytes += bytes
  flushPendingBytes()
  enforceLocalLimit(limitBytes)
}

async function pollTodayBytes() {
  if (!config.token) return
  syncUsageDay()
  clogRequest('GET', `${API_BASE}/api/user/sharing`)
  try {
    const res = await fetch(`${API_BASE}/api/user/sharing`, {
      headers: { Authorization: `Bearer ${config.token}` },
    })
    clogResponse('GET', `${API_BASE}/api/user/sharing`, res.status)
    if (!res.ok) return
    const data = await res.json()
    config.todaySharedBytes = data.total_bytes_today ?? 0
    saveConfig(config)
    return data
  } catch (e) {
    clog.warn('API', 'pollTodayBytes error', { err: e.message })
  }
}

function sendMsg(slot, data) {
  if (slot.ws?.readyState === WebSocket.OPEN) slot.ws.send(JSON.stringify(data))
}

function closeTunnel(slot, tunnelId, notify = false) {
  const tunnel = slot.activeTunnels.get(tunnelId)
  if (!tunnel || tunnel.closed) return
  tunnel.closed = true
  slot.activeTunnels.delete(tunnelId)
  if (notify) sendMsg(slot, { type: 'tunnel_close', tunnelId })
  if (!tunnel.socket.destroyed) tunnel.socket.destroy()
  clogTunnel('CLOSED', tunnelId, { slot: slot.index, notify, remaining: slot.activeTunnels.size })
}

function closeAllTunnels(slot) {
  const count = slot.activeTunnels.size
  for (const tunnelId of [...slot.activeTunnels.keys()]) closeTunnel(slot, tunnelId, false)
  if (count > 0) clog.info('TUNNEL', `${slotPrefix(slot)} closeAllTunnels closed ${count}`, { slot: slot.index })
}

function sendHeartbeat(slot) {
  if (!config.token || !config.userId) return
  clogRequest('PUT', `${API_BASE}/api/user/sharing`, { device_id: slot.deviceId })
  fetch(`${API_BASE}/api/user/sharing`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` },
    body: JSON.stringify({ device_id: slot.deviceId }),
  })
    .then(res => { clogResponse('PUT', `${API_BASE}/api/user/sharing`, res.status); return res.ok ? res.json() : null })
    .then(data => { if (data) clog.debug('HEARTBEAT', 'PUT ok', { slot: slot.index, data: JSON.stringify(data).slice(0, 80) }) })
    .catch(e => clog.warn('HEARTBEAT', 'PUT error', { slot: slot.index, err: e.message }))
}

function stopHeartbeat(slot) {
  if (slot.heartbeatTimer) {
    clearInterval(slot.heartbeatTimer)
    slot.heartbeatTimer = null
  }
  if (!config.token) return
  clogRequest('DELETE', `${API_BASE}/api/user/sharing`, { device_id: slot.deviceId })
  fetch(`${API_BASE}/api/user/sharing`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` },
    body: JSON.stringify({ device_id: slot.deviceId }),
  })
    .then(res => clogResponse('DELETE', `${API_BASE}/api/user/sharing`, res.status))
    .catch(e => clog.warn('HEARTBEAT', 'DELETE error', { slot: slot.index, err: e.message }))
}

async function handleFetch(slot, request, limitBytes) {
  const { requestId, url, method = 'GET', headers = {}, body = null } = request
  clog.info('PROXY', `${slotPrefix(slot)} fetch request`, { requestId: requestId?.slice(0, 8), method, url })
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
    res.headers.forEach((value, key) => {
      if (!['content-encoding', 'transfer-encoding', 'connection', 'keep-alive'].includes(key)) {
        responseHeaders[key] = value
      }
    })
    addBytes(slot, responseBody.length, limitBytes)
    return {
      requestId,
      status: res.status,
      headers: responseHeaders,
      body: responseBody,
      finalUrl: res.url,
    }
  } catch (err) {
    clog.error('PROXY', `${slotPrefix(slot)} fetch error`, { requestId: requestId?.slice(0, 8), url, err: err.message })
    return { requestId, status: 502, headers: {}, body: '', error: err.message }
  }
}

function attachSlotSocketHandlers(slot, limitBytes) {
  slot.ws.on('open', () => {
    slot.running = true
    slot.reconnectDelay = 2000
    slot.connectedAt = new Date().toISOString()
    slotLog(slot, `connected to relay (${slot.deviceId})`)
    const reg = {
      type: 'register_provider',
      userId: config.userId,
      country: config.country,
      trustScore: config.trust ?? 50,
      agentMode: true,
      providerKind: 'cli',
      supportsHttp: true,
      supportsTunnel: true,
      deviceId: slot.deviceId,
      baseDeviceId: BASE_DEVICE_ID,
    }
    clogRelay('SEND', 'register_provider', { slot: slot.index, deviceId: slot.deviceId })
    slot.ws.send(JSON.stringify(reg))
    if (slot.heartbeatTimer) clearInterval(slot.heartbeatTimer)
    slot.heartbeatTimer = setInterval(() => {
      sendHeartbeat(slot)
      pollTodayBytes()
    }, 30_000)
    sendHeartbeat(slot)
  })

  slot.ws.on('ping', () => {
    try { slot.ws.pong() } catch {}
  })

  slot.ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString())
      if (msg.type === 'tunnel_data') {
        clog.debug('RELAY', 'RECV tunnel_data', { slot: slot.index, tunnelId: msg.tunnelId?.slice(0, 8), bytes: msg.data?.length })
      } else {
        clogRelay('RECV', msg.type, { slot: slot.index, sessionId: msg.sessionId?.slice(0, 8), tunnelId: msg.tunnelId?.slice(0, 8) })
      }

      switch (msg.type) {
        case 'registered':
          if (config.token) persistSharingState(true)
          printStatus(limitBytes)
          break

        case 'error':
          clog.error('RELAY', `${slotPrefix(slot)} relay error`, { message: msg.message })
          if (msg.message?.includes('Replaced')) {
            slot.ws.removeAllListeners('close')
            slot.ws.close(1000)
            slot.running = false
          }
          break

        case 'session_request':
          sendMsg(slot, { type: 'agent_ready', sessionId: msg.sessionId })
          break

        case 'proxy_request': {
          syncUsageDay()
          slot.requestsHandled++
          config.todayRequestsHandled = (config.todayRequestsHandled ?? 0) + 1
          const response = await handleFetch(slot, msg.request, limitBytes)
          sendMsg(slot, { type: 'proxy_response', sessionId: msg.sessionId, response })
          break
        }

        case 'open_tunnel': {
          const { tunnelId, hostname, port } = msg
          if (!isAllowed(hostname)) {
            sendMsg(slot, { type: 'tunnel_close', tunnelId })
            break
          }
          syncUsageDay()
          slot.requestsHandled++
          config.todayRequestsHandled = (config.todayRequestsHandled ?? 0) + 1
          const socket = connect(port, hostname)
          slot.activeTunnels.set(tunnelId, { socket, closed: false })
          socket.on('connect', () => sendMsg(slot, { type: 'tunnel_ready', tunnelId }))
          socket.on('data', chunk => {
            sendMsg(slot, { type: 'tunnel_data', tunnelId, data: chunk.toString('base64') })
            addBytes(slot, chunk.length, limitBytes)
          })
          socket.on('end', () => closeTunnel(slot, tunnelId, true))
          socket.on('close', () => slot.activeTunnels.delete(tunnelId))
          socket.on('error', () => closeTunnel(slot, tunnelId, true))
          break
        }

        case 'tunnel_data': {
          const tunnel = slot.activeTunnels.get(msg.tunnelId)
          if (tunnel?.socket && !tunnel.socket.destroyed) {
            tunnel.socket.write(Buffer.from(msg.data, 'base64'))
          }
          break
        }

        case 'tunnel_close':
          closeTunnel(slot, msg.tunnelId, false)
          break

        case 'session_ended':
          closeAllTunnels(slot)
          break
      }

      saveConfig(config)
    } catch (e) {
      clog.error('RELAY', `${slotPrefix(slot)} message handler exception`, { err: e.message })
    }
  })

  slot.ws.on('close', (code, reason) => {
    clog.info('RELAY', `${slotPrefix(slot)} closed`, { code, reason: reason?.toString() || '(none)' })
    slot.running = false
    slot.connectedAt = null
    closeAllTunnels(slot)
    slot.ws = null
    if (code !== 1000 && !limitHit && !_userStopped && config.shareEnabled) {
      slot.reconnectTimer = setTimeout(() => connectSlot(slot, limitBytes), slot.reconnectDelay)
      slot.reconnectDelay = Math.min(slot.reconnectDelay * 2, 30000)
    }
  })

  slot.ws.on('error', e => {
    clog.error('RELAY', `${slotPrefix(slot)} websocket error`, { err: e.message })
  })
}

function connectSlot(slot, limitBytes) {
  if (!config.token || !config.userId) return
  if (slot.ws && (slot.ws.readyState === WebSocket.OPEN || slot.ws.readyState === WebSocket.CONNECTING)) return
  slotLog(slot, 'connecting to relay')
  slot.ws = new WebSocket(RELAY_WS)
  attachSlotSocketHandlers(slot, limitBytes)
}

function connectRelay(limitBytes) {
  if (!config.token || !config.userId) {
    clog.warn('RELAY', 'connectRelay skipped — no token/userId')
    return
  }
  _userStopped = false
  ensureSlotStates().forEach(slot => connectSlot(slot, limitBytes))
  clogState('connectRelay')
}

function stopRelay() {
  _userStopped = true
  config.shareEnabled = false
  saveConfig(config)

  for (const slot of slotStates) {
    if (slot.reconnectTimer) {
      clearTimeout(slot.reconnectTimer)
      slot.reconnectTimer = null
    }
    stopHeartbeat(slot)
    if (slot.ws) {
      slot.ws.removeAllListeners('close')
      slot.ws.close(1000)
      slot.ws = null
    }
    slot.running = false
    slot.connectedAt = null
    closeAllTunnels(slot)
  }

  if (config.token) persistSharingState(false)
}

function getSlotWarning(slots) {
  if (slots > 16) return 'Very high resource usage — recommended for servers or dedicated machines only.'
  if (slots > 8) return 'High resource usage — ensure a stable connection.'
  return null
}

function printStatus(limitBytes) {
  const aggregate = getAggregateStats()
  const totalToday = (config.todaySharedBytes ?? 0) + aggregate.bytesServed
  const active = activeSlotCount()
  const configured = getConnectionSlots()
  const limitStr = limitBytes
    ? `${formatBytes(totalToday)} / ${formatBytes(limitBytes)} today`
    : `${formatBytes(totalToday)} today (no limit)`
  console.log('')
  console.log(`  Sharing active — ${active} / ${configured} slots active`)
  console.log(`  ${aggregate.requestsHandled} requests — ${formatBytes(aggregate.bytesServed)} served`)
  console.log(`  ${limitStr}`)
  const warning = getSlotWarning(configured)
  if (warning) console.log(`  ${warning}`)
  console.log('')
}

function notifyPeer(path, body) {
  if (!peerPort) return
  const init = { method: 'POST', signal: AbortSignal.timeout(1500) }
  if (body) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  fetch(`http://127.0.0.1:${peerPort}${path}`, init).catch(() => {})
}

function buildHandler(port) {
  return http.createServer((req, res) => {
    const origin = req.headers.origin || ''
    res.setHeader('Access-Control-Allow-Origin', origin.includes('peermesh') || origin.includes('localhost') || origin.startsWith('chrome-extension://') ? origin : '')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url, `http://localhost:${port}`)
    clogControl(req.method, url.pathname, { port })

    if (req.method === 'GET' && url.pathname === '/native/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(getStatePayload()))
      return
    }

    if (req.method === 'POST' && url.pathname === '/native/share/start') {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        try {
          const data = JSON.parse(body || '{}')
          if (data.token) config.token = data.token
          if (data.userId) config.userId = data.userId
          if (data.trust) config.trust = data.trust
          if (data.country) config.country = data.country
          if (data.slots != null) config.connectionSlots = clampSlots(data.slots)
          config.shareEnabled = true
          saveConfig(config)
          stopRelay()
          config.shareEnabled = true
          saveConfig(config)
          connectRelay(_controlLimitBytes)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(getStatePayload()))
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: e.message }))
        }
      })
      return
    }

    if (req.method === 'POST' && url.pathname === '/native/share/stop') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(getStatePayload()))
      stopRelay()
      setTimeout(() => process.exit(0), 300)
      return
    }

    if (req.method === 'POST' && url.pathname === '/native/peer/register') {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        try {
          const data = JSON.parse(body || '{}')
          peerPort = data.port
        } catch {}
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      })
      return
    }

    if (req.method === 'POST' && url.pathname === '/quit') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      stopRelay()
      setTimeout(() => process.exit(0), 300)
      return
    }

    res.writeHead(404)
    res.end()
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
    .then(res => {
      clogResponse('POST', `http://127.0.0.1:${targetPort}/native/peer/register`, res.status)
      peerPort = targetPort
    })
    .catch(() => {})
}

function startControlServer() {
  const primary = buildHandler(CONTROL_PORT)
  primary.listen(CONTROL_PORT, '127.0.0.1', () => {
    myPort = CONTROL_PORT
    registerWithPeer(PEER_PORT)
  })
  primary.on('error', err => {
    if (err.code !== 'EADDRINUSE') {
      log(`Control server error: ${err.message}`, 'error')
      return
    }

    const secondary = buildHandler(PEER_PORT)
    secondary.listen(PEER_PORT, '127.0.0.1', async () => {
      myPort = PEER_PORT
      registerWithPeer(CONTROL_PORT)
      try {
        const res = await fetch(`http://127.0.0.1:${CONTROL_PORT}/native/state`, { signal: AbortSignal.timeout(1500) })
        if (res.ok) {
          const state = await res.json()
          if (state.running) log('Desktop is sharing — CLI standing by')
        }
      } catch {}
    })
  })
}

async function authenticate() {
  console.log('  Requesting sign-in code...')
  console.log('')

  let result
  try {
    clogRequest('POST', `${API_BASE}/api/extension-auth`, { device: true })
    const res = await fetch(`${API_BASE}/api/extension-auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: true }),
    })
    result = await res.json()
    clogResponse('POST', `${API_BASE}/api/extension-auth`, res.status, { user_code: result.user_code, interval: result.interval })
  } catch (e) {
    throw new Error('Could not reach server. Check your internet connection.')
  }

  if (result.error) throw new Error(result.error)

  const { device_code, user_code, interval = 3 } = result
  const verificationUri = `${API_BASE}/extension?activate=1`

  console.log(`  Open: ${verificationUri}`)
  console.log(`  Enter code: ${user_code}`)
  console.log('  Waiting for approval...')
  console.log('')

  return new Promise((resolve, reject) => {
    const poll = setInterval(async () => {
      try {
        const res = await fetch(`${API_BASE}/api/extension-auth?device_code=${encodeURIComponent(device_code)}`)
        const data = await res.json()
        if (data.status === 'approved' && data.user) {
          clearInterval(poll)
          resolve(data.user)
        } else if (data.status === 'denied') {
          clearInterval(poll)
          reject(new Error('Sign-in was denied'))
        } else if (data.status === 'expired') {
          clearInterval(poll)
          reject(new Error('Code expired — run again to get a new code'))
        }
      } catch {}
    }, interval * 1000)

    setTimeout(() => {
      clearInterval(poll)
      reject(new Error('Timed out waiting for sign-in'))
    }, 10 * 60 * 1000)
  })
}

function promptYesNo(prompt) {
  return new Promise(resolve => {
    process.stdout.write(prompt)
    process.stdin.setEncoding('utf8')
    process.stdin.resume()
    process.stdin.once('data', input => {
      process.stdin.pause()
      const answer = input.toString().trim().toLowerCase()
      resolve(answer === '' || answer === 'y')
    })
  })
}

async function main() {
  banner()
  console.log(`  Logging to ${DEBUG_LOG}`)
  console.log('')

  if (resetFlag) {
    const keep = { baseDeviceId: config.baseDeviceId, deviceId: config.deviceId, connectionSlots: config.connectionSlots ?? 1 }
    config = keep
    saveConfig(config)
    log('Credentials cleared — please sign in again')
    console.log('')
  }

  if (slotsArg !== undefined) {
    try {
      config.connectionSlots = parseSlotsFlag(slotsArg)
      saveConfig(config)
    } catch (e) {
      console.error(`  x ${e.message}`)
      process.exit(1)
    }
  } else {
    config.connectionSlots = getConnectionSlots()
    saveConfig(config)
  }

  clog.info('PROCESS', '=== CLI START ===', {
    version: VERSION,
    argv: process.argv.slice(2).join(' '),
    baseDeviceId: BASE_DEVICE_ID,
    connectionSlots: getConnectionSlots(),
    logFile: DEBUG_LOG,
  })

  if (!config.token || !config.userId) {
    try {
      const user = await authenticate()
      config.token = user.token
      config.userId = user.id
      config.username = user.username
      config.country = user.country ?? 'RW'
      config.trust = user.trustScore ?? 50
      saveConfig(config)
      console.log(`  Signed in as ${config.username ?? config.userId.slice(0, 8)}`)
      console.log('')
    } catch (e) {
      console.error(`  x ${e.message}`)
      process.exit(1)
    }
  } else {
    try {
      clogRequest('GET', `${API_BASE}/api/extension-auth?verify=1&userId=${config.userId}`)
      const res = await fetch(`${API_BASE}/api/extension-auth?verify=1&userId=${config.userId}`, {
        headers: { Authorization: `Bearer ${config.token}` },
        signal: AbortSignal.timeout(5000),
      })
      clogResponse('GET', `${API_BASE}/api/extension-auth?verify`, res.status)
      if (!res.ok) {
        config.token = null
        config.userId = null
        saveConfig(config)
        return main()
      }
    } catch {
      log('Could not verify session (offline?) — continuing with saved credentials', 'warn')
    }
    log(`Signed in as ${config.username ?? config.userId.slice(0, 8)}`)
  }

  syncUsageDay()
  const profile = await pollTodayBytes()

  if (noLimit || limitArg !== undefined) {
    const newLimit = noLimit ? null : parseInt(limitArg, 10)
    if (limitArg !== undefined && (!Number.isInteger(newLimit) || newLimit < 0)) {
      console.error('  x --limit must be a positive number in MB (e.g. --limit 500)')
      process.exit(1)
    }
    try {
      clogRequest('POST', `${API_BASE}/api/user/sharing`, { dailyLimitMb: newLimit })
      const res = await fetch(`${API_BASE}/api/user/sharing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` },
        body: JSON.stringify({ dailyLimitMb: newLimit }),
      })
      clogResponse('POST', `${API_BASE}/api/user/sharing`, res.status)
    } catch {
      log('Could not save limit to server — using local value', 'warn')
    }
  }

  let limitMb = null
  if (limitArg !== undefined && !noLimit) limitMb = parseInt(limitArg, 10)
  else if (!noLimit && profile?.daily_share_limit_mb) limitMb = profile.daily_share_limit_mb
  const limitBytes = limitMb ? limitMb * 1024 * 1024 : null
  _controlLimitBytes = limitBytes

  if (statusFlag) {
    const slots = getConnectionSlots()
    console.log('')
    console.log(`  User:          ${config.username ?? '—'}`)
    console.log(`  Country:       ${config.country ?? '—'}`)
    console.log(`  Slots:         ${slots}`)
    console.log(`  Shared today:  ${formatBytes(config.todaySharedBytes ?? 0)}`)
    console.log(`  Requests today:${String(config.todayRequestsHandled ?? 0).padStart(2)} `)
    console.log(`  Daily limit:   ${limitMb ? `${limitMb}MB` : 'none'}`)
    console.log('')
    process.exit(0)
  }

  if (limitBytes && (config.todaySharedBytes ?? 0) >= limitBytes) {
    console.log('')
    console.log(`  Daily limit of ${formatBytes(limitBytes)} already reached for today.`)
    console.log('')
    process.exit(0)
  }

  const slots = getConnectionSlots()
  const slotWarning = getSlotWarning(slots)
  console.log(`  Daily limit: ${limitMb ? `${limitMb}MB` : 'none (set with --limit <MB>)'}`)
  console.log(`  Connection slots: ${slots}`)
  if (slotWarning) console.log(`  ${slotWarning}`)
  if ((config.todaySharedBytes ?? 0) > 0) console.log(`  Used today: ${formatBytes(config.todaySharedBytes)}`)
  console.log('')

  if (!serveFlag) {
    const accepted = profile?.has_accepted_provider_terms === true
    if (!accepted) {
      console.log('  Before you share:')
      console.log('  - Your IP will be used by other PeerMesh users to browse the web.')
      console.log('  - All sessions are logged with signed receipts.')
      console.log('  - Blocked: .onion, SMTP/mail, torrents, private IPs.')
      console.log('  - You can stop sharing at any time.')
      console.log('')
      const confirmed = await promptYesNo('  Start sharing? [Y/n]: ')
      if (!confirmed) process.exit(0)
      try {
        await fetch(`${API_BASE}/api/user/sharing`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` },
          body: JSON.stringify({ acceptProviderTerms: true }),
        })
      } catch {}
    }
  }

  ensureSlotStates()
  startControlServer()

  let desktopAlreadySharing = false
  try {
    const res = await fetch(`http://127.0.0.1:${CONTROL_PORT}/native/state`, { signal: AbortSignal.timeout(1500) })
    if (res.ok) {
      const state = await res.json()
      desktopAlreadySharing = !!state.running
    }
  } catch {}

  if (desktopAlreadySharing) {
    log('Desktop is sharing — CLI standing by (press Ctrl+C to stop both)')
  } else {
    config.shareEnabled = true
    saveConfig(config)
    connectRelay(limitBytes)
  }

  async function shutdown(calledByPeer = false) {
    console.log('')
    log('Stopping...')
    if (peerPort && !calledByPeer) {
      try {
        await fetch(`http://127.0.0.1:${peerPort}/native/share/stop`, { method: 'POST', signal: AbortSignal.timeout(2000) })
      } catch {}
    }
    stopRelay()
    const aggregate = getAggregateStats()
    const todayTotal = (config.todaySharedBytes ?? 0) + aggregate.bytesServed
    console.log(`  Session: ${formatBytes(aggregate.bytesServed)} served`)
    console.log(`  Today:   ${formatBytes(todayTotal)} total`)
    console.log('')
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown())
  process.on('SIGTERM', () => {
    stopRelay()
    process.exit(0)
  })
}

main()
