// const { app, Tray, Menu, BrowserWindow, nativeImage, ipcMain, shell, Notification } = require('electron')
// const { WebSocket } = require('ws')
// const path = require('path')
// const http = require('http')
// const net = require('net')
// const fs = require('fs')
// const os = require('os')
// const { spawn, spawnSync } = require('child_process')

// // ── Logger ────────────────────────────────────────────────────────────────────

// const LOG_FILE = path.join(os.homedir(), 'Desktop', 'peermesh-debug.log')

// function log(...args) {
//   const line = `[${new Date().toISOString()}] [DESKTOP] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ')}`
//   console.log(line)
//   try { fs.appendFileSync(LOG_FILE, line + '\n') } catch {}
// }

// function logState(label) {
//   log(`STATE(${label}) running=${running} shareEnabled=${config.shareEnabled} peerSharing=${peerSharing} peerPort=${peerPort} wsState=${ws ? ws.readyState : 'null'} tunnels=${activeTunnels.size}`)
// }

// // Prevent uncaught errors from showing Electron's error dialog
// process.on('uncaughtException', (err) => {
//   log('uncaughtException', err.message, err.stack)
//   if (err.code === 'EADDRINUSE') return
// })

// const API_BASE = 'https://peermesh-beta.vercel.app'
// const RELAY_WS = 'wss://peermesh-relay.fly.dev'
// const RELAY_PROXY_PORT = 8081
// const CONTROL_PORT = 7654
// const LOCAL_PROXY_PORT = 7655
// const PEER_PORT = 7656  // CLI binds here when desktop already owns 7654
// const NATIVE_HOST_NAME = 'com.peermesh.desktop'
// const EXTENSION_ID = 'chpkbnnohdiohlejmpmjmnmjgokalllm'
// const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}/`
// const DESKTOP_VERSION = require('./package.json').version
// const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json')
// const IS_NATIVE_HOST_MODE = process.argv.some(arg => arg.startsWith('chrome-extension://')) || process.argv.some(arg => arg.startsWith('--parent-window='))
// const IS_BACKGROUND_LAUNCH = process.argv.includes('--background')

// let peerPort = null       // port of the other process (CLI), set via /native/peer/register
// let peerSharing = false   // true when the peer process is the active relay sharer
// let _sharingToggleBusy = false
// let _cliWatchTimer = null

// function notifyPeer(path, body) {
//   if (!peerPort) return
//   log(`notifyPeer → port=${peerPort} path=${path}`)
//   const init = { method: 'POST', signal: AbortSignal.timeout(1500) }
//   if (body) { init.headers = { 'Content-Type': 'application/json' }; init.body = JSON.stringify(body) }
//   fetch(`http://127.0.0.1:${peerPort}${path}`, init).catch(e => log(`notifyPeer failed path=${path} err=${e.message}`))
// }

// let tray = null
// let settingsWindow = null
// let ws = null
// let running = false
// let config = { token: '', userId: '', country: 'RW', trust: 50, extId: '', shareEnabled: false }
// let stats = { bytesServed: 0, requestsHandled: 0, connectedAt: null }
// let reconnectTimer = null
// let reconnectDelay = 2000
// const activeTunnels = new Map()

// function sendRelayMessage(data) {
//   if (ws?.readyState === WebSocket.OPEN) {
//     ws.send(JSON.stringify(data))
//   }
// }

// function closeTunnel(tunnelId, notifyRelay = false) {
//   const tunnel = activeTunnels.get(tunnelId)
//   if (!tunnel || tunnel.closed) return

//   tunnel.closed = true
//   activeTunnels.delete(tunnelId)

//   if (notifyRelay) {
//     sendRelayMessage({ type: 'tunnel_close', tunnelId })
//   }

//   if (!tunnel.socket.destroyed) {
//     tunnel.socket.destroy()
//   }
// }

// function closeAllTunnels(notifyRelay = false) {
//   for (const tunnelId of [...activeTunnels.keys()]) {
//     closeTunnel(tunnelId, notifyRelay)
//   }
// }

// // ── Config ────────────────────────────────────────────────────────────────────

// function loadConfig() {
//   try {
//     if (fs.existsSync(CONFIG_FILE)) {
//       config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) }
//       log('config loaded — userId:', config.userId || '(none)', 'shareEnabled:', config.shareEnabled)
//     } else {
//       log('no config file found at', CONFIG_FILE)
//     }
//   } catch (e) { log('loadConfig error:', e.message) }
//   if (!config.extId) {
//     config.extId = require('crypto').randomUUID()
//     saveConfig()
//   }
// }

// function saveConfig() {
//   try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config)) } catch {}
// }

// function getPublicState() {
//   return {
//     running,
//     shareEnabled: !!config.shareEnabled,
//     config: { ...config, token: config.token ? '***' : '' },
//     stats,
//     version: DESKTOP_VERSION,
//   }
// }

// async function persistSharingState(isSharing) {
//   if (!config.token) return
//   try {
//     await fetch(`${API_BASE}/api/user/sharing`, {
//       method: 'POST',
//       headers: {
//         'Content-Type': 'application/json',
//         'Authorization': `Bearer ${config.token}`,
//       },
//       body: JSON.stringify({ isSharing }),
//     })
//   } catch {}
// }

// function getNativeHostManifestPath() {
//   if (process.platform === 'win32') {
//     return path.join(app.getPath('userData'), 'native-messaging', `${NATIVE_HOST_NAME}.json`)
//   }
//   if (process.platform === 'darwin') {
//     return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts', `${NATIVE_HOST_NAME}.json`)
//   }
//   return path.join(os.homedir(), '.config', 'google-chrome', 'NativeMessagingHosts', `${NATIVE_HOST_NAME}.json`)
// }

// function registerNativeMessagingHost() {
//   try {
//     const manifestPath = getNativeHostManifestPath()
//     fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
//     fs.writeFileSync(manifestPath, JSON.stringify({
//       name: NATIVE_HOST_NAME,
//       description: 'PeerMesh desktop helper',
//       path: process.execPath,
//       type: 'stdio',
//       allowed_origins: [EXTENSION_ORIGIN],
//     }, null, 2))

//     if (process.platform === 'win32') {
//       spawnSync('reg', [
//         'ADD',
//         `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
//         '/ve',
//         '/t',
//         'REG_SZ',
//         '/d',
//         manifestPath,
//         '/f',
//       ], { stdio: 'ignore' })
//     }
//   } catch (err) {
//     console.error('Failed to register native host:', err)
//   }
// }

// function writeNativeMessage(payload) {
//   const body = Buffer.from(JSON.stringify(payload), 'utf8')
//   const header = Buffer.alloc(4)
//   header.writeUInt32LE(body.length, 0)
//   process.stdout.write(header)
//   process.stdout.write(body)
// }

// function launchMainApp() {
//   const args = app.isPackaged ? ['--background'] : [app.getAppPath(), '--background']
//   const child = spawn(process.execPath, args, {
//     detached: true,
//     stdio: 'ignore',
//   })
//   child.unref()
// }

// async function waitForControlServer(timeoutMs = 15000) {
//   const started = Date.now()
//   while (Date.now() - started < timeoutMs) {
//     try {
//       const res = await fetch(`http://127.0.0.1:${CONTROL_PORT}/native/state`, { signal: AbortSignal.timeout(1500) })
//       if (res.ok) return true
//     } catch {}
//     await new Promise(resolve => setTimeout(resolve, 500))
//   }
//   return false
// }

// async function callControl(pathname, { method = 'GET', body } = {}) {
//   const init = { method, signal: AbortSignal.timeout(4000), headers: {} }
//   if (body !== undefined) {
//     init.headers['Content-Type'] = 'application/json'
//     init.body = JSON.stringify(body)
//   }
//   const res = await fetch(`http://127.0.0.1:${CONTROL_PORT}${pathname}`, init)
//   const text = await res.text()
//   let data = {}
//   try { data = text ? JSON.parse(text) : {} } catch {}
//   if (!res.ok) throw new Error(data.error || `Control request failed (${res.status})`)
//   return data
// }

// async function getNativeState() {
//   try {
//     return await callControl('/native/state')
//   } catch {
//     return {
//       available: true,
//       running: false,
//       shareEnabled: false,
//       configured: false,
//       version: DESKTOP_VERSION,
//     }
//   }
// }

// async function ensureDesktopApp() {
//   try {
//     await callControl('/native/state')
//     return true
//   } catch {}

//   launchMainApp()
//   return waitForControlServer()
// }

// async function handleNativeHostMessage(message) {
//   switch (message.type) {
//     case 'status':
//       return { success: true, ...(await getNativeState()) }
//     case 'sync_auth': {
//       const ok = await ensureDesktopApp()
//       if (!ok) return { success: false, error: 'Desktop helper did not start' }
//       const state = await callControl('/native/auth', { method: 'POST', body: message.payload || {} })
//       return { success: true, ...state }
//     }
//     case 'start_sharing': {
//       const ok = await ensureDesktopApp()
//       if (!ok) return { success: false, error: 'Desktop helper did not start' }
//       const state = await callControl('/native/share/start', { method: 'POST', body: message.payload || {} })
//       return { success: true, ...state }
//     }
//     case 'stop_sharing': {
//       const ok = await ensureDesktopApp()
//       if (!ok) return { success: false, error: 'Desktop helper did not start' }
//       const state = await callControl('/native/share/stop', { method: 'POST' })
//       return { success: true, ...state }
//     }
//     case 'show_app': {
//       const ok = await ensureDesktopApp()
//       if (!ok) return { success: false, error: 'Desktop helper did not start' }
//       const state = await callControl('/native/show', { method: 'POST' })
//       return { success: true, ...state }
//     }
//     default:
//       return { success: false, error: 'Unknown native host command' }
//   }
// }

// function runNativeHostMode() {
//   let buffer = Buffer.alloc(0)

//   process.stdin.on('data', async (chunk) => {
//     buffer = Buffer.concat([buffer, chunk])
//     while (buffer.length >= 4) {
//       const messageLength = buffer.readUInt32LE(0)
//       if (buffer.length < 4 + messageLength) return

//       const body = buffer.slice(4, 4 + messageLength).toString('utf8')
//       buffer = buffer.slice(4 + messageLength)

//       try {
//         const message = JSON.parse(body)
//         const response = await handleNativeHostMessage(message)
//         writeNativeMessage(response)
//       } catch (err) {
//         writeNativeMessage({ success: false, error: err.message || 'Native host error' })
//       }
//     }
//   })
//   process.stdin.on('end', () => process.exit(0))
// }

