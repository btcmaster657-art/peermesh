// popup.js — PeerMesh Chrome Extension

const API = 'https://peermesh-beta.vercel.app'

const COUNTRIES = [
  { code: 'NG', flag: '🇳🇬', name: 'Nigeria' },
  { code: 'GB', flag: '🇬🇧', name: 'UK' },
  { code: 'US', flag: '🇺🇸', name: 'USA' },
  { code: 'KE', flag: '🇰🇪', name: 'Kenya' },
  { code: 'ZA', flag: '🇿🇦', name: 'S.Africa' },
  { code: 'DE', flag: '🇩🇪', name: 'Germany' },
  { code: 'CA', flag: '🇨🇦', name: 'Canada' },
  { code: 'AU', flag: '🇦🇺', name: 'Australia' },
  { code: 'BR', flag: '🇧🇷', name: 'Brazil' },
  { code: 'JP', flag: '🇯🇵', name: 'Japan' },
  { code: 'RW', flag: '🇷🇼', name: 'Rwanda' },
  { code: 'GH', flag: '🇬🇭', name: 'Ghana' },
]

let state = {
  user: null,
  session: null,
  isSharing: false,
  helper: null,
  selectedCountry: null,
  peerCounts: {},
  loading: true,
  error: null,
  extId: null,
  supabaseToken: null,
}

// ── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  const stored = await chrome.storage.local.get(['user', 'session', 'isSharing', 'helper', 'selectedCountry', 'extId', 'supabaseToken'])

  // Generate a stable extension UUID if not yet created
  if (!stored.extId) {
    stored.extId = crypto.randomUUID()
    await chrome.storage.local.set({ extId: stored.extId })
  }
  state = { ...state, ...stored }

  // Load peer counts
  try {
    const res = await fetch(`${API}/api/peers/available`)
    const data = await res.json()
    data.peers?.forEach(p => { state.peerCounts[p.country] = p.count })
  } catch {}

  if (state.user) {
    await refreshRuntimeStatus()
    startPeerPolling()
  }

  state.loading = false
  render()
  renderLogPanel()
  await initLogPanel()

  if (!state.user) startAuthPolling()
}

// ── Auth polling — checks if user signed in on website ────────────────────────

let authPollInterval = null
let peerPollInterval = null
let statusPollInterval = null

async function refreshRuntimeStatus() {
  try {
    const status = await chrome.runtime.sendMessage({ type: 'GET_STATUS' })
    if (!status) return
    state.session = status.session || null
    state.helper = status.helper || null
    // Desktop is source of truth for sharing state
    state.isSharing = !!(state.helper?.available && (state.helper?.running || state.helper?.shareEnabled))
    await chrome.storage.local.set({
      session: state.session,
      isSharing: state.isSharing,
      helper: state.helper,
    })
  } catch {}
}

function startPeerPolling() {
  if (peerPollInterval) return
  peerPollInterval = setInterval(async () => {
    try {
      const res = await fetch(`${API}/api/peers/available`)
      const data = await res.json()
      const updated = {}
      data.peers?.forEach(p => { updated[p.country] = p.count })
      state.peerCounts = updated
      // Only re-render the grid, not the whole popup
      document.querySelectorAll('.country-btn').forEach(btn => {
        const count = state.peerCounts[btn.dataset.code] ?? 0
        btn.querySelector('.peers').textContent = count > 0 ? count + ' peers' : 'no peers'
        btn.classList.toggle('no-peers', count === 0)
      })
    } catch {}
  }, 30000)

  if (!statusPollInterval) {
    statusPollInterval = setInterval(async () => {
      await refreshRuntimeStatus()
      // Desktop is source of truth — sync isSharing from it
      const desktopSharing = !!(state.helper?.available && (state.helper?.running || state.helper?.shareEnabled))
      if (state.isSharing !== desktopSharing) {
        state.isSharing = desktopSharing
        await chrome.storage.local.set({ isSharing: desktopSharing })
      }
      render()
    }, 3000)
  }
}

function startAuthPolling() {
  if (authPollInterval) return
  authPollInterval = setInterval(async () => {
    try {
      const res = await fetch(`${API}/api/extension-auth?ext_id=${state.extId}`)
      if (!res.ok) return
      const data = await res.json()
      if (data.user) {
        clearInterval(authPollInterval)
        authPollInterval = null
        state.user = data.user
        state.supabaseToken = data.user.supabaseToken ?? null
        state.loading = false
        await chrome.storage.local.set({ user: data.user, supabaseToken: state.supabaseToken, desktopToken: data.user.token })
        await refreshRuntimeStatus()
        render()
        startPeerPolling()
      }
    } catch {}
  }, 2000)
}

