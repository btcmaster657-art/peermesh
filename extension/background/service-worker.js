// background/service-worker.js - PeerMesh Extension Service Worker

const APP_URL = 'https://peermesh-beta.vercel.app'
const RELAY_WS = 'wss://peermesh-relay.fly.dev'
const NATIVE_HOST = 'com.peermesh.desktop'
const CONTROL_PORT = 7654

let relayWs = null
let currentSession = null   // { ws, sessionId, country, relayEndpoint }
let agentSessionId = null
let supabaseToken = null
let sharingUserId = null
let sharingCountry = null
let heartbeatInterval = null

// Pending proxy requests: requestId → { resolve, reject, timer }
const pendingRequests = new Map()

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  ;(async () => {
    try {
      switch (msg.type) {
        case 'CONNECT':
          await connectToRelay(msg)
          sendResponse({ success: true })
          break
        case 'DISCONNECT':
          await disconnect()
          sendResponse({ success: true })
          break
        case 'START_SHARING': {
          if (msg.supabaseToken) {
            supabaseToken = msg.supabaseToken
            sharingUserId = msg.userId
            sharingCountry = msg.country
            await chrome.storage.local.set({ supabaseToken })
          }
          const result = await startDesktopSharing(msg)
          if (result.success) startExtensionHeartbeat()
          sendResponse(result)
          break
        }
        case 'STOP_SHARING': {
          stopExtensionHeartbeat()
          const result = await stopDesktopSharing()
          sendResponse(result)
          break
        }
        case 'GET_STATUS': {
          const helper = await getDesktopHelperStatus()
          const isSharing = helper.available && (helper.running || helper.shareEnabled)
          await chrome.storage.local.set({ isSharing, helper })
          sendResponse({ connected: !!currentSession, session: currentSession, isSharing, helper })
          break
        }
        // Called by content script / popup to proxy a fetch through the peer
        case 'PROXY_FETCH': {
          const result = await proxyFetch(msg.url, msg.options ?? {})
          sendResponse(result)
          break
        }
        default:
          sendResponse({ success: false, error: 'Unknown message type' })
      }
    } catch (error) {
      sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) })
    }
  })()
  return true
})

// ── Proxy fetch through relay WS ──────────────────────────────────────────────
// Sends proxy_request over the relay WebSocket and waits for proxy_response.
// This is the core of the full-browser experience — no external proxy server needed.

function proxyFetch(url, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve) => {
    if (!relayWs || relayWs.readyState !== WebSocket.OPEN || !agentSessionId) {
      resolve({ ok: false, status: 503, body: '', error: 'Not connected to peer' })
      return
    }
    const requestId = crypto.randomUUID()
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId)
      resolve({ ok: false, status: 504, body: '', error: 'Request timed out' })
    }, 30000)

    pendingRequests.set(requestId, { resolve, timer })
    relayWs.send(JSON.stringify({
      type: 'proxy_request',
      sessionId: agentSessionId,
      request: { requestId, url, method, headers, body },
    }))
  })
}

// ── Extension heartbeat ───────────────────────────────────────────────────────

function startExtensionHeartbeat() {
  stopExtensionHeartbeat()
  sendExtensionHeartbeat()
  heartbeatInterval = setInterval(sendExtensionHeartbeat, 30_000)
}

function stopExtensionHeartbeat() {
  if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null }
  if (!supabaseToken || !sharingUserId) return
  chrome.storage.local.get(['extId'], ({ extId }) => {
    if (!extId) return
    fetch(`${APP_URL}/api/user/sharing`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${supabaseToken}` },
      body: JSON.stringify({ device_id: extId }),
    }).catch(() => {})
  })
}

function sendExtensionHeartbeat() {
  if (!supabaseToken || !sharingCountry) return
  chrome.storage.local.get(['extId'], ({ extId }) => {
    if (!extId) return
    fetch(`${APP_URL}/api/user/sharing`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${supabaseToken}` },
      body: JSON.stringify({ device_id: `ext_${extId}`, country: sharingCountry }),
    }).catch(() => {})
  })
}

// ── Native messaging / desktop detection ─────────────────────────────────────

async function sendNativeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, message, (response) => {
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return }
      resolve(response ?? {})
    })
  })
}

async function getDesktopHelperStatusHttp() {
  try {
    const res = await fetch(`http://127.0.0.1:${CONTROL_PORT}/native/state`, { signal: AbortSignal.timeout(1500) })
    if (!res.ok) return null
    const data = await res.json()
    return {
      available: true,
      running: !!data.running,
      shareEnabled: !!data.shareEnabled,
      configured: !!data.configured,
      country: data.country ?? null,
      userId: data.userId ?? null,
      version: data.version ?? null,
    }
  } catch { return null }
}