// // ── Abuse filter ──────────────────────────────────────────────────────────────

// const BLOCKED = [/\.onion$/i, /^smtp\./i, /^mail\./i, /torrent/i]
// const PRIVATE = [/^localhost$/i, /^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./]

// function isAllowed(hostname) {
//   return !BLOCKED.some(p => p.test(hostname)) && !PRIVATE.some(p => p.test(hostname))
// }

// // ── Fetch handler — plain Node fetch (no Playwright dependency) ──────────────

// async function handleFetch(request) {
//   const { requestId, url, method = 'GET', headers = {}, body = null } = request
//   try {
//     const parsed = new URL(url)
//     if (!isAllowed(parsed.hostname)) {
//       return { requestId, status: 403, headers: {}, body: '', error: 'URL not allowed' }
//     }
//     log(`  -> ${method} ${url}`)
//     const res = await fetch(url, {
//       method,
//       headers: {
//         'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
//         'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
//         'Accept-Language': 'en-US,en;q=0.5',
//         'Cache-Control': 'no-cache',
//         ...headers,
//       },
//       body: body ?? undefined,
//       redirect: 'follow',
//       signal: AbortSignal.timeout(20000),
//     })
//     const responseBody = await res.text()
//     const responseHeaders = {}
//     res.headers.forEach((v, k) => {
//       if (!['content-encoding', 'transfer-encoding', 'connection', 'keep-alive'].includes(k)) {
//         responseHeaders[k] = v
//       }
//     })
//     const bodyLen = responseBody.length
//     stats.bytesServed += bodyLen
//     stats.requestsHandled++
//     log(`  <- ${res.status} ${url} (${bodyLen}b)`)
//     flushStats(bodyLen)
//     return { requestId, status: res.status, headers: responseHeaders, body: responseBody, finalUrl: res.url }
//   } catch (err) {
//     log(`  x ${url}: ${err.message}`)
//     return { requestId, status: 502, headers: {}, body: '', error: err.message }
//   }
// }

// // ── Relay ─────────────────────────────────────────────────────────────────────

// let heartbeatTimer = null

// function startHeartbeat() {
//   // Always clear existing timer before starting — handles reconnect after crash
//   if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
//   sendHeartbeat()
//   heartbeatTimer = setInterval(sendHeartbeat, 30_000)
// }

// // ── Stats flush — write bytes to Supabase in batches ────────────────────────
// let _pendingBytes = 0
// let _flushTimer = null

// function flushStats(bytes) {
//   _pendingBytes += bytes
//   if (_flushTimer) return
//   _flushTimer = setTimeout(async () => {
//     _flushTimer = null
//     const toFlush = _pendingBytes
//     _pendingBytes = 0
//     if (!toFlush || !config.token || !config.userId) return
//     try {
//       await fetch(`${API_BASE}/api/user/sharing`, {
//         method: 'POST',
//         headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` },
//         body: JSON.stringify({ bytes: toFlush }),
//       })
//     } catch {}
//   }, 5000) // batch writes every 5s
// }

// function stopHeartbeat() {
//   if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
//   if (!config.token || !config.userId) return
//   // Tell server this device stopped sharing
//   fetch(`${API_BASE}/api/user/sharing`, {
//     method: 'DELETE',
//     headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` },
//     body: JSON.stringify({ device_id: config.extId }),
//   }).catch(() => {})
// }

// function sendHeartbeat() {
//   if (!config.token || !config.userId || !config.extId) return
//   fetch(`${API_BASE}/api/user/sharing`, {
//     method: 'PUT',
//     headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` },
//     body: JSON.stringify({ device_id: config.extId }),
//   })
//     .then(r => { if (!r.ok) r.json().then(b => log('[HEARTBEAT] PUT failed status=' + r.status, b)) })
//     .catch(e => log('[HEARTBEAT] PUT error:', e.message))
// }

// function connectRelay() {
//   if (!config.token || !config.userId) {
//     log('connectRelay skipped — no token/userId')
//     return
//   }
//   // Prevent duplicate connections
//   if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
//     log('connectRelay skipped — already connected/connecting')
//     return
//   }
//   log('connectRelay START — userId:', config.userId, 'country:', config.country, 'relay:', RELAY_WS)
//   logState('pre-connect')
//   ws = new WebSocket(RELAY_WS)

//   ws.on('open', () => {
//     log('relay WS open — sending register_provider')
//     running = true
//     reconnectDelay = 2000
//     if (!config.shareEnabled) {
//       log('shareEnabled=false after WS open — aborting, closing WS')
//       ws.close(1000)
//       return
//     }
//     const reg = {
//       type: 'register_provider',
//       userId: config.userId,
//       country: config.country,
//       trustScore: config.trust,
//       agentMode: true,
//       providerKind: 'desktop',
//       supportsHttp: true,
//       supportsTunnel: true,
//     }
//     log('register_provider payload:', reg)
//     ws.send(JSON.stringify(reg))
//     startHeartbeat()
//     logState('post-register-send')
//     updateTray()
//   })

//   // Respond to relay WebSocket ping frames to prevent heartbeat timeout
//   ws.on('ping', () => { try { ws.pong() } catch {} })

//   ws.on('message', async (data) => {
//     try {
//       const msg = JSON.parse(data.toString())
//       if (msg.type !== 'tunnel_data' && msg.type !== 'proxy_ws_data') log('relay msg:', msg.type, msg.sessionId ? 'session=' + msg.sessionId.slice(0,8) : '', msg.tunnelId ? 'tunnel=' + msg.tunnelId.slice(0,8) : '', msg.message || '')
//       if (msg.type === 'registered') {
//         stats.connectedAt = new Date().toISOString()
//         log('REGISTERED — sharing active, country:', config.country)
//         logState('registered')
//         showNotification('PeerMesh Active', `Sharing your ${config.country} connection`)
//         updateTray()
//       } else if (msg.type === 'error') {
//         log('relay error message:', msg.message)
//         if (msg.message?.includes('Replaced')) {
//           log('EVICTED by newer instance — stopping cleanly')
//           logState('evicted')
//           ws.removeAllListeners('close')
//           ws.close(1000)
//           running = false
//           updateTray()
//         }
//       } else if (msg.type === 'proxy_ws_open') {
//         // Extension opened a proxy WS tunnel — we are the provider endpoint
//         // All subsequent proxy_ws_data frames are raw TCP data to/from the target
//         // The extension handles the HTTP CONNECT handshake itself before sending data
//         log('proxy_ws_open for session', msg.sessionId?.slice(0,8))
//         // Nothing to do here — data arrives via proxy_ws_data
//       } else if (msg.type === 'proxy_ws_data') {
//         // Raw TCP data from extension → write to the target socket for this session
//         const tunnel = activeTunnels.get(`ws_${msg.sessionId}`)
//         if (tunnel?.socket && !tunnel.socket.destroyed) {
//           tunnel.socket.write(Buffer.from(msg.data, 'base64'))
//         }
//       } else if (msg.type === 'proxy_ws_close') {
//         const tunnel = activeTunnels.get(`ws_${msg.sessionId}`)
//         if (tunnel) {
//           if (!tunnel.socket.destroyed) tunnel.socket.destroy()
//           activeTunnels.delete(`ws_${msg.sessionId}`)
//         }
//       } else if (msg.type === 'session_request') {
//         log('session_request received sessionId:', msg.sessionId?.slice(0,8))
//         ws.send(JSON.stringify({ type: 'agent_ready', sessionId: msg.sessionId }))
//       } else if (msg.type === 'proxy_request') {
//         log('proxy_request url:', msg.request?.url?.slice(0,80))
//         const response = await handleFetch(msg.request)
//         ws.send(JSON.stringify({ type: 'proxy_response', sessionId: msg.sessionId, response }))
//       } else if (msg.type === 'open_tunnel') {
//         log('open_tunnel', msg.hostname + ':' + msg.port, 'tunnelId:', msg.tunnelId?.slice(0,8), 'activeTunnels:', activeTunnels.size)
//         const socket = net.connect(msg.port, msg.hostname)
//         activeTunnels.set(msg.tunnelId, { socket, closed: false, sessionId: msg.sessionId ?? null })
//         socket.on('connect', () => {
//           log('open_tunnel TCP connected', msg.hostname + ':' + msg.port, 'tunnelId:', msg.tunnelId?.slice(0,8))
//           sendRelayMessage({ type: 'tunnel_ready', tunnelId: msg.tunnelId })
//         })
//         socket.on('data', (chunk) => {
//           sendRelayMessage({ type: 'tunnel_data', tunnelId: msg.tunnelId, data: chunk.toString('base64') })
//           stats.bytesServed += chunk.length
//           stats.requestsHandled++
//           flushStats(chunk.length)
//         })
//         socket.on('end', () => { log('open_tunnel TCP end', msg.tunnelId?.slice(0,8)); closeTunnel(msg.tunnelId, true) })
//         socket.on('close', () => activeTunnels.delete(msg.tunnelId))
//         socket.on('error', (e) => { log('open_tunnel TCP error', msg.hostname, e.message, 'tunnelId:', msg.tunnelId?.slice(0,8)); closeTunnel(msg.tunnelId, true) })
//       } else if (msg.type === 'tunnel_data') {
//         const tunnel = activeTunnels.get(msg.tunnelId)
//         if (tunnel?.socket && !tunnel.socket.destroyed) {
//           tunnel.socket.write(Buffer.from(msg.data, 'base64'))
//         }
//       } else if (msg.type === 'tunnel_close') {
//         closeTunnel(msg.tunnelId, false)
//       } else if (msg.type === 'session_ended') {
//         closeAllTunnels(false)
//         updateTray()
//       }
//     } catch {}
//   })

//   ws.on('close', (code, reason) => {
//     log('relay WS closed — code:', code, 'reason:', reason?.toString() || '(none)')
//     running = false
//     stats.connectedAt = null
//     closeAllTunnels(false)
//     ws = null
//     logState('ws-closed')
//     updateTray()
//     if (code !== 1000 && config.shareEnabled) {
//       log(`scheduling reconnect in ${reconnectDelay}ms`)
//       reconnectTimer = setTimeout(connectRelay, reconnectDelay)
//       reconnectDelay = Math.min(reconnectDelay * 2, 30000)
//     } else {
//       log('no reconnect — code=1000 or shareEnabled=false')
//     }
//   })

//   ws.on('error', (e) => { log('relay WS error:', e.code || '', e.message) })
// }