// ── Render ────────────────────────────────────────────────────────────────────

function render() {
  const app = document.getElementById('app')

  if (state.loading) {
    app.innerHTML = `<div class="loading"><div class="spinner"></div>LOADING...</div>`
    return
  }

  if (!state.user) {
    renderAuth(app)
    return
  }

  renderDashboard(app)
}

function renderAuth(app) {
  app.innerHTML = `
    <div class="header">
      <span class="logo">PEERMESH</span>
    </div>
    <div class="auth-screen">
      <h2>Welcome</h2>
      <p>Sign in to start browsing.</p>
      <div style="margin:20px 0;display:flex;align-items:center;justify-content:center;gap:8px;color:#666680;font-size:11px;font-family:'Courier New',monospace">
        <span style="display:inline-block;width:8px;height:8px;border:2px solid #1e1e2a;border-top-color:#00ff88;border-radius:50%;animation:spin 0.8s linear infinite"></span>
        WAITING FOR SIGN IN...
      </div>
      <button class="btn-primary" id="openDashboard" style="margin-top:4px">SIGN IN</button>
      <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
    </div>`

  document.getElementById('openDashboard').onclick = () => {
    chrome.tabs.create({ url: `${API}/extension?ext_id=${state.extId}` })
  }
}

function renderDashboard(app) {
  const { session, isSharing, selectedCountry, user, helper } = state
  const helperReady = !!helper?.available
  const helperLabel = helperReady
    ? (isSharing ? 'Desktop helper active — full-browser sharing enabled.' : 'Desktop helper detected — ready to share.')
    : 'Desktop helper required for full-browser sharing.'

  app.innerHTML = `
    <div class="header">
      <span class="logo">PEERMESH</span>
      <div class="status-pill ${session ? 'connected' : ''}">
        <div class="status-dot"></div>
        ${session ? `VIA ${session.country}` : 'DISCONNECTED'}
      </div>
    </div>

    ${session ? `
    <div class="section">
      <div class="session-card">
        <div class="via">Browsing via peer</div>
        <div class="country-display">${getFlagForCountry(session.country)} ${session.country}</div>
      </div>
      <button class="connect-btn disconnect" id="disconnectBtn">DISCONNECT</button>
    </div>
    ` : `
    <div class="section">
      <div class="section-label">Browse as...</div>
      <div class="country-grid" id="countryGrid">
        ${COUNTRIES.map(c => {
          const count = state.peerCounts[c.code] ?? 0
          return `
          <button class="country-btn ${selectedCountry === c.code ? 'selected' : ''} ${count === 0 ? 'no-peers' : ''}"
                  data-code="${c.code}">
            <span class="flag">${c.flag}</span>
            <span class="name">${c.name}</span>
            <span class="peers">${count > 0 ? count + ' peers' : 'no peers'}</span>
          </button>`
        }).join('')}
      </div>
    </div>
    <div class="section">
      <button class="connect-btn" id="connectBtn" ${!selectedCountry ? 'disabled' : ''}>
        ${selectedCountry ? `CONNECT ${getFlagForCountry(selectedCountry)} ${selectedCountry}` : 'SELECT A COUNTRY'}
      </button>
      ${state.error ? `<div class="error-msg">${state.error} <button id="retryBtn" style="background:none;border:none;color:#00ff88;font-family:'Courier New',monospace;font-size:11px;cursor:pointer;text-decoration:underline">RETRY</button></div>` : ''}
    </div>
    `}

    <div class="section">
      <div class="share-row">
        <div class="share-info">
          <h4>Share my connection</h4>
          <p>${isSharing ? 'Sharing active — earning credits' : 'Help others browse. Stay free.'}</p>
        </div>
        <label class="toggle">
          <input type="checkbox" id="shareToggle" ${isSharing ? 'checked' : ''}>
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>

    <div class="stats">
      <div class="stat">
        <span class="val">${formatBytes(user.totalShared || 0)}</span>
        <span class="lbl">SHARED</span>
      </div>
      <div class="stat">
        <span class="val">${formatBytes(user.totalUsed || 0)}</span>
        <span class="lbl">USED</span>
      </div>
      <div class="stat">
        <span class="val">${user.trustScore || 50}</span>
        <span class="lbl">TRUST</span>
      </div>
    </div>

    <div style="padding:0 16px 12px;display:flex;justify-content:space-between;align-items:center">
      <span style="font-size:10px;color:var(--muted)">${user.username || user.email || ''}</span>
      <button id="signOutBtn" style="background:none;border:none;color:var(--muted);font-size:10px;cursor:pointer;font-family:'Courier New',monospace">SIGN OUT</button>
    </div>`

  const shareInfo = app.querySelector('.share-info p')
  if (shareInfo) shareInfo.textContent = helperLabel

  if (!helperReady) {
    const shareSection = shareInfo?.closest('.section')
    if (shareSection) {
      const helperNotice = document.createElement('div')
      helperNotice.className = 'error-msg'
      helperNotice.innerHTML = 'Desktop helper not installed. <a id="installHelperBtn" href="#" style="color:#00ff88;font-family:\'Courier New\',monospace;font-size:11px;text-decoration:underline">DOWNLOAD & INSTALL</a>'
      shareSection.appendChild(helperNotice)
    }
    // Disable the share toggle visually
    const toggle = document.getElementById('shareToggle')
    if (toggle) { toggle.disabled = true; toggle.style.opacity = '0.4'; toggle.style.cursor = 'not-allowed' }
  }

  // Bind events
  document.querySelectorAll('.country-btn').forEach(btn => {
    btn.onclick = () => {
      state.selectedCountry = btn.dataset.code
      state.error = null
      chrome.storage.local.set({ selectedCountry: state.selectedCountry })
      render()
    }
  })

  document.getElementById('connectBtn')?.addEventListener('click', connectSession)
  document.getElementById('retryBtn')?.addEventListener('click', () => { state.error = null; render(); connectSession() })
  document.getElementById('disconnectBtn')?.addEventListener('click', disconnectSession)
  document.getElementById('shareToggle')?.addEventListener('change', e => toggleSharing(e.target.checked))
  document.getElementById('signOutBtn')?.addEventListener('click', signOut)
  document.getElementById('installHelperBtn')?.addEventListener('click', (e) => {
    e.preventDefault()
    chrome.tabs.create({ url: `${API}/api/desktop-download` })
  })
}

