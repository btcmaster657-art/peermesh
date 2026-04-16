// popup.js — PeerMesh Chrome Extension

const API = 'http://localhost:3000' // replaced with https://your-app.vercel.app in production

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
  selectedCountry: null,
  peerCounts: {},
  loading: true,
  error: null,
}

// ── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  const stored = await chrome.storage.local.get(['user', 'session', 'isSharing', 'selectedCountry'])
  state = { ...state, ...stored }

  // Load peer counts
  try {
    const res = await fetch(`${API}/api/peers/available`)
    const data = await res.json()
    data.peers?.forEach(p => { state.peerCounts[p.country] = p.count })
  } catch {}

  state.loading = false
  render()

  // If not logged in, poll the website for auth every 2 seconds
  if (!state.user) startAuthPolling()
}

// ── Auth polling — checks if user signed in on website ────────────────────────

let authPollInterval = null

function startAuthPolling() {
  if (authPollInterval) return
  authPollInterval = setInterval(async () => {
    try {
      const res = await fetch(`${API}/api/extension-auth`, { credentials: 'include' })
      if (!res.ok) return
      const data = await res.json()
      if (data.user) {
        clearInterval(authPollInterval)
        authPollInterval = null
        state.user = data.user
        state.loading = false
        await chrome.storage.local.set({ user: data.user })
        render()
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
      <p>Sign in on the PeerMesh website, then this popup will update automatically.</p>
      <button class="btn-primary" id="openDashboard">OPEN WEBSITE TO SIGN IN</button>
      <div style="margin-top:16px;display:flex;align-items:center;justify-content:center;gap:8px;color:#666680;font-size:11px;font-family:'Courier New',monospace">
        <span style="display:inline-block;width:8px;height:8px;border:2px solid #1e1e2a;border-top-color:#00ff88;border-radius:50%;animation:spin 0.8s linear infinite"></span>
        WAITING FOR SIGN IN...
      </div>
      <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
    </div>`

  document.getElementById('openDashboard').onclick = () => {
    chrome.tabs.create({ url: `${API}/auth?mode=login&source=extension` })
  }
}

function renderDashboard(app) {
  const { session, isSharing, selectedCountry, user } = state

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
      ${state.error ? `<div class="error-msg">${state.error}</div>` : ''}
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
  document.getElementById('disconnectBtn')?.addEventListener('click', disconnectSession)
  document.getElementById('shareToggle')?.addEventListener('change', e => toggleSharing(e.target.checked))
  document.getElementById('signOutBtn')?.addEventListener('click', signOut)
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
        'Authorization': `Bearer ${state.user.token}`,
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
      token: state.user.token,
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
          'Authorization': `Bearer ${state.user?.token}`,
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
  state.isSharing = on
  await chrome.storage.local.set({ isSharing: on })

  await chrome.runtime.sendMessage({
    type: on ? 'START_SHARING' : 'STOP_SHARING',
    country: state.user?.country,
    userId: state.user?.id,
    token: state.user?.token,
  })

  try {
    await fetch(`${API}/api/user/sharing`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.user?.token}`,
      },
      body: JSON.stringify({ isSharing: on }),
    })
  } catch {}
}

async function signOut() {
  await disconnectSession()
  state.user = null
  state.session = null
  state.isSharing = false
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

// ── Listen for auth from website ──────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'AUTH_SUCCESS') {
    state.user = msg.user
    chrome.storage.local.set({ user: msg.user })
    render()
  }
})

init()