// function stopRelay() {
//   log('stopRelay called')
//   logState('pre-stop')
//   if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
//   if (ws) { ws.removeAllListeners('close'); ws.close(1000); ws = null }
//   running = false
//   config.shareEnabled = false
//   saveConfig()
//   closeAllTunnels(false)
//   stats = { bytesServed: 0, requestsHandled: 0, connectedAt: null }
//   stopHeartbeat()
//   persistSharingState(false)
//   logState('post-stop')
//   updateTray()
// }

// // ── Local HTTP proxy server (for extension) ───────────────────────────────────
// // Extension sets Chrome proxy to 127.0.0.1:7655. This server forwards
// // all traffic through the relay WebSocket to the connected peer provider.

// let proxySession = null // { sessionId, relayEndpoint }

// function openTunnelWs(hostname, port, onOpen) {
//   if (!proxySession?.sessionId) return null
//   const relayRaw = proxySession.relayEndpoint || RELAY_WS
//   const relayHttp = relayRaw.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
//   const relayOrigin = new URL(relayHttp).origin.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:')
//   const proxyUrl = `${relayOrigin}/proxy?session=${encodeURIComponent(proxySession.sessionId)}`
//   const tunnelWs = new WebSocket(proxyUrl)
//   tunnelWs.on('open', () => {
//     tunnelWs.send(`CONNECT ${hostname}:${port} HTTP/1.1\r\nHost: ${hostname}:${port}\r\n\r\n`)
//     if (onOpen) onOpen()
//   })
//   return tunnelWs
// }

// const localProxyServer = http.createServer((req, res) => {
//   if (!proxySession?.sessionId) {
//     log('[LOCAL-PROXY] HTTP rejected — no session')
//     res.writeHead(503); res.end('No PeerMesh session'); return
//   }
//   const parsed = new URL(req.url.startsWith('http') ? req.url : `http://${req.headers.host}${req.url}`)
//   const hostname = parsed.hostname
//   const port = parseInt(parsed.port) || 80
//   log('[LOCAL-PROXY] HTTP', req.method, parsed.href.slice(0, 80))

//   const chunks = []
//   req.on('data', c => chunks.push(c))
//   req.on('end', () => {
//     const body = Buffer.concat(chunks)
//     const tunnelWs = openTunnelWs(hostname, port)
//     if (!tunnelWs) { res.writeHead(503); res.end('No PeerMesh session'); return }

//     let ready = false
//     let responseData = Buffer.alloc(0)

//     tunnelWs.on('message', (data) => {
//       const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data)
//       if (!ready) {
//         responseData = Buffer.concat([responseData, chunk])
//         const headerEnd = responseData.indexOf('\r\n\r\n')
//         if (headerEnd === -1) return
//         const firstLine = responseData.slice(0, responseData.indexOf('\r\n')).toString()
//         if (!firstLine.includes('200')) {
//           log('[LOCAL-PROXY] HTTP tunnel rejected:', firstLine)
//           res.writeHead(502); res.end('Bad Gateway'); tunnelWs.close(); return
//         }
//         ready = true
//         // Send the HTTP request over the tunnel
//         const reqLine = `${req.method} ${parsed.pathname}${parsed.search} HTTP/1.1\r\n`
//         const hdrs = Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')
//         tunnelWs.send(Buffer.from(`${reqLine}${hdrs}\r\n\r\n`))
//         if (body.length) tunnelWs.send(body)
//         responseData = responseData.slice(headerEnd + 4)
//         return
//       }
//       responseData = Buffer.concat([responseData, chunk])
//     })

//     tunnelWs.on('close', () => {
//       if (!res.headersSent && responseData.length) {
//         // Parse HTTP response from buffer
//         const headerEnd = responseData.indexOf('\r\n\r\n')
//         if (headerEnd !== -1) {
//           const headerStr = responseData.slice(0, headerEnd).toString()
//           const lines = headerStr.split('\r\n')
//           const statusMatch = lines[0].match(/HTTP\/\S+ (\d+)/)
//           const status = statusMatch ? parseInt(statusMatch[1]) : 200
//           const hdrs = {}
//           for (const line of lines.slice(1)) {
//             const idx = line.indexOf(':')
//             if (idx > 0) hdrs[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim()
//           }
//           delete hdrs['transfer-encoding']; delete hdrs['content-encoding']
//           res.writeHead(status, hdrs)
//           res.end(responseData.slice(headerEnd + 4))
//         } else {
//           res.writeHead(502); res.end('Bad Gateway')
//         }
//       } else if (!res.headersSent) {
//         res.writeHead(502); res.end('Bad Gateway')
//       }
//     })

//     tunnelWs.on('error', (e) => {
//       log('[LOCAL-PROXY] HTTP tunnel error', e.message)
//       if (!res.headersSent) { res.writeHead(502); res.end('Bad Gateway') }
//     })

//     setTimeout(() => {
//       if (!res.headersSent) {
//         log('[LOCAL-PROXY] HTTP timeout for', parsed.href.slice(0, 60))
//         tunnelWs.terminate(); res.writeHead(504); res.end('Timeout')
//       }
//     }, 30000)
//   })
// })

// localProxyServer.on('connect', (req, clientSocket, head) => {
//   const [hostname, portStr] = (req.url || '').split(':')
//   const port = parseInt(portStr) || 443
//   log('[LOCAL-PROXY] CONNECT', hostname + ':' + port, '| sessionId:', proxySession?.sessionId?.slice(0,8) || 'NONE')

//   if (!proxySession?.sessionId) {
//     log('[LOCAL-PROXY] CONNECT rejected — no proxySession')
//     clientSocket.write('HTTP/1.1 503 No PeerMesh Session\r\n\r\n')
//     clientSocket.destroy()
//     return
//   }

//   let opened = false
//   const tunnelWs = openTunnelWs(hostname, port, () => { opened = true })
//   if (!tunnelWs) {
//     clientSocket.write('HTTP/1.1 503 No PeerMesh Session\r\n\r\n')
//     clientSocket.destroy()
//     return
//   }
//   log('[LOCAL-PROXY] opening tunnel WS for', hostname + ':' + port)

//   tunnelWs.on('message', (data) => {
//     const text = Buffer.isBuffer(data) ? data.toString() : data
//     if (!clientSocket._connectSent && text.startsWith('HTTP/1.1 200')) {
//       clientSocket._connectSent = true
//       log('[LOCAL-PROXY] tunnel ready → 200 sent to Chrome for', hostname + ':' + port)
//       clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
//       if (head?.length) tunnelWs.send(head)
//       clientSocket.on('data', (chunk) => {
//         if (tunnelWs.readyState === WebSocket.OPEN) tunnelWs.send(chunk)
//       })
//       clientSocket.on('end', () => tunnelWs.close())
//       clientSocket.on('error', (e) => { log('[LOCAL-PROXY] clientSocket error', e.message); tunnelWs.close() })
//       return
//     }
//     if (!clientSocket.destroyed) clientSocket.write(Buffer.isBuffer(data) ? data : Buffer.from(data))
//   })

//   tunnelWs.on('close', (code, reason) => {
//     log('[LOCAL-PROXY] tunnel WS closed', hostname + ':' + port, 'code=' + code, reason?.toString() || '')
//     if (!clientSocket.destroyed) clientSocket.destroy()
//   })

//   tunnelWs.on('error', (e) => {
//     log('[LOCAL-PROXY] tunnel WS error', hostname + ':' + port, e.message)
//     if (!opened) clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
//     if (!clientSocket.destroyed) clientSocket.destroy()
//   })

//   setTimeout(() => {
//     if (!opened) {
//       log('[LOCAL-PROXY] tunnel timeout for', hostname + ':' + port)
//       tunnelWs.terminate()
//       clientSocket.write('HTTP/1.1 504 Tunnel Timeout\r\n\r\n')
//       clientSocket.destroy()
//     }
//   }, 15000)
// })

// // ── Control server ────────────────────────────────────────────────────────────

// const controlServer = http.createServer((req, res) => {
//   const origin = req.headers.origin || ''
//   res.setHeader('Access-Control-Allow-Origin', origin.includes('peermesh') || origin.includes('localhost') || origin.startsWith('chrome-extension://') ? origin : '')
//   res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
//   res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
//   if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

//   const url = new URL(req.url, `http://localhost:${CONTROL_PORT}`)

