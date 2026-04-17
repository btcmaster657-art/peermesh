// background/service-worker.js - PeerMesh Extension Service Worker

const APP_URL = 'https://peermesh-beta.vercel.app'
const RELAY_WS = 'wss://peermesh-relay.fly.dev'
const NATIVE_HOST = 'com.peermesh.desktop'
const CONTROL_PORT = 7654

let relayWs = null
let currentSession = null
let agentSessionId = null
let supabaseToken = null
let desktopToken = null
let sharingUserId = null
let sharingCountry = null
let heartbeatInterval = null

const pendingRequests = new Map()

// ── Logger ────────────────────────────────────────────────────────────────────

const MAX_LOGS = 200
const _logs = []

function log(level, ...args) {
  const ts = new Date().toISOString().slice(11, 23)
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')
  const entry = { ts, level, msg }
  _logs.push(entry)
  if (_logs.length > MAX_LOGS) _logs.shift()
  console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](`[${ts}] [SW] ${msg}`)
  chrome.runtime.sendMessage({ type: 'LOG', entry }).catch(() => {})
}

function getLogs() { return [..._logs] }

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  ;(async () => {
    try {
      switch (msg.type) {
        case 'GET_LOGS':
          sendResponse({ logs: getLogs() })
          break
        case 'CONNECT':
          log('info', 'CONNECT country=' + msg.country + ' userId=' + msg.userId?.slice(0,8))
          await connectToRelay(msg)
          sendResponse({ success: true })
          break
        case 'DISCONNECT':
          log('info', 'DISCONNECT requested')
          await disconnect()
          sendResponse({ success: true })
          break
        case 'START_SHARING': {
          if (msg.supabaseToken) {
            supabaseToken = msg.supabaseToken
            desktopToken = msg.desktopToken || null
            sharingUserId = msg.userId
            sharingCountry = msg.country
            await chrome.storage.local.set({ supabaseToken, desktopToken, sharingCountry, sharingUserId })
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
          log('info', 'GET_STATUS helper.available=' + helper.available + ' running=' + helper.running + ' isSharing=' + isSharing)
          await chrome.storage.local.set({ isSharing, helper })
          sendResponse({ connected: !!currentSession, session: currentSession, isSharing, helper })
          break
        }
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

// ── Proxy fetch ───────────────────────────────────────────────────────────────

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
  const token = desktopToken || supabaseToken
  if (!token || !sharingUserId) return
  chrome.storage.local.get(['extId'], ({ extId }) => {
    if (!extId) return
    fetch(`${APP_URL}/api/user/sharing`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ device_id: extId }),
    }).catch(() => {})
  })
}

function sendExtensionHeartbeat() {
  const token = desktopToken || supabaseToken
  if (!token || !sharingCountry) return
  chrome.storage.local.get(['extId'], ({ extId }) => {
    if (!extId) return
    fetch(`${APP_URL}/api/user/sharing`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ device_id: `ext_${extId}`, country: sharingCountry }),
    })
      .then(r => { if (!r.ok) r.json().then(b => log('warn', `[HEARTBEAT] PUT failed status=${r.status} body=${JSON.stringify(b)}`)) })
      .catch(e => log('error', `[HEARTBEAT] PUT error: ${e.message}`))
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
    if (!res.ok) { log('warn', 'desktop HTTP status not ok: ' + res.status); return null }
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
  } catch (e) { log('warn', 'desktop HTTP unreachable: ' + e.message); return null }
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
    const res = await fetch(`http://127.0.0.1:${CONTROL_PORT}/native/share/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, userId, country, trust }),
      signal: AbortSignal.timeout(4000),
    })
    if (res.ok) {
      const data = await res.json()
      const helper = {
        available: true,
        running: !!data.running,
        shareEnabled: !!data.shareEnabled,
        configured: !!data.configured,
        country: data.country ?? country ?? null,
        userId: data.userId ?? userId ?? null,
        version: data.version ?? null,
      }
      const isSharing = helper.running || helper.shareEnabled
      await chrome.storage.local.set({ isSharing, helper })
      return { success: isSharing, helper }
    }
  } catch {}

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
    const res = await fetch(`http://127.0.0.1:${CONTROL_PORT}/native/share/stop`, {
      method: 'POST',
      signal: AbortSignal.timeout(4000),
    })
    if (res.ok) {
      const data = await res.json()
      const helper = {
        available: true, running: !!data.running, shareEnabled: false,
        configured: !!data.configured, country: data.country ?? null,
        userId: data.userId ?? null, version: data.version ?? null,
      }
      await chrome.storage.local.set({ isSharing: false, helper })
      return { success: true, helper }
    }
  } catch {}

  try {
    const response = await sendNativeMessage({ type: 'stop_sharing' })
    const helper = {
      available: true, running: !!response.running, shareEnabled: false,
      configured: !!response.configured, country: response.country ?? null,
      userId: response.userId ?? null, version: response.version ?? null,
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

async function connectOnce({ relayEndpoint, country, userId, dbSessionId, preferredProviderUserId }) {
  return new Promise((resolve, reject) => {
    const wsUrl = relayEndpoint || RELAY_WS
    log('info', `[CONNECT] WS connecting to ${wsUrl} country=${country} userId=${userId?.slice(0,8)}`)
    const ws = new WebSocket(wsUrl)
    let keepaliveTimer = null
    let settled = false

    function settle(fn, val) {
      if (settled) return
      settled = true
      clearInterval(keepaliveTimer)
      fn(val)
    }

    ws.onopen = () => {
      log('info', `[CONNECT] WS open → sending request_session country=${country}`)
      ws.send(JSON.stringify({ type: 'request_session', country, userId, dbSessionId: dbSessionId ?? null, preferredProviderUserId: preferredProviderUserId ?? null, requireTunnel: false }))
      keepaliveTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }))
      }, 20000)
    }

    ws.onmessage = async (event) => {
      const msg = JSON.parse(event.data)
      if (msg.type !== 'pong') log('info', `[CONNECT] msg=${msg.type}${msg.sessionId ? ' session=' + msg.sessionId.slice(0,8) : ''}`)

      if (msg.type === 'session_created') {
        agentSessionId = msg.sessionId
      }

      if (msg.type === 'agent_session_ready') {
        relayWs = ws
        agentSessionId = msg.sessionId || agentSessionId
        currentSession = { ws, sessionId: agentSessionId, country, relayEndpoint }

        const desktopStatus = await getDesktopHelperStatusHttp()
        if (desktopStatus?.available) {
          try {
            await fetch(`http://127.0.0.1:${CONTROL_PORT}/proxy-session`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sessionId: agentSessionId, relayEndpoint: relayEndpoint || RELAY_WS, country }),
            })
            log('info', '[CONNECT] proxy-session sent to desktop ✓')
          } catch (e) {
            log('error', `[CONNECT] proxy-session failed: ${e.message}`)
          }
          setProxyDesktop(agentSessionId)
        } else {
          setProxyRelay(relayEndpoint || RELAY_WS, agentSessionId)
        }
        settle(resolve, undefined)
      }

      // ── Auto-reconnect: relay found a new provider transparently ─────────
      if (msg.type === 'session_reconnected') {
        agentSessionId = msg.sessionId
        if (currentSession) currentSession = { ...currentSession, sessionId: msg.sessionId }
        log('info', `[CONNECT] session_reconnected attempt=${msg.attempt} newSession=${msg.sessionId?.slice(0,8)}`)

        // Update desktop local proxy with new sessionId so tunnels route correctly
        fetch(`http://127.0.0.1:${CONTROL_PORT}/proxy-session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: msg.sessionId, relayEndpoint: relayEndpoint || RELAY_WS, country: msg.country }),
        }).catch(() => {})

        // Update proxy auth credentials with new sessionId
        chrome.storage.session.set({ proxySessionId: msg.sessionId })

        // Notify popup so it can show a brief "reconnected" indicator
        chrome.runtime.sendMessage({ type: 'SESSION_RECONNECTED', sessionId: msg.sessionId, attempt: msg.attempt }).catch(() => {})
      }

      if (msg.type === 'proxy_response') {
        const requestId = msg.response?.requestId
        const pending = pendingRequests.get(requestId)
        if (pending) {
          clearTimeout(pending.timer)
          pendingRequests.delete(requestId)
          pending.resolve({ ok: true, status: msg.response.status, headers: msg.response.headers, body: msg.response.body, finalUrl: msg.response.finalUrl })
        }
      }

      if (msg.type === 'error') {
        log('error', `[CONNECT] relay error: ${msg.message}`)
        ws.close(1000)
        settle(reject, new Error(msg.message))
      }

      if (msg.type === 'session_ended') {
        log('info', '[CONNECT] session_ended → clearing proxy')
        clearProxy()
        currentSession = null
        relayWs = null
        agentSessionId = null
        chrome.runtime.sendMessage({ type: 'SESSION_ENDED' }).catch(() => {})
      }
    }

    ws.onerror = (e) => {
      log('error', `[CONNECT] WS error: ${e.message || 'unknown'}`)
      settle(reject, new Error('WebSocket connection failed'))
    }

    ws.onclose = (e) => {
      log('warn', `[CONNECT] WS closed code=${e.code} reason=${e.reason || 'none'}`)
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
        log('warn', `[CONNECT] timeout — no peer found in ${country} after 25s`)
        ws.close(1000)
        settle(reject, new Error('No peer available in ' + country + ' — try again shortly'))
      }
    }, 25000)
  })
}

// ── Proxy settings ────────────────────────────────────────────────────────────

function setProxyDesktop(sessionId) {
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
        log('error', `[PROXY] fixed_servers error: ${chrome.runtime.lastError.message}`)
      } else {
        log('info', '[PROXY] mode=fixed_servers 127.0.0.1:7655 ✓')
      }
    }
  )
  chrome.storage.session.set({ proxySessionId: sessionId, proxyHost: '127.0.0.1', proxyPort: 7655 })
  chrome.action.setBadgeText({ text: 'ON' })
  chrome.action.setBadgeBackgroundColor({ color: '#00ff88' })
}

function setProxyRelay(relayEndpoint, sessionId) {
  const relayUrl = (relayEndpoint || RELAY_WS).replace('wss://', 'https://').replace('ws://', 'http://')
  const relayHost = new URL(relayUrl).hostname
  const pacScript = `
    function FindProxyForURL(url, host) {
      if (host === 'localhost' || host === '127.0.0.1' || isPlainHostName(host)) return 'DIRECT';
      return 'PROXY ${relayHost}:8081';
    }
  `
  chrome.proxy.settings.set(
    { value: { mode: 'pac_script', pacScript: { data: pacScript } }, scope: 'regular' },
    () => {
      if (chrome.runtime.lastError) log('error', `[PROXY] PAC error: ${chrome.runtime.lastError.message}`)
      else log('info', `[PROXY] PAC active → ${relayHost}:8081 ✓`)
    }
  )
  chrome.storage.session.set({ proxySessionId: sessionId, proxyHost: relayHost, proxyPort: 8081 })
  chrome.action.setBadgeText({ text: 'ON' })
  chrome.action.setBadgeBackgroundColor({ color: '#00ff88' })
}

function clearProxy() {
  log('info', 'proxy cleared')
  chrome.proxy.settings.clear({ scope: 'regular' })
  chrome.storage.session.remove(['proxySessionId', 'proxyHost', 'proxyPort'])
  chrome.action.setBadgeText({ text: '' })
}

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
  const stored = await chrome.storage.local.get(['supabaseToken', 'desktopToken', 'extId', 'sharingCountry', 'sharingUserId'])
  if (stored.supabaseToken) supabaseToken = stored.supabaseToken
  if (stored.desktopToken) desktopToken = stored.desktopToken
  if (stored.sharingCountry) sharingCountry = stored.sharingCountry
  if (stored.sharingUserId) sharingUserId = stored.sharingUserId
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

  if (!supabaseToken || !sharingCountry) {
    const stored = await chrome.storage.local.get(['supabaseToken', 'desktopToken', 'sharingCountry', 'sharingUserId'])
    if (stored.supabaseToken) supabaseToken = stored.supabaseToken
    if (stored.desktopToken) desktopToken = stored.desktopToken
    if (stored.sharingCountry) sharingCountry = stored.sharingCountry
    if (stored.sharingUserId) sharingUserId = stored.sharingUserId
  }

  const helper = await getDesktopHelperStatus()
  const isSharing = helper.available && (helper.running || helper.shareEnabled)
  await chrome.storage.local.set({ isSharing, helper })
  if (isSharing) {
    if (supabaseToken && sharingCountry && !heartbeatInterval) startExtensionHeartbeat()
    chrome.action.setBadgeText({ text: 'SHR' })
    chrome.action.setBadgeBackgroundColor({ color: '#00ff88' })
  } else if (!currentSession) {
    chrome.action.setBadgeText({ text: '' })
  }
})