// ── Actions ───────────────────────────────────────────────────────────────────

async function connectSession() {
  if (!state.selectedCountry || !state.user) return

  const btn = document.getElementById('connectBtn')
  btn.disabled = true
  btn.textContent = 'CONNECTING...'
  state.error = null

  try {
    const res = await fetch(`${API}/api/session/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.supabaseToken || state.user.token}`,
      },
      body: JSON.stringify({ country: state.selectedCountry }),
    })

    const data = await res.json()
    if (data.error) throw new Error(data.error)

    // Tell service worker to connect to relay
    const response = await chrome.runtime.sendMessage({
      type: 'CONNECT',
      relayEndpoint: data.relayEndpoint,
      country: state.selectedCountry,
      userId: state.user.id,
      token: state.supabaseToken || state.user.token,
    })

    if (!response?.success) throw new Error(response?.error || 'Connection failed')

    state.session = {
      id: data.sessionId,
      country: state.selectedCountry,
      relayEndpoint: data.relayEndpoint,
    }
    await chrome.storage.local.set({ session: state.session })
    render()

  } catch (err) {
    state.error = err.message
    render()
  }
}

async function disconnectSession() {
  if (state.session) {
    await chrome.runtime.sendMessage({ type: 'DISCONNECT' })

    try {
      await fetch(`${API}/api/session/end`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${state.supabaseToken || state.user?.token}`,
        },
        body: JSON.stringify({ sessionId: state.session.id }),
      })
    } catch {}
  }

  state.session = null
  await chrome.storage.local.set({ session: null })
  render()
}

async function toggleSharing(on) {
  if (on && !state.helper?.available) {
    // Block toggle — desktop helper required
    state.error = `Desktop helper required. <a href="${API}/api/desktop-download" style="color:#00ff88">Download & install</a> then reopen.`
    render()
    return
  }

  const previous = state.isSharing
  state.isSharing = on
  render()

  const response = await chrome.runtime.sendMessage({
    type: on ? 'START_SHARING' : 'STOP_SHARING',
    country: state.user?.country,
    userId: state.user?.id,
    token: state.user?.token,
    supabaseToken: state.supabaseToken,
    desktopToken: state.user?.token,
    trust: state.user?.trustScore || 50,
  })

  if (!response?.success) {
    state.isSharing = previous
    state.helper = response?.helper || state.helper
    state.error = response?.error || 'Desktop helper is required'
    render()
    return
  }

  state.error = null
  state.isSharing = on
  state.helper = response.helper || state.helper
  await chrome.storage.local.set({ isSharing: on, helper: state.helper })

  try {
    await fetch(`${API}/api/user/sharing`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.supabaseToken || state.user?.token}`,
      },
      body: JSON.stringify({ isSharing: on }),
    })
  } catch {}

  await refreshRuntimeStatus()
  render()
}