//   if (req.method === 'GET' && url.pathname === '/health') {
//     res.writeHead(200, { 'Content-Type': 'application/json' })
//     res.end(JSON.stringify({
//       running,
//       shareEnabled: !!config.shareEnabled,
//       country: config.country,
//       userId: config.userId?.slice(0, 8),
//       proxyPort: RELAY_PROXY_PORT,
//       stats,
//       version: DESKTOP_VERSION,
//     }))
//     return
//   }
//   if (req.method === 'GET' && url.pathname === '/native/state') {
//     res.writeHead(200, { 'Content-Type': 'application/json' })
//     res.end(JSON.stringify({
//       available: true,
//       running,
//       shareEnabled: !!config.shareEnabled,
//       configured: !!(config.token && config.userId),
//       country: config.country,
//       userId: config.userId,
//       version: DESKTOP_VERSION,
//       where: 'desktop',
//       stats,
//     }))
//     return
//   }
//   if (req.method === 'POST' && url.pathname === '/native/auth') {
//     let body = ''
//     req.on('data', d => body += d)
//     req.on('end', async () => {
//       try {
//         const data = JSON.parse(body || '{}')
//         // Verify the desktop token before accepting it
//         if (data.token) {
//           try {
//             const vRes = await fetch(`${API_BASE}/api/extension-auth?verify=1&userId=${encodeURIComponent(data.userId || '')}`, {
//               headers: { 'Authorization': `Bearer ${data.token}` },
//               signal: AbortSignal.timeout(5000),
//             })
//             if (!vRes.ok) {
//               res.writeHead(401, { 'Content-Type': 'application/json' })
//               res.end(JSON.stringify({ error: 'Token verification failed' }))
//               return
//             }
//           } catch { /* offline — allow if token format looks valid */ }
//         }
//         config = {
//           ...config,
//           token: data.token ?? config.token,
//           userId: data.userId ?? config.userId,
//           country: data.country ?? config.country,
//           trust: data.trust ?? config.trust,
//         }
//         saveConfig()
//         updateTray()
//         res.writeHead(200, { 'Content-Type': 'application/json' })
//         res.end(JSON.stringify({
//           available: true,
//           running,
//           shareEnabled: !!config.shareEnabled,
//           configured: !!(config.token && config.userId),
//           country: config.country,
//           userId: config.userId,
//           version: DESKTOP_VERSION,
//         }))
//       } catch (e) {
//         res.writeHead(400, { 'Content-Type': 'application/json' })
//         res.end(JSON.stringify({ error: e.message }))
//       }
//     })
//     return
//   }
//   if (req.method === 'POST' && url.pathname === '/native/share/start') {
//     let body = ''
//     req.on('data', d => body += d)
//     req.on('end', () => {
//       try {
//         const data = JSON.parse(body || '{}')
//         log('/native/share/start — userId:', data.userId || config.userId, 'country:', data.country || config.country)
//         config = {
//           ...config,
//           token: data.token ?? config.token,
//           userId: data.userId ?? config.userId,
//           country: data.country ?? config.country,
//           trust: data.trust ?? config.trust,
//           shareEnabled: true,
//         }
//         saveConfig()
//         logState('share/start')
//         if (!running) connectRelay()
//         updateTray()
//         res.writeHead(200, { 'Content-Type': 'application/json' })
//         res.end(JSON.stringify({
//           available: true, running: true, shareEnabled: true,
//           configured: !!(config.token && config.userId),
//           country: config.country, userId: config.userId, version: DESKTOP_VERSION,
//         }))
//       } catch (e) {
//         res.writeHead(400, { 'Content-Type': 'application/json' })
//         res.end(JSON.stringify({ error: e.message }))
//       }
//     })
//     return
//   }
//   if (req.method === 'POST' && url.pathname === '/native/share/stop') {
//     log('/native/share/stop called')
//     stopRelay()
//     // Eagerly persist false so dashboard sees it immediately
//     persistSharingState(false)
//     res.writeHead(200, { 'Content-Type': 'application/json' })
//     res.end(JSON.stringify({
//       available: true, running: false, shareEnabled: false,
//       configured: !!(config.token && config.userId),
//       country: config.country, userId: config.userId, version: DESKTOP_VERSION,
//     }))
//     return
//   }
//   if (req.method === 'POST' && url.pathname === '/native/peer/register') {
//     let body = ''
//     req.on('data', d => body += d)
//     req.on('end', () => {
//       try {
//         const parsed = JSON.parse(body)
//         peerPort = parsed.port
//         log('/native/peer/register — peerPort set to', peerPort, 'where:', parsed.where)
//         logState('peer-registered')
//       } catch {}
//       res.writeHead(200, { 'Content-Type': 'application/json' })
//       res.end(JSON.stringify({ ok: true }))
//     })
//     return
//   }
//   if (req.method === 'POST' && url.pathname === '/native/show') {
//     showWindow()
//     res.writeHead(200, { 'Content-Type': 'application/json' })
//     res.end(JSON.stringify({
//       available: true,
//       running,
//       shareEnabled: !!config.shareEnabled,
//       configured: !!(config.token && config.userId),
//       country: config.country,
//       userId: config.userId,
//       version: DESKTOP_VERSION,
//     }))
//     return
//   }
//   if (req.method === 'POST' && url.pathname === '/start') {
//     let body = ''
//     req.on('data', d => body += d)
//     req.on('end', () => {
//       try {
//         const data = JSON.parse(body)
//         log('/start called — userId:', data.userId || config.userId)
//         config = { ...config, ...data, shareEnabled: true }
//         saveConfig()
//         stopRelay()
//         config.shareEnabled = true
//         saveConfig()
//         connectRelay()
//         res.writeHead(200, { 'Content-Type': 'application/json' })
//         res.end(JSON.stringify({ success: true }))
//       } catch (e) {
//         res.writeHead(400)
//         res.end(JSON.stringify({ error: e.message }))
//       }
//     })
//     return
//   }
//   if (req.method === 'POST' && url.pathname === '/quit') {
//     res.writeHead(200, { 'Content-Type': 'application/json' })
//     res.end(JSON.stringify({ ok: true }))
//     setTimeout(() => app.quit(), 500)
//     return
//   }
//   if (req.method === 'POST' && url.pathname === '/stop') {
//     stopRelay()
//     res.writeHead(200, { 'Content-Type': 'application/json' })
//     res.end(JSON.stringify({ success: true }))
//     return
//   }
//   if (req.method === 'POST' && url.pathname === '/proxy-session') {
//     let body = ''
//     req.on('data', d => body += d)
//     req.on('end', () => {
//       try {
//         const data = JSON.parse(body)
//         proxySession = data
//         log('proxy-session SET sessionId:', data.sessionId?.slice(0,8), 'relay:', data.relayEndpoint)
//         logState('proxy-session-set')
//         res.writeHead(200, { 'Content-Type': 'application/json' })
//         res.end(JSON.stringify({ success: true }))
//       } catch (e) { res.writeHead(400); res.end() }
//     })
//     return
//   }
//   if (req.method === 'DELETE' && url.pathname === '/proxy-session') {
//     log('proxy-session CLEARED')
//     proxySession = null
//     res.writeHead(200, { 'Content-Type': 'application/json' })
//     res.end(JSON.stringify({ success: true }))
//     return
//   }
//   res.writeHead(404); res.end()
// })

// // ── Tray ──────────────────────────────────────────────────────────────────────

// function createTrayIcon() {
//   return nativeImage.createFromDataURL(
//     'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAALEwAACxMBAJqcGAAAABZ0RVh0Q3JlYXRpb24gVGltZQAxMC8yOS8xMiCqmi3JAAAAB3RJTUUH3QodEQkWMFCEAAAAGXRFWHRTb2Z0d2FyZQBBZG9iZSBJbWFnZVJlYWR5ccllPAAAAMFJREFUeNpi/P//PwMlgImBQjDwBrCgC4SGhjIwMzMzIGMwMzMzoGNkZGQgxoAFY2JiYmBiYmJAYWBgYGBiYmJAZmBgYGBiYmJAZWBgYGBiYmJAYmBgYGBiYmJAYGBgYGBiYmJAX2BgYGBiYmJAXmBgYGBiYmJAXGBgYGBiYmJAWmBgYGBiYmJAWGBgYGBiYmJAVmBgYGBiYmJAVGBgYGBiYmJAUmBgYGBiYmJAUGBgYGBiYmJATmBgYGBiYmIAAQYAoZAD/kexdGUAAAAASUVORK5CYII='
//   )
// }

// function formatBytes(bytes) {
//   if (bytes < 1024) return `${bytes}B`
//   if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
//   return `${(bytes / 1024 / 1024).toFixed(1)}MB`
// }

// function updateTray() {
//   if (!tray) return
//   const menu = Menu.buildFromTemplate([
//     { label: 'PeerMesh', enabled: false },
//     { type: 'separator' },
//     { label: running ? `● Sharing — ${config.country}` : (peerSharing ? '● Sharing (via CLI)' : '○ Not sharing'), enabled: false },
//     { label: running ? `${stats.requestsHandled} requests · ${formatBytes(stats.bytesServed)} served` : (peerSharing ? 'CLI is the active provider' : 'Click to start sharing'), enabled: false },
//     { type: 'separator' },
//     {
//       label: running ? 'Stop Sharing' : (peerSharing ? 'Stop Sharing (CLI)' : 'Start Sharing'),
//       click: async () => {
//         if (_sharingToggleBusy) return
//         _sharingToggleBusy = true
//         const wasRunning = running
//         const wasPeerSharing = peerSharing
//         if (wasRunning || wasPeerSharing) {
//           peerSharing = false
//           if (_cliWatchTimer) { clearInterval(_cliWatchTimer); _cliWatchTimer = null }
//           stopRelay()
//           if (peerPort && wasPeerSharing) {
//             await fetch(`http://127.0.0.1:${peerPort}/native/share/stop`, { method: 'POST', signal: AbortSignal.timeout(2000) }).catch(() => {})
//           }
//           peerPort = null
//           updateTray()
//         } else if (config.token && config.userId) {
//           config.shareEnabled = true
//           saveConfig()
//           connectRelay()
//         } else { shell.openExternal(`${API_BASE}/dashboard`); showWindow() }
//         _sharingToggleBusy = false
//       },
//     },
//     { type: 'separator' },
//     { label: 'Settings', click: showWindow },
//     { label: 'Open Dashboard', click: () => shell.openExternal(`${API_BASE}/dashboard`) },
//     { label: 'Open Debug Log', click: () => shell.openPath(LOG_FILE) },
//     { type: 'separator' },
//     { label: 'Quit', click: () => { stopRelay(); if (settingsWindow) { settingsWindow.removeAllListeners('close'); settingsWindow.destroy() } app.quit() } },
//   ])
//   tray.setContextMenu(menu)
//   tray.setToolTip(running ? `PeerMesh — Sharing (${config.country})` : 'PeerMesh — Inactive')
// }

// // ── Settings window ───────────────────────────────────────────────────────────

// function showWindow() {
//   if (settingsWindow) {
//     if (settingsWindow.isMinimized()) settingsWindow.restore()
//     settingsWindow.show()
//     settingsWindow.focus()
//     return
//   }
//   settingsWindow = new BrowserWindow({
//     width: 380, height: 520, resizable: false,
//     title: 'PeerMesh', backgroundColor: '#0a0a0f',
//     webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
//   })
//   settingsWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))
//   settingsWindow.setMenuBarVisibility(false)
//   // hide instead of destroy so second-instance can show it again
//   settingsWindow.on('close', (e) => {
//     e.preventDefault()
//     settingsWindow.hide()
//   })
// }

// function showNotification(title, body) {
//   if (Notification.isSupported()) new Notification({ title, body, silent: true }).show()
// }

// // ── IPC ───────────────────────────────────────────────────────────────────────

// ipcMain.handle('get-ext-id', () => config.extId)

// ipcMain.handle('check-website-auth', async () => {
//   // Legacy ext_id flow — kept for backward compat but device flow is preferred
//   try {
//     const res = await fetch(`${API_BASE}/api/extension-auth?ext_id=${config.extId}`)
//     const data = await res.json()
//     if (res.status === 403) return { error: data.error || 'Account not verified' }
//     if (res.status === 401) return { error: 'Session expired — please sign in again' }
//     if (res.status === 404) return { error: 'User not found' }
//     if (!data.user) return { pending: true }
//     if (!data.user.token || !data.user.id) return { error: 'Invalid auth response' }
//     return { user: data.user }
//   } catch { return { error: 'Could not reach server' } }
// })

// // Device flow — request a code, open browser, poll for approval
// ipcMain.handle('request-device-code', async () => {
//   log('request-device-code called')
//   try {
//     const res = await fetch(`${API_BASE}/api/extension-auth`, {
//       method: 'POST',
//       headers: { 'Content-Type': 'application/json' },
//       body: JSON.stringify({ device: true }),
//     })
//     const data = await res.json()
//     log('request-device-code response — status:', res.status, 'data:', data)
//     if (!res.ok) return { error: 'Could not reach server' }
//     return data
//   } catch (e) {
//     log('request-device-code error:', e.message)
//     return { error: 'Could not reach server' }
//   }
// })

