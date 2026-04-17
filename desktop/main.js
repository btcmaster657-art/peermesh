const { app, Tray, Menu, BrowserWindow, nativeImage, ipcMain, shell, Notification } = require('electron')
const { WebSocket } = require('ws')
const path = require('path')
const http = require('http')
const fs = require('fs')

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
const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json')

let tray = null
let settingsWindow = null
let ws = null
let running = false
let config = { token: '', userId: '', country: 'RW', trust: 50, extId: '' }
let stats = { bytesServed: 0, requestsHandled: 0, connectedAt: null }
let reconnectTimer = null
let reconnectDelay = 2000

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

// ── Abuse filter ──────────────────────────────────────────────────────────────

const BLOCKED = [/\.onion$/i, /^smtp\./i, /^mail\./i, /torrent/i]
const PRIVATE = [/^localhost$/i, /^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./]

function isAllowed(hostname) {
  return !BLOCKED.some(p => p.test(hostname)) && !PRIVATE.some(p => p.test(hostname))
}

// ── Fetch handler ─────────────────────────────────────────────────────────────

async function handleFetch(request) {
  const { requestId, url, method = 'GET', headers = {}, body = null } = request
  try {
    const parsed = new URL(url)
    if (!isAllowed(parsed.hostname)) {
      return { requestId, status: 403, headers: {}, body: '', error: 'URL not allowed' }
    }
    const res = await fetch(url, {
      method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        ...headers,
      },
      body: body ?? undefined,
      redirect: 'follow',
    })
    const responseBody = await res.text()
    const responseHeaders = {}
    res.headers.forEach((v, k) => {
      if (!['content-encoding', 'transfer-encoding', 'connection'].includes(k)) {
        responseHeaders[k] = v
      }
    })
    stats.bytesServed += responseBody.length
    stats.requestsHandled++
    return { requestId, status: res.status, headers: responseHeaders, body: responseBody, finalUrl: res.url }
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
    ws.send(JSON.stringify({
      type: 'register_provider',
      userId: config.userId,
      country: config.country,
      trustScore: config.trust,
      agentMode: true,
    }))
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
      } else if (msg.type === 'session_ended') {
        updateTray()
      }
    } catch {}
  })

  ws.on('close', (code) => {
    running = false
    stats.connectedAt = null
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
  stats = { bytesServed: 0, requestsHandled: 0, connectedAt: null }
  updateTray()
}

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
    res.end(JSON.stringify({ running, country: config.country, userId: config.userId?.slice(0, 8), proxyPort: RELAY_PROXY_PORT, stats, version: '1.0.0' }))
    return
  }
  if (req.method === 'POST' && url.pathname === '/start') {
    let body = ''
    req.on('data', d => body += d)
    req.on('end', () => {
      try {
        const data = JSON.parse(body)
        config = { ...config, ...data }
        saveConfig()
        stopRelay()
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
  try {
    const res = await fetch(`${API_BASE}/api/extension-auth?ext_id=${config.extId}`)
    if (!res.ok) return null
    const data = await res.json()
    return data.user ?? null
  } catch { return null }
})

ipcMain.handle('open-auth', () => {
  shell.openExternal(`${API_BASE}/auth?mode=login&source=desktop&ext_id=${config.extId}`)
})

ipcMain.handle('get-state', () => ({
  running,
  config: { ...config, token: config.token ? '***' : '' },
  stats,
}))

ipcMain.handle('sign-in', (_, { token, userId, country, trust }) => {
  config = { ...config, token, userId, country, trust }
  saveConfig()
  connectRelay()
  return { success: true }
})

ipcMain.handle('toggle-sharing', () => {
  if (running) { stopRelay() } else if (config.token) { connectRelay() }
  return { running }
})

ipcMain.handle('sign-out', () => {
  stopRelay()
  config = { token: '', userId: '', country: 'RW', trust: 50 }
  saveConfig()
  updateTray()
  return { success: true }
})

ipcMain.handle('open-dashboard', () => {
  shell.openExternal(`${API_BASE}/dashboard`)
})

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
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
      // Port is free — start control server
      controlServer.listen(CONTROL_PORT, '127.0.0.1')
    })
  })
  tester.listen(CONTROL_PORT, '127.0.0.1')

  if (config.token && config.userId) {
    connectRelay()
  } else {
    showWindow()
  }
})

app.on('before-quit', () => {
  stopRelay()
  controlServer.close()
})

app.on('quit', () => process.exit(0))