async function signOut() {
  await disconnectSession()
  state.user = null
  state.session = null
  state.isSharing = false
  state.helper = null
  await chrome.storage.local.clear()
  render()
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getFlagForCountry(code) {
  return COUNTRIES.find(c => c.code === code)?.flag ?? '🌍'
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`
}

// ── Debug log panel ──────────────────────────────────────────────────────────

const logEntries = []

function appendLog(entry) {
  logEntries.push(entry)
  if (logEntries.length > 200) logEntries.shift()
  const panel = document.getElementById('pm-log-body')
  if (!panel) return
  const line = document.createElement('div')
  line.style.cssText = `color:${entry.level === 'error' ? '#ff6060' : entry.level === 'warn' ? '#ffaa00' : '#aaa'};margin:1px 0;word-break:break-all`
  line.textContent = `${entry.ts} ${entry.msg}`
  panel.appendChild(line)
  panel.scrollTop = panel.scrollHeight
}

async function initLogPanel() {
  // Load existing logs from SW
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_LOGS' })
    if (res?.logs) res.logs.forEach(appendLog)
  } catch {}
}

// Listen for live log entries from SW
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'LOG') appendLog(msg.entry)
  if (msg.type === 'AUTH_SUCCESS') {
    state.user = msg.user
    chrome.storage.local.set({ user: msg.user })
    render()
  }
})

function renderLogPanel() {
  const existing = document.getElementById('pm-log-panel')
  if (existing) return
  const panel = document.createElement('div')
  panel.id = 'pm-log-panel'
  panel.innerHTML = `
    <div id="pm-log-toggle" style="padding:6px 16px;font-size:10px;color:#444;cursor:pointer;font-family:'Courier New',monospace;display:flex;justify-content:space-between;border-top:1px solid #1a1a2a">
      <span>DEBUG LOGS</span><span id="pm-log-arrow">▼</span>
    </div>
    <div id="pm-log-body" style="display:none;max-height:160px;overflow-y:auto;padding:4px 16px 8px;font-size:10px;font-family:'Courier New',monospace;background:#050508"></div>
    <div style="padding:2px 16px 8px;display:flex;gap:6px">
      <button id="pm-log-copy" style="background:none;border:1px solid #222;color:#555;font-size:9px;font-family:'Courier New',monospace;cursor:pointer;padding:2px 8px;border-radius:3px">COPY</button>
      <button id="pm-log-clear" style="background:none;border:1px solid #222;color:#555;font-size:9px;font-family:'Courier New',monospace;cursor:pointer;padding:2px 8px;border-radius:3px">CLEAR</button>
    </div>`
  document.body.appendChild(panel)

  // Populate existing entries
  logEntries.forEach(e => {
    const line = document.createElement('div')
    line.style.cssText = `color:${e.level === 'error' ? '#ff6060' : e.level === 'warn' ? '#ffaa00' : '#aaa'};margin:1px 0;word-break:break-all`
    line.textContent = `${e.ts} ${e.msg}`
    document.getElementById('pm-log-body').appendChild(line)
  })

  let open = false
  document.getElementById('pm-log-toggle').onclick = () => {
    open = !open
    document.getElementById('pm-log-body').style.display = open ? 'block' : 'none'
    document.getElementById('pm-log-arrow').textContent = open ? '▲' : '▼'
    if (open) document.getElementById('pm-log-body').scrollTop = document.getElementById('pm-log-body').scrollHeight
  }
  document.getElementById('pm-log-copy').onclick = () => {
    const text = logEntries.map(e => `${e.ts} [${e.level}] ${e.msg}`).join('\n')
    navigator.clipboard.writeText(text).catch(() => {})
  }
  document.getElementById('pm-log-clear').onclick = () => {
    logEntries.length = 0
    document.getElementById('pm-log-body').innerHTML = ''
  }
}

// ── Listen for auth from website ──────────────────────────────────────────────

// (moved above into onMessage listener)

init()