// ipcMain.handle('poll-device-code', async (_, { device_code }) => {
//   try {
//     const res = await fetch(`${API_BASE}/api/extension-auth?device_code=${encodeURIComponent(device_code)}`)
//     const data = await res.json()
//     if (data.status !== 'pending') log('poll-device-code:', data.status, data.user ? 'user:' + data.user.id : '')
//     return data
//   } catch (e) {
//     log('poll-device-code error:', e.message)
//     return { status: 'pending' }
//   }
// })

// ipcMain.handle('open-auth', async (_, url) => {
//   const safeUrl = url && !url.startsWith('http://localhost') ? url : `${API_BASE}/extension?activate=1`

//   // Try to find a focused/last-used browser window via BrowserWindow
//   // Show a dialog: open in browser OR copy link (like VS Code device flow)
//   const { response } = await require('electron').dialog.showMessageBox(settingsWindow || BrowserWindow.getFocusedWindow(), {
//     type: 'question',
//     title: 'Sign in to PeerMesh',
//     message: 'Open sign-in page',
//     detail: `Open this URL in your browser to sign in:\n\n${safeUrl}`,
//     buttons: ['Open Browser', 'Copy Link', 'Cancel'],
//     defaultId: 0,
//     cancelId: 2,
//   })

//   if (response === 0) {
//     shell.openExternal(safeUrl)
//   } else if (response === 1) {
//     require('electron').clipboard.writeText(safeUrl)
//     // Show brief confirmation
//     if (settingsWindow) {
//       settingsWindow.webContents.executeJavaScript(`
//         const el = document.createElement('div')
//         el.textContent = '\u2713 Link copied — paste in your browser'
//         el.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:#1e1e2a;border:1px solid #00ff88;color:#e8e8f0;padding:10px 18px;border-radius:8px;font-family:\'Courier New\',monospace;font-size:11px;z-index:9999;pointer-events:none'
//         document.body.appendChild(el)
//         setTimeout(() => el.remove(), 2500)
//       `).catch(() => {})
//     }
//   }
// })

// ipcMain.handle('get-state', () => ({
//   ...getPublicState(),
//   config: { ...getPublicState().config, hasAcceptedProviderTerms: config.hasAcceptedProviderTerms ?? false },
// }))

// ipcMain.handle('sign-in', async (_, { token, userId, country, trust }) => {
//   log('sign-in attempt — userId:', userId, 'country:', country)
//   try {
//     const res = await fetch(`${API_BASE}/api/extension-auth?verify=1&userId=${encodeURIComponent(userId)}`, {
//       headers: { 'Authorization': `Bearer ${token}` },
//       signal: AbortSignal.timeout(5000),
//     })
//     log('sign-in verify — status:', res.status)
//     if (!res.ok) {
//       const body = await res.text().catch(() => '')
//       log('sign-in verify failed — body:', body)
//       return { success: false, error: 'Token verification failed' }
//     }
//   } catch (e) {
//     log('sign-in verify error (offline?):', e.message)
//   }
//   config = { ...config, token, userId, country, trust }
//   // Fetch hasAcceptedProviderTerms from DB once on sign-in
//   try {
//     const res = await fetch(`${API_BASE}/api/user/sharing`, {
//       headers: { 'Authorization': `Bearer ${token}` },
//       signal: AbortSignal.timeout(4000),
//     })
//     if (res.ok) {
//       const data = await res.json()
//       config.hasAcceptedProviderTerms = data.has_accepted_provider_terms ?? false
//     }
//   } catch {}
//   saveConfig()
//   updateTray()
//   showWindow()
//   log('sign-in success — userId:', userId)
//   return { success: true }
// })

// ipcMain.handle('toggle-sharing', async () => {
//   if (_sharingToggleBusy) return { running, shareEnabled: !!config.shareEnabled }
//   _sharingToggleBusy = true
//   const wasRunning = running
//   const wasPeerSharing = peerSharing
//   if (wasRunning || wasPeerSharing) {
//     peerSharing = false
//     if (_cliWatchTimer) { clearInterval(_cliWatchTimer); _cliWatchTimer = null }
//     stopRelay()
//     if (peerPort && wasPeerSharing) {
//       try { await fetch(`http://127.0.0.1:${peerPort}/native/share/stop`, { method: 'POST', signal: AbortSignal.timeout(2000) }) } catch {}
//     }
//     peerPort = null
//     updateTray()
//   } else if (config.token) {
//     config.shareEnabled = true
//     saveConfig()
//     connectRelay()
//   }
//   _sharingToggleBusy = false
//   return { running, shareEnabled: !!config.shareEnabled }
// })

// ipcMain.handle('sign-out', () => {
//   stopRelay()
//   config = { token: '', userId: '', country: 'RW', trust: 50, extId: config.extId, shareEnabled: false }
//   saveConfig()
//   persistSharingState(false)
//   updateTray()
//   return { success: true }
// })

// ipcMain.handle('open-dashboard', () => {
//   shell.openExternal(`${API_BASE}/dashboard`)
// })

// ipcMain.handle('accept-provider-terms', async (_, { checkOnly } = {}) => {
//   if (!config.token) return { success: false }
//   // If just checking (to sync from DB), return current state without writing
//   if (checkOnly) {
//     try {
//       const res = await fetch(`${API_BASE}/api/user/sharing`, {
//         headers: { 'Authorization': `Bearer ${config.token}` },
//         signal: AbortSignal.timeout(3000),
//       })
//       if (res.ok) {
//         const data = await res.json()
//         if (data.has_accepted_provider_terms === true) {
//           config.hasAcceptedProviderTerms = true
//           saveConfig()
//         }
//         return { success: true, accepted: data.has_accepted_provider_terms === true }
//       }
//     } catch {}
//     return { success: true, accepted: config.hasAcceptedProviderTerms ?? false }
//   }
//   try {
//     const res = await fetch(`${API_BASE}/api/user/sharing`, {
//       method: 'POST',
//       headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` },
//       body: JSON.stringify({ acceptProviderTerms: true }),
//     })
//     if (res.ok) {
//       config.hasAcceptedProviderTerms = true
//       saveConfig()
//     }
//   } catch {}
//   return { success: true }
// })

// // ── App lifecycle ─────────────────────────────────────────────────────────────

// if (IS_NATIVE_HOST_MODE) {
//   loadConfig()
//   registerNativeMessagingHost()
//   runNativeHostMode()
// } else app.whenReady().then(() => {
//   // Enforce single instance
//   if (!app.requestSingleInstanceLock()) {
//     log('Another instance is already running — quitting')
//     app.quit()
//     return
//   }
//   app.on('second-instance', () => {
//     showWindow()
//   })

//   log('=== APP START === version:', DESKTOP_VERSION, 'background:', IS_BACKGROUND_LAUNCH, 'argv:', process.argv.slice(1).join(' '))
//   app.on('window-all-closed', (e) => e.preventDefault())
//   app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true })

//   loadConfig()

//   tray = new Tray(createTrayIcon())
//   tray.setToolTip('PeerMesh')
//   tray.on('click', showWindow)
//   updateTray()

//   // Start control server — check port first to avoid EADDRINUSE crash
//   const net = require('net')
//   const tester = net.createServer()
//   tester.once('error', () => {
//     // Port in use (CLI owns it) — desktop runs as peer on PEER_PORT
//     log(`PORT RACE: port ${CONTROL_PORT} in use — CLI owns it, desktop binding to PEER_PORT ${PEER_PORT}`)
//     // Try to register with CLI so we can cross-notify
//     fetch(`http://127.0.0.1:${CONTROL_PORT}/native/peer/register`, {
//       method: 'POST',
//       headers: { 'Content-Type': 'application/json' },
//       body: JSON.stringify({ port: PEER_PORT, where: 'desktop' }),
//       signal: AbortSignal.timeout(1500),
//     }).then(() => { peerPort = CONTROL_PORT }).catch(() => {})

//     // Bind a minimal peer server on PEER_PORT so the tray/renderer can
//     // reflect CLI sharing state and forward stop commands to CLI.
//     const peerServer = http.createServer((req, res) => {
//       const origin = req.headers.origin || ''
//       res.setHeader('Access-Control-Allow-Origin',
//         origin.includes('peermesh') || origin.includes('localhost') || origin.startsWith('chrome-extension://') ? origin : '')
//       res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
//       res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
//       if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
//       const url = new URL(req.url, `http://localhost:${PEER_PORT}`)

//       // Reflect CLI state — proxy the GET through to CLI on 7654
//       if (req.method === 'GET' && url.pathname === '/native/state') {
//         fetch(`http://127.0.0.1:${CONTROL_PORT}/native/state`, { signal: AbortSignal.timeout(1500) })
//           .then(r => r.json())
//           .then(d => {
//             peerSharing = !!d.running
//             res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ...d, where: 'desktop', peerWhere: 'cli' }))
//           })
//           .catch(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ available: true, running: false, shareEnabled: false, where: 'desktop' })) })
//         return
//       }

//       // Stop sharing — forward to CLI on 7654, clear peerSharing
//       if (req.method === 'POST' && url.pathname === '/native/share/stop') {
//         fetch(`http://127.0.0.1:${CONTROL_PORT}/native/share/stop`, { method: 'POST', signal: AbortSignal.timeout(2000) }).catch(() => {})
//         peerSharing = false
//         config.shareEnabled = false
//         saveConfig()
//         stopRelay()
//         res.writeHead(200, { 'Content-Type': 'application/json' })
//         res.end(JSON.stringify({ available: true, running: false, shareEnabled: false }))
//         return
//       }

//       // Peer registration
//       if (req.method === 'POST' && url.pathname === '/native/peer/register') {
//         let body = ''
//         req.on('data', d => body += d)
//         req.on('end', () => {
//           try { peerPort = JSON.parse(body).port } catch {}
//           res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }))
//         })
//         return
//       }