async function getDesktopHelperStatus() {
  const http = await getDesktopHelperStatusHttp()
  if (http) return http
  try {
    const response = await sendNativeMessage({ type: 'status' })
    return {
      available: !!response.success,
      running: !!response.running,
      shareEnabled: !!response.shareEnabled,
      configured: !!response.configured,
      country: response.country ?? null,
      userId: response.userId ?? null,
      version: response.version ?? null,
    }
  } catch {
    return { available: false, running: false, shareEnabled: false, configured: false, country: null, userId: null, version: null }
  }
}

async function startDesktopSharing({ token, userId, country, trust }) {
  try {
    const response = await sendNativeMessage({ type: 'start_sharing', payload: { token, userId, country, trust } })
    if (!response.success) {
      return {
        success: false,
        error: `Desktop helper required. Download from: ${APP_URL}/api/desktop-download`,
        helper: { available: false, running: false, shareEnabled: false, configured: false, country: null, userId: null, version: null },
      }
    }
    const helper = {
      available: true,
      running: !!response.running,
      shareEnabled: !!response.shareEnabled,
      configured: !!response.configured,
      country: response.country ?? country ?? null,
      userId: response.userId ?? userId ?? null,
      version: response.version ?? null,
    }
    const isSharing = helper.running || helper.shareEnabled
    await chrome.storage.local.set({ isSharing, helper })
    return { success: isSharing, helper }
  } catch {
    return {
      success: false,
      error: `Desktop helper required for full-browser sharing. Download: ${APP_URL}/api/desktop-download`,
      helper: { available: false, running: false, shareEnabled: false, configured: false, country: null, userId: null, version: null },
    }
  }
}

async function stopDesktopSharing() {
  try {
    const response = await sendNativeMessage({ type: 'stop_sharing' })
    const helper = {
      available: true,
      running: !!response.running,
      shareEnabled: false,
      configured: !!response.configured,
      country: response.country ?? null,
      userId: response.userId ?? null,
      version: response.version ?? null,
    }
    await chrome.storage.local.set({ isSharing: false, helper })
    return { success: true, helper }
  } catch {
    await chrome.storage.local.set({ isSharing: false })
    return { success: false, error: 'Could not reach desktop helper', helper: await getDesktopHelperStatus() }
  }
}

// ── Relay connection ──────────────────────────────────────────────────────────

async function connectToRelay(opts, attempt = 0) {
  try {
    return await connectOnce(opts)
  } catch (error) {
    if (attempt < 2) {
      await new Promise(resolve => setTimeout(resolve, 1500))
      return connectToRelay(opts, attempt + 1)
    }
    throw error
  }
}

