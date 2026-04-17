// background/service-worker.js - PeerMesh Extension Service Worker

const APP_URL = 'https://peermesh-beta.vercel.app'
const RELAY_WS = 'wss://peermesh-relay.fly.dev'
const NATIVE_HOST = 'com.peermesh.desktop'

let relayWs = null
let currentSession = null
let agentSessionId = null

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
          const result = await startDesktopSharing(msg)
          sendResponse(result)
          break
        }
        case 'STOP_SHARING': {
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
        default:
          sendResponse({ success: false, error: 'Unknown message type' })
      }
    } catch (error) {
      sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) })
    }
  })()
  return true
})

// ── Native messaging ──────────────────────────────────────────────────────────

async function sendNativeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message))
        return
      }
      resolve(response ?? {})
    })
  })
}

/**
 * Ask the native host for status. If the host isn't running yet, Chrome will
 * launch the desktop app automatically (native messaging protocol).
 */
async function getDesktopHelperStatus() {
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
    // Native message auto-launches desktop app if not running
    const response = await sendNativeMessage({
      type: 'start_sharing',
      payload: { token, userId, country, trust },
    })
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
    if (attempt < 4) {
      await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)))
      return connectToRelay(opts, attempt + 1)
    }
    throw error
  }
}

async function connectOnce({ relayEndpoint, country, userId }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relayEndpoint || RELAY_WS)
    let keepaliveTimer = null

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'request_session', country, userId, requireTunnel: true }))
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
        currentSession = { ws, sessionId: msg.sessionId || agentSessionId, country, relayEndpoint }
        relayWs = ws
        agentSessionId = msg.sessionId || agentSessionId
        setProxy(relayEndpoint, agentSessionId)
        resolve()
      }

      if (msg.type === 'error') {
        ws.close()
        reject(new Error(msg.message))
      }

      if (msg.type === 'session_ended') {
        clearProxy()
        currentSession = null
        relayWs = null
        chrome.runtime.sendMessage({ type: 'SESSION_ENDED' }).catch(() => {})
      }
    }

    ws.onerror = () => {
      clearInterval(keepaliveTimer)
      reject(new Error('WebSocket connection failed'))
    }

    ws.onclose = () => {
      clearInterval(keepaliveTimer)
      if (currentSession) {
        clearProxy()
        currentSession = null
        relayWs = null
        chrome.runtime.sendMessage({ type: 'SESSION_ENDED' }).catch(() => {})
      }
    }

    setTimeout(() => {
      if (!currentSession) {
        ws.close()
        reject(new Error('Connection timed out - no peer available'))
      }
    }, 15000)
  })
}

// ── Proxy ─────────────────────────────────────────────────────────────────────

function setProxy(relayEndpoint, sessionId) {
  const relayUrl = new URL(
    relayEndpoint.replace('wss://', 'https://').replace('ws://', 'http://')
  )
  const proxyHost = relayUrl.hostname
  const proxyPort = 8081

  const pacScript = `
    function FindProxyForURL(url, host) {
      if (host === 'localhost' || host === '127.0.0.1' || isPlainHostName(host)) {
        return 'DIRECT';
      }
      return 'PROXY ${proxyHost}:${proxyPort}';
    }
  `

  chrome.proxy.settings.set(
    { value: { mode: 'pac_script', pacScript: { data: pacScript } }, scope: 'regular' },
    () => {
      if (chrome.runtime.lastError) {
        console.error('[proxy] set error:', chrome.runtime.lastError.message)
      }
    }
  )

  chrome.storage.session.set({ proxySessionId: sessionId })
  chrome.action.setBadgeText({ text: 'ON' })
  chrome.action.setBadgeBackgroundColor({ color: '#00ff88' })
}

function clearProxy() {
  chrome.proxy.settings.clear({ scope: 'regular' })
  chrome.storage.session.remove('proxySessionId')
  chrome.action.setBadgeText({ text: '' })
}

chrome.webRequest.onAuthRequired.addListener(
  (details, callback) => {
    if (details.isProxy) {
      chrome.storage.session.get('proxySessionId', ({ proxySessionId }) => {
        callback(proxySessionId
          ? { authCredentials: { username: proxySessionId, password: 'x' } }
          : {}
        )
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
    relayWs.close()
  }
  relayWs = null
  currentSession = null
  agentSessionId = null
  clearProxy()
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

chrome.runtime.onStartup.addListener(async () => {
  clearProxy()
  await chrome.storage.local.set({ session: null })
  // Re-check desktop state on browser start to sync isSharing
  const helper = await getDesktopHelperStatus()
  const isSharing = helper.available && (helper.running || helper.shareEnabled)
  await chrome.storage.local.set({ isSharing, helper })
})

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') {
    clearProxy()
    await chrome.storage.local.clear()
  }
})

chrome.storage.local.get(['extId'], ({ extId }) => {
  if (extId) {
    chrome.runtime.setUninstallURL(
      `${APP_URL}/api/extension-auth/revoke?ext_id=${extId}`
    )
  }
})

// Auth from website — store user and notify popup
chrome.runtime.onMessageExternal.addListener((msg) => {
  if (msg.type === 'PEERMESH_AUTH' && msg.user) {
    chrome.storage.local.set({ user: msg.user })
    chrome.runtime.sendMessage({ type: 'AUTH_SUCCESS', user: msg.user }).catch(() => {})
  }
})

// Periodic sharing state sync (every 30s) to keep badge and storage consistent
chrome.alarms.create('syncSharingState', { periodInMinutes: 0.5 })
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