//       res.writeHead(404); res.end()
//     })
//     peerServer.listen(PEER_PORT, '127.0.0.1', async () => {
//       log('PORT RACE RESULT: desktop peer server bound on port ' + PEER_PORT + ' (CLI owns ' + CONTROL_PORT + ')')
//       // Read CLI's actual sharing state now so tray label is correct immediately
//       try {
//         const r = await fetch(`http://127.0.0.1:${CONTROL_PORT}/native/state`, { signal: AbortSignal.timeout(1500) })
//         if (r.ok) { const d = await r.json(); peerSharing = !!d.running }
//       } catch {}
//       updateTray()
//       // Watch for CLI stopping — reclaim primary port when CLI exits
//       function reclaimPrimary() {
//         log('CLI gone — reclaiming port ' + CONTROL_PORT)
//         logState('pre-reclaim')
//         peerSharing = false
//         peerPort = null
//         config.shareEnabled = false
//         saveConfig()
//         updateTray()
//         peerServer.close(() => {
//           controlServer.listen(CONTROL_PORT, '127.0.0.1', () => {
//             localProxyServer.listen(LOCAL_PROXY_PORT, '127.0.0.1')
//             log('PORT RECLAIMED: desktop now owns port ' + CONTROL_PORT)
//             logState('post-reclaim')
//           })
//         })
//       }
//       const cliWatcher = setInterval(async () => {
//         try {
//           const r = await fetch(`http://127.0.0.1:${CONTROL_PORT}/native/state`, { signal: AbortSignal.timeout(1500) })
//           if (r.ok) {
//             const d = await r.json()
//             // Only update peerSharing if we're not in the middle of stopping it
//             if (!_sharingToggleBusy) {
//               peerSharing = !!d.running
//               updateTray()
//             }
//           } else {
//             clearInterval(cliWatcher)
//             reclaimPrimary()
//           }
//         } catch {
//           clearInterval(cliWatcher)
//           reclaimPrimary()
//         }
//       }, 3000)
//     })
//     peerServer.on('error', e => log('Desktop peer server error: ' + e.message))
//   })
//   tester.once('listening', () => {
//     tester.close(() => {
//       controlServer.listen(CONTROL_PORT, '127.0.0.1', async () => {
//         log('PORT RACE RESULT: desktop owns port ' + CONTROL_PORT + ' (primary)')
//         localProxyServer.listen(LOCAL_PROXY_PORT, '127.0.0.1')
//         // Check if CLI is already sharing on CONTROL_PORT (7654) — desktop just
//         // took that port so this path only runs when desktop wins the port race.
//         // Also check PEER_PORT (7656) in case CLI bound there first.
//         let cliAlreadySharing = false
//         try {
//           // CLI may have been on 7656 before desktop started — check there
//           const r = await fetch(`http://127.0.0.1:${PEER_PORT}/native/state`, { signal: AbortSignal.timeout(1500) })
//           if (r.ok) {
//             const cliState = await r.json()
//             if (cliState.where === 'cli') {
//               await fetch(`http://127.0.0.1:${PEER_PORT}/native/peer/register`, {
//                 method: 'POST',
//                 headers: { 'Content-Type': 'application/json' },
//                 body: JSON.stringify({ port: CONTROL_PORT, where: 'desktop' }),
//                 signal: AbortSignal.timeout(1500),
//               })
//               peerPort = PEER_PORT
//               cliAlreadySharing = !!cliState.running
//               peerSharing = cliAlreadySharing
//               log('CLI detected on port ' + PEER_PORT + (cliAlreadySharing ? ' (sharing active)' : ' (not sharing)'))
//               if (cliAlreadySharing) {
//                 log('CLI is sharing — desktop standing by, not connecting relay')
//               }
//               // Watch for CLI exiting so peerSharing state stays accurate
//               _cliWatchTimer = setInterval(async () => {
//                 try {
//                   const r = await fetch(`http://127.0.0.1:${PEER_PORT}/native/state`, { signal: AbortSignal.timeout(1500) })
//                   if (r.ok) {
//                     const d = await r.json()
//                     if (!_sharingToggleBusy) { peerSharing = !!d.running; updateTray() }
//                   } else {
//                     clearInterval(_cliWatchTimer); _cliWatchTimer = null
//                     log('CLI on PEER_PORT gone — clearing peer state')
//                     peerSharing = false; peerPort = null; updateTray()
//                   }
//                 } catch {
//                   clearInterval(_cliWatchTimer); _cliWatchTimer = null
//                   log('CLI on PEER_PORT gone — clearing peer state')
//                   peerSharing = false; peerPort = null; updateTray()
//                 }
//               }, 3000)
//             }
//           }
//         } catch {}
//         log('startup check — cliAlreadySharing:', cliAlreadySharing, 'token:', !!config.token, 'userId:', !!config.userId, 'shareEnabled:', config.shareEnabled)
//         logState('startup')
//         if (!cliAlreadySharing && config.token && config.userId && config.shareEnabled) {
//           log('auto-connecting relay on startup')
//           connectRelay()
//         }
//       })
//     })
//   })
//   tester.listen(CONTROL_PORT, '127.0.0.1')

//   if (config.token && config.userId && config.shareEnabled) {
//     // connectRelay is called inside the controlServer.listen callback
//     // after checking if CLI is already sharing — don't call it here too
//     if (!IS_BACKGROUND_LAUNCH) showWindow()
//   } else {
//     showWindow()
//   }
// })

// app.on('before-quit', () => {
//   log('=== APP QUIT ===')
//   logState('before-quit')
//   if (_cliWatchTimer) { clearInterval(_cliWatchTimer); _cliWatchTimer = null }
//   stopRelay()
//   closeAllTunnels(false)
//   try { controlServer.close() } catch {}
//   try { localProxyServer.close() } catch {}
//   // Synchronously mark sharing as stopped in DB before process exits
//   if (config.token && config.userId && config.extId) {
//     fetch(`${API_BASE}/api/user/sharing`, {
//       method: 'DELETE',
//       headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` },
//       body: JSON.stringify({ device_id: config.extId }),
//     }).catch(() => {})
//     fetch(`${API_BASE}/api/user/sharing`, {
//       method: 'POST',
//       headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` },
//       body: JSON.stringify({ isSharing: false }),
//     }).catch(() => {})
//   }
//   // Kill any lingering node/agent child processes
//   if (process.platform === 'win32') {
//     try { spawnSync('taskkill', ['/F', '/IM', 'node.exe', '/T'], { stdio: 'ignore' }) } catch {}
//   } else {
//     try { spawnSync('pkill', ['-f', 'peermesh'], { stdio: 'ignore' }) } catch {}
//   }
// })

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

// Structured logger — always writes to file, always to console
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
  _write('DEBUG', 'STATE', `[${label}]`, {
    running,
    shareEnabled: config.shareEnabled,
    peerSharing,
    peerPort,
    wsState: ws ? ws.readyState : 'null',
    tunnels: activeTunnels.size,
  })
}

const logRequest  = (method, url, body) => _write('INFO',  'HTTP-OUT', `→ ${method} ${url}`, body ? { body } : undefined)
const logResponse = (method, url, status, body) => _write('INFO',  'HTTP-IN',  `← ${status} ${method} ${url}`, body ? { body } : undefined)
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
  log.info('PEER', `notifyPeer → ${p}`, { port: peerPort })
  const init = { method: 'POST', signal: AbortSignal.timeout(1500) }
  if (body) { init.headers = { 'Content-Type': 'application/json' }; init.body = JSON.stringify(body) }
  fetch(`http://127.0.0.1:${peerPort}${p}`, init)
    .then(() => log.debug('PEER', `notifyPeer OK ${p}`))
    .catch(e => log.warn('PEER', `notifyPeer failed ${p}`, { err: e.message }))
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
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data))
}

function closeTunnel(tunnelId, notifyRelay = false) {
  const tunnel = activeTunnels.get(tunnelId)
  if (!tunnel || tunnel.closed) return
  tunnel.closed = true
  activeTunnels.delete(tunnelId)
  if (notifyRelay) sendRelayMessage({ type: 'tunnel_close', tunnelId })
  if (!tunnel.socket.destroyed) tunnel.socket.destroy()
  logTunnel('CLOSED', tunnelId, { notifyRelay, remaining: activeTunnels.size })
}

function closeAllTunnels(notifyRelay = false) {
  const count = activeTunnels.size
  for (const tunnelId of [...activeTunnels.keys()]) closeTunnel(tunnelId, notifyRelay)
  if (count > 0) log.info('TUNNEL', `closeAllTunnels — closed ${count} tunnels`)
}

// ── Config ────────────────────────────────────────────────────────────────────

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
    saveConfig()
    log.info('CONFIG', 'generated new extId', { extId: config.extId })
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
  log.info('PROCESS', 'launchMainApp — spawned background process')
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

// ── Abuse filter ──────────────────────────────────────────────────────────────

const BLOCKED = [/\.onion$/i, /^smtp\./i, /^mail\./i, /torrent/i]
const PRIVATE = [/^localhost$/i, /^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./]

function isAllowed(hostname) {
  return !BLOCKED.some(p => p.test(hostname)) && !PRIVATE.some(p => p.test(hostname))
}

// ── Fetch handler ─────────────────────────────────────────────────────────────

async function handleFetch(request) {
  const { requestId, url, method = 'GET', headers = {}, body = null } = request
  log.info('PROXY', `fetch request`, { requestId: requestId?.slice(0,8), method, url })
  try {
    const parsed = new URL(url)
    if (!isAllowed(parsed.hostname)) {
      log.warn('PROXY', 'blocked URL', { hostname: parsed.hostname, requestId: requestId?.slice(0,8) })
      return { requestId, status: 403, headers: {}, body: '', error: 'URL not allowed' }
    }
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
      if (!['content-encoding', 'transfer-encoding', 'connection', 'keep-alive'].includes(k)) responseHeaders[k] = v
    })
    const bodyLen = responseBody.length
    stats.bytesServed += bodyLen
    stats.requestsHandled++
    log.info('PROXY', `fetch response`, { requestId: requestId?.slice(0,8), status: res.status, bytes: bodyLen, finalUrl: res.url !== url ? res.url : undefined })
    flushStats(bodyLen)
    return { requestId, status: res.status, headers: responseHeaders, body: responseBody, finalUrl: res.url }
  } catch (err) {
    log.error('PROXY', 'fetch error', { requestId: requestId?.slice(0,8), url, err: err.message })
    return { requestId, status: 502, headers: {}, body: '', error: err.message }
  }
}

// ── Relay ─────────────────────────────────────────────────────────────────────

let heartbeatTimer = null

function startHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
  sendHeartbeat()
  heartbeatTimer = setInterval(sendHeartbeat, 30_000)
  log.debug('HEARTBEAT', 'heartbeat timer started')
}

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
    logRequest('POST', `${API_BASE}/api/user/sharing`, { bytes: toFlush })
    try {
      const r = await fetch(`${API_BASE}/api/user/sharing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` },
        body: JSON.stringify({ bytes: toFlush }),
      })
      logResponse('POST', `${API_BASE}/api/user/sharing`, r.status)
    } catch (e) { log.warn('API', 'flushStats failed', { err: e.message }) }
  }, 5000)
}

