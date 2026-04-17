// background/service-worker.js — PeerMesh Extension Service Worker

const RELAY_WS = 'wss://peermesh-relay.fly.dev'

let relayWs = null
let currentSession = null
let agentSessionId = null
let isSharing = false
let providerWs = null
const pendingRequests = new Map() // requestId → { resolve, reject }

// ── Message handler from popup ────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  ;(async () => {
    switch (msg.type) {
      case 'CONNECT':
        try {
          await connectToRelay(msg)
          sendResponse({ success: true })
        } catch (e) {
          sendResponse({ success: false, error: e.message })
        }
        break
      case 'DISCONNECT':
        await disconnect()
        sendResponse({ success: true })
        break
      case 'START_SHARING':
        await startSharing(msg)
        sendResponse({ success: true })
        break
      case 'STOP_SHARING':
        stopSharing()
        sendResponse({ success: true })
        break
      case 'GET_STATUS':
        sendResponse({ connected: !!currentSession, session: currentSession, isSharing })
        break
      case 'PROXY_FETCH':
        // Popup or content script asks us to fetch via relay
        try {
          const result = await proxyFetch(msg.url, msg.options)
          sendResponse({ success: true, data: result })
        } catch (e) {
          sendResponse({ success: false, error: e.message })
        }
        break
    }
  })()
  return true
})

// ── Connect as requester ──────────────────────────────────────────────────────

async function connectToRelay({ relayEndpoint, country, userId }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relayEndpoint || RELAY_WS)

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'request_session', country, userId }))
    }

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data)

      if (msg.type === 'session_created') {
        agentSessionId = msg.sessionId
      }

      if (msg.type === 'agent_session_ready') {
        currentSession = { ws, sessionId: msg.sessionId || agentSessionId, country, relayEndpoint }
        relayWs = ws
        agentSessionId = msg.sessionId || agentSessionId
        chrome.action.setBadgeText({ text: 'ON' })
        chrome.action.setBadgeBackgroundColor({ color: '#00ff88' })
        resolve()
      }

      if (msg.type === 'proxy_response') {
        // Agent responded to a fetch request
        const pending = pendingRequests.get(msg.response?.requestId)
        if (pending) {
          pending.resolve(msg.response)
          pendingRequests.delete(msg.response.requestId)
        }
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

    ws.onerror = () => reject(new Error('WebSocket connection failed'))
    ws.onclose = () => {
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
        reject(new Error('Connection timed out — no peer available'))
      }
    }, 15000)
  })
}

// ── Proxy fetch via relay ─────────────────────────────────────────────────────

function proxyFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    if (!relayWs || relayWs.readyState !== WebSocket.OPEN) {
      reject(new Error('Not connected to relay'))
      return
    }

    const requestId = crypto.randomUUID()
    pendingRequests.set(requestId, { resolve, reject })

    relayWs.send(JSON.stringify({
      type: 'proxy_request',
      sessionId: agentSessionId,
      request: {
        requestId,
        url,
        method: options.method || 'GET',
        headers: options.headers || {},
        body: options.body || null,
      },
    }))

    setTimeout(() => {
      if (pendingRequests.has(requestId)) {
        pendingRequests.delete(requestId)
        reject(new Error('Request timed out'))
      }
    }, 30000)
  })
}

// ── Set Chrome proxy to PAC script that routes through relay proxy ────────────

function setProxy(relayEndpoint) {
  // Build a PAC script URL — relay's HTTP proxy on port 8081
  const relayUrl = new URL(
    relayEndpoint.replace('wss://', 'https://').replace('ws://', 'http://')
  )
  const proxyHost = relayUrl.hostname
  const proxyPort = 8081 // relay HTTP proxy port

  const pacScript = `
    function FindProxyForURL(url, host) {
      if (host === 'localhost' || host === '127.0.0.1' || isPlainHostName(host)) {
        return 'DIRECT';
      }
      return 'PROXY ${proxyHost}:${proxyPort}';
    }
  `

  chrome.proxy.settings.set({
    value: {
      mode: 'pac_script',
      pacScript: { data: pacScript },
    },
    scope: 'regular',
  }, () => {
    if (chrome.runtime.lastError) {
      console.error('[proxy] set error:', chrome.runtime.lastError.message)
    } else {
      console.log(`[proxy] PAC script set — routing via ${proxyHost}:${proxyPort}`)
    }
  })

  chrome.action.setBadgeText({ text: 'ON' })
  chrome.action.setBadgeBackgroundColor({ color: '#00ff88' })
}

function clearProxy() {
  chrome.proxy.settings.clear({ scope: 'regular' })
  chrome.action.setBadgeText({ text: '' })
}

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

// ── Share as provider ─────────────────────────────────────────────────────────

async function startSharing({ country, userId }) {
  if (providerWs) { providerWs.close(); providerWs = null }

  providerWs = new WebSocket(RELAY_WS)
  providerWs.onopen = () => {
    providerWs.send(JSON.stringify({
      type: 'register_provider',
      userId,
      country,
      trustScore: 50,
      agentMode: false,
    }))
    isSharing = true
  }
  providerWs.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    if (msg.type === 'session_request') {
      providerWs.send(JSON.stringify({ type: 'agent_ready', sessionId: msg.sessionId }))
    }
  }
  providerWs.onclose = () => { isSharing = false }
}

function stopSharing() {
  providerWs?.close()
  providerWs = null
  isSharing = false
}

// ── Restore state on startup ──────────────────────────────────────────────────

chrome.runtime.onStartup.addListener(async () => {
  clearProxy()
  await chrome.storage.local.set({ session: null })
})

// ── Fresh install: wipe everything so new ext_id is generated ─────────────────

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') {
    clearProxy()
    await chrome.storage.local.clear()
  }
})

// ── Uninstall: hit cleanup endpoint to invalidate token in DB ─────────────────

chrome.storage.local.get(['extId'], ({ extId }) => {
  if (extId) {
    chrome.runtime.setUninstallURL(
      `https://peermesh-beta.vercel.app/api/extension-auth/revoke?ext_id=${extId}`
    )
  }
})

// ── Listen for auth from website ──────────────────────────────────────────────

chrome.runtime.onMessageExternal.addListener((msg) => {
  if (msg.type === 'PEERMESH_AUTH' && msg.user) {
    chrome.storage.local.set({ user: msg.user })
    chrome.runtime.sendMessage({ type: 'AUTH_SUCCESS', user: msg.user }).catch(() => {})
  }
})