async function connectOnce({ relayEndpoint, country, userId }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relayEndpoint || RELAY_WS)
    let keepaliveTimer = null
    let settled = false

    function settle(fn, val) {
      if (settled) return
      settled = true
      clearInterval(keepaliveTimer)
      fn(val)
    }

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'request_session', country, userId, requireTunnel: false }))
      keepaliveTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }))
      }, 20000)
    }

    ws.onmessage = async (event) => {
      const msg = JSON.parse(event.data)

      if (msg.type === 'session_created') {
        agentSessionId = msg.sessionId
      }

      if (msg.type === 'agent_session_ready') {
        relayWs = ws
        agentSessionId = msg.sessionId || agentSessionId
        currentSession = { ws, sessionId: agentSessionId, country, relayEndpoint }

        // Tell desktop about this session so its local proxy can use it too
        const desktopStatus = await getDesktopHelperStatusHttp()
        if (desktopStatus?.available) {
          fetch(`http://127.0.0.1:${CONTROL_PORT}/proxy-session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: agentSessionId, relayEndpoint: relayEndpoint || RELAY_WS, country }),
          }).catch(() => {})
        }

        // Set Chrome proxy to relay:8081 for full-browser routing
        // This works because the relay's HTTP proxy server handles CONNECT tunnels
        // through the provider agent — all traffic exits from the provider's IP
        setProxy(relayEndpoint || RELAY_WS, agentSessionId)
        settle(resolve, undefined)
      }

      if (msg.type === 'proxy_response') {
        // Response to a proxy_request we sent — resolve the pending promise
        const requestId = msg.response?.requestId
        const pending = pendingRequests.get(requestId)
        if (pending) {
          clearTimeout(pending.timer)
          pendingRequests.delete(requestId)
          pending.resolve({ ok: true, status: msg.response.status, headers: msg.response.headers, body: msg.response.body, finalUrl: msg.response.finalUrl })
        }
      }

      if (msg.type === 'error') {
        ws.close(1000)
        settle(reject, new Error(msg.message))
      }

      if (msg.type === 'session_ended') {
        clearProxy()
        currentSession = null
        relayWs = null
        agentSessionId = null
        chrome.runtime.sendMessage({ type: 'SESSION_ENDED' }).catch(() => {})
      }
    }

    ws.onerror = () => { settle(reject, new Error('WebSocket connection failed')) }

    ws.onclose = () => {
      clearInterval(keepaliveTimer)
      if (currentSession) {
        clearProxy()
        currentSession = null
        relayWs = null
        agentSessionId = null
        chrome.runtime.sendMessage({ type: 'SESSION_ENDED' }).catch(() => {})
      }
      settle(reject, new Error('Connection closed before session was ready'))
    }

    setTimeout(() => {
      if (!settled) {
        ws.close(1000)
        settle(reject, new Error('No peer available in ' + country + ' — try again shortly'))
      }
    }, 25000)
  })
}

// ── Proxy settings ────────────────────────────────────────────────────────────
// Instead of an external HTTP proxy (port 8081, broken with shared IPv4),
// we open a second WebSocket to wss://relay/proxy?session=<id>.
// The relay pipes binary frames to/from the provider's TCP socket.
// The extension implements a local HTTP proxy server using chrome.sockets.tcpServer
// ... but that API isn't available in MV3 service workers.
//
// Simplest working approach: use chrome.proxy PAC pointing to the relay's
// /proxy WebSocket endpoint wrapped as an HTTP proxy via a local port.
// Since we can't open a TCP server in a service worker, we instead intercept
// all requests using the existing relay WebSocket (proxy_request for HTTP,
// proxy_ws_data for HTTPS tunnels opened by the desktop local proxy).
//
// For the Nigerian user WITHOUT desktop: proxy_request handles HTTP fetches.
// For HTTPS: the desktop local proxy (127.0.0.1:7655) handles CONNECT tunnels
// through the relay /proxy WebSocket.
//
// TL;DR: when desktop is available → use local proxy (7655) which tunnels via /proxy WS.
//        when no desktop → proxy_request over relay WS (HTTP only, HTTPS limited).

let proxyWs = null  // WebSocket to relay /proxy endpoint

function openProxyWs(relayEndpoint, sessionId) {
  if (proxyWs && proxyWs.readyState === WebSocket.OPEN) return
  const wsUrl = (relayEndpoint || RELAY_WS)
    .replace('wss://', 'wss://')
    .replace('ws://', 'ws://')
    .replace(/\/$/, '')
  const url = wsUrl.replace('wss://', 'wss://').replace('ws://', 'ws://')
  // Connect to /proxy path with session ID
  const proxyUrl = url.includes('localhost')
    ? url.replace(/(\/[^?]*)?(\?.*)?$/, `/proxy?session=${sessionId}`)
    : `wss://peermesh-relay.fly.dev/proxy?session=${encodeURIComponent(sessionId)}`

  proxyWs = new WebSocket(proxyUrl)
  proxyWs.onopen = () => console.log('[proxy-ws] connected')
  proxyWs.onclose = () => { proxyWs = null }
  proxyWs.onerror = () => { proxyWs = null }
  // Binary data from provider comes back here — forwarded to desktop local proxy
  proxyWs.onmessage = () => {}
}

function closeProxyWs() {
  if (proxyWs) { proxyWs.close(); proxyWs = null }
}

function setProxy(relayEndpoint, sessionId) {
  // Tell desktop to use the /proxy WS for tunneling
  const desktopAvailable = true // checked before calling
  // Desktop local proxy on 127.0.0.1:7655 handles CONNECT tunnels via /proxy WS
  // Chrome proxy → 127.0.0.1:7655 → relay /proxy WS → provider TCP socket
  // BUT Chrome blocks 127.0.0.1 as proxy in PAC scripts.
  //
  // Real fix: use the relay's /proxy WS directly from the desktop local proxy.
  // The desktop already has localProxyServer on 7655 that handles CONNECT.
  // We just need Chrome to use it. Chrome DOES allow 127.0.0.1 in fixed_servers mode.

  const relayUrl = (relayEndpoint || RELAY_WS).replace('wss://', 'https://').replace('ws://', 'http://')
  const relayHost = new URL(relayUrl).hostname

  // Use fixed_servers proxy mode pointing to desktop local proxy
  // Chrome allows 127.0.0.1 in fixed_servers (just not in PAC scripts)
  chrome.proxy.settings.set(
    {
      value: {
        mode: 'fixed_servers',
        rules: {
          singleProxy: { scheme: 'http', host: '127.0.0.1', port: 7655 },
          bypassList: ['localhost', '127.0.0.1', '<local>'],
        },
      },
      scope: 'regular',
    },
    () => {
      if (chrome.runtime.lastError) {
        console.error('[proxy] fixed_servers error:', chrome.runtime.lastError.message)
        // Fall back to PAC with relay host
        setProxyFallback(relayHost, sessionId)
      } else {
        console.log('[proxy] set fixed_servers → 127.0.0.1:7655')
      }
    }
  )

  chrome.storage.session.set({ proxySessionId: sessionId, proxyHost: '127.0.0.1', proxyPort: 7655 })
  chrome.action.setBadgeText({ text: 'ON' })
  chrome.action.setBadgeBackgroundColor({ color: '#00ff88' })
}

function setProxyFallback(relayHost, sessionId) {
  // Last resort: PAC script pointing to relay host (HTTP only, no HTTPS tunnels)
  const pacScript = `
    function FindProxyForURL(url, host) {
      if (host === 'localhost' || host === '127.0.0.1' || isPlainHostName(host)) return 'DIRECT';
      return 'PROXY ${relayHost}:8081';
    }
  `
  chrome.proxy.settings.set(
    { value: { mode: 'pac_script', pacScript: { data: pacScript } }, scope: 'regular' },
    () => {}
  )
  chrome.storage.session.set({ proxySessionId: sessionId, proxyHost: relayHost, proxyPort: 8081 })
}

function clearProxy() {
  chrome.proxy.settings.clear({ scope: 'regular' })
  chrome.storage.session.remove(['proxySessionId', 'proxyHost', 'proxyPort'])
  chrome.action.setBadgeText({ text: '' })
}

// Supply session ID as proxy credentials so relay can route to the right provider
chrome.webRequest.onAuthRequired.addListener(
  (details, callback) => {
    if (details.isProxy) {
      chrome.storage.session.get(['proxySessionId', 'proxyHost'], ({ proxySessionId, proxyHost }) => {
        if (proxySessionId && (!proxyHost || details.challenger?.host === proxyHost)) {
          callback({ authCredentials: { username: proxySessionId, password: 'x' } })
        } else {
          callback({})
        }
      })
    } else {
      callback({})
    }
  },
  { urls: ['<all_urls>'] },
  ['asyncBlocking']
)

async function disconnect() {
  if (relayWs?.readyState === WebSocket.OPEN) {
    relayWs.send(JSON.stringify({ type: 'end_session' }))
    relayWs.close(1000)
  }
  relayWs = null
  currentSession = null
  agentSessionId = null
  clearProxy()
  fetch(`http://127.0.0.1:${CONTROL_PORT}/proxy-session`, { method: 'DELETE' }).catch(() => {})
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

chrome.runtime.onStartup.addListener(async () => {
  clearProxy()
  await chrome.storage.local.set({ session: null })
  const stored = await chrome.storage.local.get(['supabaseToken', 'extId'])
  if (stored.supabaseToken) supabaseToken = stored.supabaseToken
  const helper = await getDesktopHelperStatus()
  const isSharing = helper.available && (helper.running || helper.shareEnabled)
  await chrome.storage.local.set({ isSharing, helper })
  if (isSharing && supabaseToken) startExtensionHeartbeat()
})

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') {
    clearProxy()
    await chrome.storage.local.clear()
  }
})

chrome.storage.local.get(['extId'], ({ extId }) => {
  if (extId) {
    chrome.runtime.setUninstallURL(`${APP_URL}/api/extension-auth/revoke?ext_id=${extId}`)
  }
})

chrome.runtime.onMessageExternal.addListener((msg) => {
  if (msg.type === 'PEERMESH_AUTH' && msg.user) {
    chrome.storage.local.set({ user: msg.user })
    chrome.runtime.sendMessage({ type: 'AUTH_SUCCESS', user: msg.user }).catch(() => {})
  }
})

chrome.alarms.create('syncSharingState', { periodInMinutes: 0.17 })
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'syncSharingState') return
  const helper = await getDesktopHelperStatus()
  const isSharing = helper.available && (helper.running || helper.shareEnabled)
  await chrome.storage.local.set({ isSharing, helper })
  if (isSharing) {
    chrome.action.setBadgeText({ text: 'SHR' })
    chrome.action.setBadgeBackgroundColor({ color: '#00ff88' })
  } else if (!currentSession) {
    chrome.action.setBadgeText({ text: '' })
  }
})