function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
  log.debug('HEARTBEAT', 'heartbeat timer stopped')
  if (!config.token || !config.userId) return
  logRequest('DELETE', `${API_BASE}/api/user/sharing`, { device_id: config.extId })
  fetch(`${API_BASE}/api/user/sharing`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` },
    body: JSON.stringify({ device_id: config.extId }),
  })
    .then(r => logResponse('DELETE', `${API_BASE}/api/user/sharing`, r.status))
    .catch(e => log.warn('API', 'stopHeartbeat DELETE failed', { err: e.message }))
}

function sendHeartbeat() {
  if (!config.token || !config.userId || !config.extId) return
  logRequest('PUT', `${API_BASE}/api/user/sharing`, { device_id: config.extId })
  fetch(`${API_BASE}/api/user/sharing`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` },
    body: JSON.stringify({ device_id: config.extId }),
  })
    .then(r => { logResponse('PUT', `${API_BASE}/api/user/sharing`, r.status); if (!r.ok) r.json().then(b => log.warn('HEARTBEAT', 'PUT failed', { status: r.status, body: b })) })
    .catch(e => log.warn('HEARTBEAT', 'PUT error', { err: e.message }))
}

function connectRelay() {
  if (!config.token || !config.userId) { log.warn('RELAY', 'connectRelay skipped — no token/userId'); return }
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) { log.warn('RELAY', 'connectRelay skipped — already connected/connecting', { wsState: ws.readyState }); return }
  log.info('RELAY', 'connectRelay START', { userId: config.userId, country: config.country, relay: RELAY_WS })
  logState('pre-connect')
  ws = new WebSocket(RELAY_WS)

  ws.on('open', () => {
    log.info('RELAY', 'WebSocket OPEN', { relay: RELAY_WS })
    running = true
    reconnectDelay = 2000
    if (!config.shareEnabled) {
      log.warn('RELAY', 'shareEnabled=false after WS open — aborting')
      ws.close(1000)
      return
    }
    const reg = { type: 'register_provider', userId: config.userId, country: config.country, trustScore: config.trust, agentMode: true, providerKind: 'desktop', supportsHttp: true, supportsTunnel: true }
    logRelay('SEND', 'register_provider', reg)
    ws.send(JSON.stringify(reg))
    startHeartbeat()
    logState('post-register-send')
    updateTray()
  })

  ws.on('ping', () => { try { ws.pong() } catch {} })

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString())
      // Log every relay message with context (skip bulk data frames for readability)
      if (msg.type === 'tunnel_data' || msg.type === 'proxy_ws_data') {
        log.debug('RELAY', `RECV ${msg.type}`, { tunnelId: msg.tunnelId?.slice(0,8), sessionId: msg.sessionId?.slice(0,8), bytes: msg.data?.length })
      } else {
        logRelay('RECV', msg.type, { sessionId: msg.sessionId?.slice(0,8), tunnelId: msg.tunnelId?.slice(0,8), message: msg.message, hostname: msg.hostname, port: msg.port })
      }

      if (msg.type === 'registered') {
        stats.connectedAt = new Date().toISOString()
        log.info('RELAY', 'REGISTERED — sharing active', { country: config.country, connectedAt: stats.connectedAt })
        logState('registered')
        showNotification('PeerMesh Active', `Sharing your ${config.country} connection`)
        updateTray()
      } else if (msg.type === 'error') {
        log.error('RELAY', 'relay error message', { message: msg.message })
        if (msg.message?.includes('Replaced')) {
          log.warn('RELAY', 'EVICTED by newer instance — stopping cleanly')
          logState('evicted')
          ws.removeAllListeners('close')
          ws.close(1000)
          running = false
          updateTray()
        }
      } else if (msg.type === 'proxy_ws_open') {
        log.debug('RELAY', 'proxy_ws_open', { sessionId: msg.sessionId?.slice(0,8) })
      } else if (msg.type === 'proxy_ws_data') {
        const tunnel = activeTunnels.get(`ws_${msg.sessionId}`)
        if (tunnel?.socket && !tunnel.socket.destroyed) tunnel.socket.write(Buffer.from(msg.data, 'base64'))
      } else if (msg.type === 'proxy_ws_close') {
        const tunnel = activeTunnels.get(`ws_${msg.sessionId}`)
        if (tunnel) { if (!tunnel.socket.destroyed) tunnel.socket.destroy(); activeTunnels.delete(`ws_${msg.sessionId}`) }
        log.debug('RELAY', 'proxy_ws_close', { sessionId: msg.sessionId?.slice(0,8) })
      } else if (msg.type === 'session_request') {
        log.info('RELAY', 'session_request — sending agent_ready', { sessionId: msg.sessionId?.slice(0,8) })
        ws.send(JSON.stringify({ type: 'agent_ready', sessionId: msg.sessionId }))
        logRelay('SEND', 'agent_ready', { sessionId: msg.sessionId?.slice(0,8) })
      } else if (msg.type === 'proxy_request') {
        log.info('RELAY', 'proxy_request received', { sessionId: msg.sessionId?.slice(0,8), url: msg.request?.url?.slice(0,80) })
        const response = await handleFetch(msg.request)
        ws.send(JSON.stringify({ type: 'proxy_response', sessionId: msg.sessionId, response }))
        logRelay('SEND', 'proxy_response', { sessionId: msg.sessionId?.slice(0,8), status: response.status })
      } else if (msg.type === 'open_tunnel') {
        log.info('TUNNEL', 'open_tunnel request', { tunnelId: msg.tunnelId?.slice(0,8), target: `${msg.hostname}:${msg.port}`, activeTunnels: activeTunnels.size })
        const socket = net.connect(msg.port, msg.hostname)
        activeTunnels.set(msg.tunnelId, { socket, closed: false, sessionId: msg.sessionId ?? null })
        socket.on('connect', () => {
          log.info('TUNNEL', 'TCP connected', { tunnelId: msg.tunnelId?.slice(0,8), target: `${msg.hostname}:${msg.port}` })
          sendRelayMessage({ type: 'tunnel_ready', tunnelId: msg.tunnelId })
          logRelay('SEND', 'tunnel_ready', { tunnelId: msg.tunnelId?.slice(0,8) })
        })
        socket.on('data', (chunk) => {
          sendRelayMessage({ type: 'tunnel_data', tunnelId: msg.tunnelId, data: chunk.toString('base64') })
          stats.bytesServed += chunk.length
          stats.requestsHandled++
          flushStats(chunk.length)
        })
        socket.on('end', () => { log.debug('TUNNEL', 'TCP end', { tunnelId: msg.tunnelId?.slice(0,8) }); closeTunnel(msg.tunnelId, true) })
        socket.on('close', () => activeTunnels.delete(msg.tunnelId))
        socket.on('error', (e) => { log.error('TUNNEL', 'TCP error', { tunnelId: msg.tunnelId?.slice(0,8), target: msg.hostname, err: e.message }); closeTunnel(msg.tunnelId, true) })
      } else if (msg.type === 'tunnel_data') {
        const tunnel = activeTunnels.get(msg.tunnelId)
        if (tunnel?.socket && !tunnel.socket.destroyed) tunnel.socket.write(Buffer.from(msg.data, 'base64'))
      } else if (msg.type === 'tunnel_close') {
        log.info('TUNNEL', 'tunnel_close received', { tunnelId: msg.tunnelId?.slice(0,8) })
        closeTunnel(msg.tunnelId, false)
      } else if (msg.type === 'session_ended') {
        log.info('RELAY', 'session_ended — closing all tunnels', { sessionId: msg.sessionId?.slice(0,8) })
        closeAllTunnels(false)
        updateTray()
      }
    } catch (e) { log.error('RELAY', 'message handler exception', { err: e.message }) }
  })

  ws.on('close', (code, reason) => {
    log.info('RELAY', 'WebSocket CLOSED', { code, reason: reason?.toString() || '(none)', wasRunning: running })
    running = false
    stats.connectedAt = null
    closeAllTunnels(false)
    ws = null
    logState('ws-closed')
    updateTray()
    if (code !== 1000 && config.shareEnabled) {
      log.info('RELAY', `scheduling reconnect`, { delayMs: reconnectDelay })
      reconnectTimer = setTimeout(connectRelay, reconnectDelay)
      reconnectDelay = Math.min(reconnectDelay * 2, 30000)
    } else {
      log.info('RELAY', 'no reconnect', { reason: code === 1000 ? 'clean close' : 'shareEnabled=false' })
    }
  })

  ws.on('error', (e) => { log.error('RELAY', 'WebSocket error', { code: e.code, err: e.message }) })
}

function stopRelay() {
  log.info('RELAY', 'stopRelay called')
  logState('pre-stop')
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; log.debug('RELAY', 'reconnect timer cleared') }
  if (ws) { ws.removeAllListeners('close'); ws.close(1000); ws = null; log.info('RELAY', 'WebSocket closed (code 1000)') }
  running = false
  config.shareEnabled = false
  saveConfig()
  closeAllTunnels(false)
  stats = { bytesServed: 0, requestsHandled: 0, connectedAt: null }
  stopHeartbeat()
  persistSharingState(false)
  logState('post-stop')
  updateTray()
}

// ── Local HTTP proxy server ───────────────────────────────────────────────────

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
    log.warn('LOCAL-PROXY', 'HTTP rejected — no session', { url: req.url })
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
    log.warn('LOCAL-PROXY', 'CONNECT rejected — no proxySession', { target: `${hostname}:${port}` })
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
      log.info('LOCAL-PROXY', 'tunnel ready — 200 sent to Chrome', { target: `${hostname}:${port}` })
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

// ── Control server ────────────────────────────────────────────────────────────

const controlServer = http.createServer((req, res) => {
  const origin = req.headers.origin || ''
  res.setHeader('Access-Control-Allow-Origin', origin.includes('peermesh') || origin.includes('localhost') || origin.startsWith('chrome-extension://') ? origin : '')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  const url = new URL(req.url, `http://localhost:${CONTROL_PORT}`)
  logControl(req.method, url.pathname, { origin: origin.slice(0, 40) || undefined })

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ running, shareEnabled: !!config.shareEnabled, country: config.country, userId: config.userId?.slice(0, 8), proxyPort: RELAY_PROXY_PORT, stats, version: DESKTOP_VERSION }))
    return
  }
  if (req.method === 'GET' && url.pathname === '/native/state') {
    const state = { available: true, running, shareEnabled: !!config.shareEnabled, configured: !!(config.token && config.userId), country: config.country, userId: config.userId, version: DESKTOP_VERSION, where: 'desktop', stats }
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
        log.info('CONTROL', '/native/auth — verifying token', { userId: data.userId })
        if (data.token) {
          try {
            const vRes = await fetch(`${API_BASE}/api/extension-auth?verify=1&userId=${encodeURIComponent(data.userId || '')}`, { headers: { 'Authorization': `Bearer ${data.token}` }, signal: AbortSignal.timeout(5000) })
            log.info('CONTROL', '/native/auth verify result', { status: vRes.status, userId: data.userId })
            if (!vRes.ok) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Token verification failed' })); return }
          } catch (e) { log.warn('CONTROL', '/native/auth verify error (offline?)', { err: e.message }) }
        }
        config = { ...config, token: data.token ?? config.token, userId: data.userId ?? config.userId, country: data.country ?? config.country, trust: data.trust ?? config.trust }
        saveConfig(); updateTray()
        log.info('CONTROL', '/native/auth — config updated', { userId: config.userId, country: config.country })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ available: true, running, shareEnabled: !!config.shareEnabled, configured: !!(config.token && config.userId), country: config.country, userId: config.userId, version: DESKTOP_VERSION }))
      } catch (e) { log.error('CONTROL', '/native/auth error', { err: e.message }); res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })) }
    })
    return
  }
  if (req.method === 'POST' && url.pathname === '/native/share/start') {
    let body = ''
    req.on('data', d => body += d)
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}')
        log.info('CONTROL', '/native/share/start', { userId: data.userId || config.userId, country: data.country || config.country })
        config = { ...config, token: data.token ?? config.token, userId: data.userId ?? config.userId, country: data.country ?? config.country, trust: data.trust ?? config.trust, shareEnabled: true }
        saveConfig()
        logState('share/start')
        if (!running) connectRelay()
        updateTray()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ available: true, running: true, shareEnabled: true, configured: !!(config.token && config.userId), country: config.country, userId: config.userId, version: DESKTOP_VERSION }))
      } catch (e) { log.error('CONTROL', '/native/share/start error', { err: e.message }); res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })) }
    })
    return
  }
  if (req.method === 'POST' && url.pathname === '/native/share/stop') {
    log.info('CONTROL', '/native/share/stop called')
    stopRelay()
    persistSharingState(false)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ available: true, running: false, shareEnabled: false, configured: !!(config.token && config.userId), country: config.country, userId: config.userId, version: DESKTOP_VERSION }))
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
    log.info('CONTROL', '/native/show — opening window')
    showWindow()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ available: true, running, shareEnabled: !!config.shareEnabled, configured: !!(config.token && config.userId), country: config.country, userId: config.userId, version: DESKTOP_VERSION }))
    return
  }
  if (req.method === 'POST' && url.pathname === '/start') {
    let body = ''
    req.on('data', d => body += d)
    req.on('end', () => {
      try {
        const data = JSON.parse(body)
        log.info('CONTROL', '/start called', { userId: data.userId || config.userId })
        config = { ...config, ...data, shareEnabled: true }
        saveConfig(); stopRelay(); config.shareEnabled = true; saveConfig(); connectRelay()
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true }))
      } catch (e) { log.error('CONTROL', '/start error', { err: e.message }); res.writeHead(400); res.end(JSON.stringify({ error: e.message })) }
    })
    return
  }
  if (req.method === 'POST' && url.pathname === '/quit') {
    log.info('CONTROL', '/quit called — scheduling app.quit')
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
  log.debug('TRAY', 'updateTray', { running, peerSharing, shareEnabled: config.shareEnabled })
  const menu = Menu.buildFromTemplate([
    { label: 'PeerMesh', enabled: false },
    { type: 'separator' },
    { label: running ? `● Sharing — ${config.country}` : (peerSharing ? '● Sharing (via CLI)' : '○ Not sharing'), enabled: false },
    { label: running ? `${stats.requestsHandled} requests · ${formatBytes(stats.bytesServed)} served` : (peerSharing ? 'CLI is the active provider' : 'Click to start sharing'), enabled: false },
    { type: 'separator' },
    {
      label: running ? 'Stop Sharing' : (peerSharing ? 'Stop Sharing (CLI)' : 'Start Sharing'),
      click: async () => {
        if (_sharingToggleBusy) { log.warn('TRAY', 'toggle click ignored — busy'); return }
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
        log.info('TRAY', 'toggle click', { wasRunning, wasPeerSharing, peerPort })
        if (wasRunning || wasPeerSharing) {
          peerSharing = false
          if (_cliWatchTimer) { clearInterval(_cliWatchTimer); _cliWatchTimer = null; log.info('TRAY', '_cliWatchTimer cleared on stop') }
          stopRelay()
          if (peerPort && wasPeerSharing) {
            log.info('TRAY', 'sending share/stop to CLI peer', { peerPort })
            await fetch(`http://127.0.0.1:${peerPort}/native/share/stop`, { method: 'POST', signal: AbortSignal.timeout(2000) })
              .then(r => log.info('TRAY', 'CLI share/stop response', { status: r.status }))
              .catch(e => log.warn('TRAY', 'CLI share/stop fetch failed', { err: e.message }))
          }
          peerPort = null
          updateTray()
        } else if (config.token && config.userId) {
          log.info('TRAY', 'toggle ON — starting sharing')
          config.shareEnabled = true; saveConfig(); connectRelay()
        } else { log.warn('TRAY', 'toggle ON — no credentials, opening dashboard'); shell.openExternal(`${API_BASE}/dashboard`); showWindow() }
        _sharingToggleBusy = false
        logState('post-toggle')
      },
    },
    { type: 'separator' },
    { label: 'Settings', click: showWindow },
    { label: 'Open Dashboard', click: () => shell.openExternal(`${API_BASE}/dashboard`) },
    { label: 'Open Debug Log', click: () => shell.openPath(LOG_FILE) },
    { type: 'separator' },
    { label: 'Quit', click: () => { log.info('TRAY', 'Quit clicked'); stopRelay(); if (settingsWindow) { settingsWindow.removeAllListeners('close'); settingsWindow.destroy() } app.quit() } },
  ])
  tray.setContextMenu(menu)
  tray.setToolTip(running ? `PeerMesh — Sharing (${config.country})` : 'PeerMesh — Inactive')
}

// ── Settings window ───────────────────────────────────────────────────────────

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

// ── IPC ───────────────────────────────────────────────────────────────────────

ipcMain.handle('get-ext-id', () => { logIpc('get-ext-id'); return config.extId })

ipcMain.handle('check-website-auth', async () => {
  logIpc('check-website-auth', { extId: config.extId })
  try {
    logRequest('GET', `${API_BASE}/api/extension-auth?ext_id=***`)
    const res = await fetch(`${API_BASE}/api/extension-auth?ext_id=${config.extId}`)
    const data = await res.json()
    logResponse('GET', `${API_BASE}/api/extension-auth`, res.status)
    if (res.status === 403) return { error: data.error || 'Account not verified' }
    if (res.status === 401) return { error: 'Session expired — please sign in again' }
    if (res.status === 404) return { error: 'User not found' }
    if (!data.user) return { pending: true }
    if (!data.user.token || !data.user.id) return { error: 'Invalid auth response' }
    log.info('IPC', 'check-website-auth — user found', { userId: data.user.id })
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
  if (response === 0) { shell.openExternal(safeUrl); log.info('IPC', 'open-auth — opened browser') }
  else if (response === 1) {
    require('electron').clipboard.writeText(safeUrl)
    log.info('IPC', 'open-auth — copied link to clipboard')
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

ipcMain.handle('get-state', () => {
  const state = { ...getPublicState(), config: { ...getPublicState().config, hasAcceptedProviderTerms: config.hasAcceptedProviderTerms ?? false } }
  logIpc('get-state', { running: state.running, shareEnabled: state.shareEnabled })
  return state
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
    if (res.ok) { const data = await res.json(); config.hasAcceptedProviderTerms = data.has_accepted_provider_terms ?? false }
  } catch {}
  saveConfig(); updateTray(); showWindow()
  log.info('IPC', 'sign-in success', { userId, country })
  return { success: true }
})

ipcMain.handle('toggle-sharing', async () => {
  if (_sharingToggleBusy) { log.warn('IPC', 'toggle-sharing ignored — busy'); return { running, shareEnabled: !!config.shareEnabled } }
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
    log.info('IPC', 'toggle-sharing ON — starting sharing')
    config.shareEnabled = true; saveConfig(); connectRelay()
  }
  _sharingToggleBusy = false
  logState('post-toggle-sharing')
  return { running, shareEnabled: !!config.shareEnabled }
})

ipcMain.handle('sign-out', () => {
  logIpc('sign-out', { userId: config.userId })
  stopRelay()
  config = { token: '', userId: '', country: 'RW', trust: 50, extId: config.extId, shareEnabled: false }
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

// ── App lifecycle ─────────────────────────────────────────────────────────────

if (IS_NATIVE_HOST_MODE) {
  loadConfig()
  registerNativeMessagingHost()
  runNativeHostMode()
} else app.whenReady().then(() => {
  if (!app.requestSingleInstanceLock()) {
    log.warn('PROCESS', 'Another instance is already running — quitting')
    app.quit(); return
  }
  app.on('second-instance', () => { log.info('PROCESS', 'second-instance event — showing window'); showWindow() })

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
    log.warn('PORT', `port ${CONTROL_PORT} in use — CLI owns it, desktop binding to PEER_PORT ${PEER_PORT}`)
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
        log.info('PEER-SERVER', '/native/share/stop — desktop peer received stop signal (not forwarding back to CLI)')
        // Do NOT forward to CLI — they sent this to us; forwarding would cause a loop
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
        log.info('PORT', 'CLI gone — reclaiming port ' + CONTROL_PORT)
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
            log.warn('PORT', 'cliWatcher non-ok response — reclaiming', { status: r.status })
            clearInterval(cliWatcher); reclaimPrimary()
          }
        } catch (e) {
          log.info('PORT', 'cliWatcher — CLI gone (unreachable)', { err: e.message })
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
              if (cliAlreadySharing) log.info('PORT', 'CLI is sharing — desktop standing by')

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
                    log.warn('PORT', '_cliWatchTimer non-ok — clearing peer state', { status: r.status })
                    clearInterval(_cliWatchTimer); _cliWatchTimer = null; peerSharing = false; peerPort = null; updateTray()
                  }
                } catch (e) {
                  log.info('PORT', '_cliWatchTimer — CLI gone (unreachable)', { err: e.message })
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