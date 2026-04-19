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
  shareToggling: false,
  connecting: false,
  disconnecting: false,
  helper: null,
  selectedCountry: null,
  peerCounts: {},
  loading: true,
  error: null,
  extId: null,
  supabaseToken: null,
  isOnline: navigator.onLine,
  showDisclosure: false,
  privateCodeInput: '',
  privateShare: null,
  privateExpiryHours: '24',
  privateShareSaving: false,
  connectionType: 'public', // 'public' | 'private'
}

window.addEventListener('online', () => { state.isOnline = true; render() })
window.addEventListener('offline', () => { state.isOnline = false; render() })

// ── Session expiry ────────────────────────────────────────────────────────────

async function handleExpiredSession() {
  await chrome.runtime.sendMessage({ type: 'DISCONNECT' }).catch(() => {})
  state.user = null
  state.session = null
  state.isSharing = false
  state.helper = null
  state.supabaseToken = null
  await chrome.storage.local.clear()
  // Preserve extId so auth polling can resume
  const extId = state.extId
  await chrome.storage.local.set({ extId })
  render()
  startAuthPolling()
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  const stored = await chrome.storage.local.get(['user', 'session', 'isSharing', 'helper', 'selectedCountry', 'privateCodeInput', 'extId', 'supabaseToken', 'connectionType'])

  if (!stored.extId) {
    stored.extId = crypto.randomUUID()
    await chrome.storage.local.set({ extId: stored.extId })
  }
  state = { ...state, ...stored }

  try {
    const res = await fetch(`${API}/api/peers/available`)
    const data = await res.json()
    data.peers?.forEach(p => { state.peerCounts[p.country] = p.count })
  } catch {}

  if (state.user) {
    // Verify token is still valid before showing the dashboard
    try {
      const res = await fetch(`${API}/api/extension-auth?verify=1&userId=${state.user.id}`, {
        headers: { 'Authorization': `Bearer ${state.user.token}` },
      })
      if (res.status === 401 || res.status === 403) {
        state.loading = false
        render()
        renderLogPanel()
        await initLogPanel()
        await handleExpiredSession()
        return
      }
    } catch {} // offline — allow through with cached credentials
    // Fetch hasAcceptedProviderTerms from DB
    try {
      const res = await fetch(`${API}/api/user/sharing`, {
        headers: { 'Authorization': `Bearer ${state.supabaseToken || state.user.token}` },
      })
      if (res.ok) {
        const data = await res.json()
        state.hasAcceptedProviderTerms = data.has_accepted_provider_terms ?? false
      }
    } catch {}
    await refreshRuntimeStatus()
    await loadPrivateShareState(state.helper?.baseDeviceId ?? null)
    startPeerPolling()
  }

  state.loading = false
  render()
  renderLogPanel()
  await initLogPanel()

  if (!state.user) startAuthPolling()
}

// ── Auth polling ──────────────────────────────────────────────────────────────

let authPollInterval = null
let peerPollInterval = null
let statusPollInterval = null

async function refreshRuntimeStatus() {
  try {
    const status = await chrome.runtime.sendMessage({ type: 'GET_STATUS' })
    if (!status) return
    state.session = status.session || null
    state.helper = status.helper || null
    state.isSharing = !!(state.helper?.available && state.helper?.running)
    await chrome.storage.local.set({
      session: state.session,
      isSharing: state.isSharing,
      helper: state.helper,
    })
  } catch {}
}

function getPrivateShareExpiryPreset(expiresAt) {
  if (!expiresAt) return 'none'
  const hours = Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 3600000))
  if (hours <= 2) return '1'
  if (hours <= 30) return '24'
  if (hours <= 24 * 8) return '168'
  return 'none'
}

async function loadPrivateShareState(baseDeviceId) {
  if (!state.user || !baseDeviceId) {
    state.privateShare = null
    return
  }
  try {
    const res = await fetch(`${API}/api/user/sharing?baseDeviceId=${encodeURIComponent(baseDeviceId)}`, {
      headers: { 'Authorization': `Bearer ${state.supabaseToken || state.user.token}` },
    })
    if (!res.ok) return
    const data = await res.json()
    state.privateShare = data.private_share ?? null
    state.privateExpiryHours = getPrivateShareExpiryPreset(state.privateShare?.expires_at ?? null)
  } catch {}
}

async function savePrivateShareState(input) {
  const baseDeviceId = state.helper?.baseDeviceId
  if (!state.user || !baseDeviceId) {
    state.error = 'A local desktop app or CLI device is required to manage private sharing'
    render()
    return
  }
  state.privateShareSaving = true
  state.error = null
  render()
  try {
    const expiryHours = input.expiryHours === undefined
      ? undefined
      : (input.expiryHours === 'none' ? null : parseInt(input.expiryHours, 10))
    const res = await fetch(`${API}/api/user/sharing`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.supabaseToken || state.user.token}`,
      },
      body: JSON.stringify({
        privateSharing: {
          baseDeviceId,
          enabled: input.enabled,
          refresh: input.refresh === true,
          expiryHours,
        },
      }),
    })
    const data = await res.json()
    if (!res.ok || data.error) throw new Error(data.error || 'Could not update private sharing')
    state.privateShare = data.private_share ?? null
    if (input.expiryHours !== undefined) state.privateExpiryHours = input.expiryHours
  } catch (err) {
    state.error = err.message || 'Could not update private sharing'
  } finally {
    state.privateShareSaving = false
    render()
  }
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
      document.querySelectorAll('.country-btn').forEach(btn => {
        const count = state.peerCounts[btn.dataset.code] ?? 0
        btn.querySelector('.peers').textContent = count > 0 ? count + ' devices' : 'no devices'
        btn.classList.toggle('no-peers', count === 0)
      })
    } catch {}
  }, 30000)

  if (!statusPollInterval) {
    statusPollInterval = setInterval(async () => {
      await refreshRuntimeStatus()
      await loadPrivateShareState(state.helper?.baseDeviceId ?? null)
      const desktopSharing = !!(state.helper?.available && state.helper?.running)
      if (state.isSharing !== desktopSharing) {
        state.isSharing = desktopSharing
        await chrome.storage.local.set({ isSharing: desktopSharing })
      }
      render()
    }, 3000)
  }

  // Poll fresh profile stats from DB every 10s (matches dashboard refresh rate)
  setInterval(async () => {
    if (!state.user || !state.supabaseToken) return
    try {
      const res = await fetch(`${API}/api/user/sharing`, {
        headers: { 'Authorization': `Bearer ${state.supabaseToken}` },
      })
      if (res.status === 401 || res.status === 403) { await handleExpiredSession(); return }
      if (!res.ok) return
      const data = await res.json()
      state.user = {
        ...state.user,
        totalShared: data.total_bytes_shared ?? state.user.totalShared,
        totalUsed: data.total_bytes_used ?? state.user.totalUsed,
        trustScore: data.trust_score ?? state.user.trustScore,
        dailyLimitMb: data.daily_share_limit_mb ?? state.user.dailyLimitMb ?? null,
      }
      if (data.has_accepted_provider_terms === true) state.hasAcceptedProviderTerms = true
      await chrome.storage.local.set({ user: state.user })
      document.querySelectorAll('.stat').forEach(el => {
        const lbl = el.querySelector('.lbl')?.textContent
        const val = el.querySelector('.val')
        if (!val) return
        if (lbl === 'SHARED') val.textContent = formatBytes(state.user.totalShared || 0)
        if (lbl === 'USED') val.textContent = formatBytes(state.user.totalUsed || 0)
        if (lbl === 'TRUST') val.textContent = String(state.user.trustScore || 50)
      })
    } catch {}
  }, 10000)
}

function startAuthPolling() {
  if (authPollInterval) { clearInterval(authPollInterval); authPollInterval = null }
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
        state.hasAcceptedProviderTerms = data.user.hasAcceptedProviderTerms ?? false
        state.loading = false
        await chrome.storage.local.set({ user: data.user, supabaseToken: state.supabaseToken, desktopToken: data.user.token })
        await refreshRuntimeStatus()
        await loadPrivateShareState(state.helper?.baseDeviceId ?? null)
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
  const offlineBanner = !state.isOnline
    ? `<div style="display:flex;align-items:center;gap:8px;background:rgba(255,170,0,0.08);border:1px solid rgba(255,170,0,0.35);border-radius:8px;padding:8px 12px;margin-bottom:12px;font-family:'Courier New',monospace;font-size:10px;color:#ffaa00">⚠ NO INTERNET — sign-in unavailable</div>`
    : ''
  app.innerHTML = `
    <div class="header">
      <span class="logo">PEERMESH</span>
    </div>
    <div class="auth-screen">
      <h2>Welcome</h2>
      <p>Sign in to start browsing.</p>
      ${offlineBanner}
      <div style="margin:20px 0;display:flex;align-items:center;justify-content:center;gap:8px;color:#666680;font-size:11px;font-family:'Courier New',monospace">
        <span style="display:inline-block;width:8px;height:8px;border:2px solid #1e1e2a;border-top-color:#00ff88;border-radius:50%;animation:spin 0.8s linear infinite"></span>
        WAITING FOR SIGN IN...
      </div>
      <button class="btn-primary" id="openDashboard" style="margin-top:4px" ${!state.isOnline ? 'disabled' : ''}>SIGN IN</button>
      <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
    </div>`

  document.getElementById('openDashboard').onclick = () => {
    chrome.tabs.create({ url: `${API}/extension?ext_id=${state.extId}` })
  }
}

function renderDashboard(app) {
  const { session, isSharing, selectedCountry, user, helper } = state
  const helperReady = !!helper?.available
  const helperBaseDeviceId = helper?.baseDeviceId ?? null
  const helperSource = helper?.source === 'cli' ? 'CLI' : 'Desktop'
  const helperLabel = helperReady
    ? (isSharing ? `${helperSource} helper active — full-browser sharing enabled.` : `${helperSource} helper detected — ready to share.`)
    : 'Desktop app or CLI required for full-browser sharing.'

  const offlineBanner = !state.isOnline
    ? `<div style="display:flex;align-items:center;gap:8px;background:rgba(255,170,0,0.08);border:1px solid rgba(255,170,0,0.35);border-radius:8px;padding:8px 12px;margin:0 16px 8px;font-family:'Courier New',monospace;font-size:10px;color:#ffaa00">⚠ NO INTERNET — features unavailable</div>`
    : ''
  const errorBanner = state.error
    ? `<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:6px;background:rgba(255,68,102,0.08);border:1px solid rgba(255,68,102,0.25);border-radius:8px;padding:8px 12px;margin:0 16px 8px;font-size:11px;color:#ff6060;line-height:1.5">
        <span>${state.error}</span>
        <button id="dismissErrorBtn" style="background:none;border:none;color:#666680;cursor:pointer;font-size:13px;line-height:1;padding:0;flex-shrink:0">✕</button>
       </div>`
    : ''

  app.innerHTML = `
    <div class="header">
      <span class="logo">PEERMESH</span>
      <div class="status-pill ${session ? 'connected' : ''}">
        <div class="status-dot"></div>
        ${session ? `VIA ${session.country}` : 'DISCONNECTED'}
      </div>
    </div>
    ${offlineBanner}
    ${errorBanner}

    ${session ? `
    <div class="section">
      <div class="session-card">
        <div class="via">Browsing via peer</div>
        <div class="country-display">${getFlagForCountry(session.country)} ${session.country}</div>
        <div style="margin-top:6px;display:inline-block;font-family:'Courier New',monospace;font-size:9px;padding:2px 7px;border-radius:4px;background:${state.connectionType === 'private' ? 'rgba(0,255,136,0.12)' : 'rgba(255,255,255,0.05)'};border:1px solid ${state.connectionType === 'private' ? 'rgba(0,255,136,0.35)' : '#1e1e2a'};color:${state.connectionType === 'private' ? '#00ff88' : '#666680'}">${state.connectionType === 'private' ? '\uD83D\uDD12 PRIVATE' : '\uD83C\uDF10 PUBLIC'}</div>
      </div>
      <button class="connect-btn disconnect" id="disconnectBtn" ${state.disconnecting ? 'disabled' : ''}>
        ${state.disconnecting
          ? `<span style="display:inline-flex;align-items:center;gap:8px"><span style="width:10px;height:10px;border:2px solid rgba(255,68,102,0.3);border-top-color:#ff4466;border-radius:50%;animation:spin 0.7s linear infinite;display:inline-block"></span>DISCONNECTING...</span>`
          : 'DISCONNECT'}
      </button>
    </div>
    ` : `
    <div class="section">
      <div class="section-label">Browse as...</div>
      <div class="country-grid" id="countryGrid" style="${state.connecting ? 'pointer-events:none;opacity:0.5' : ''}">
        ${COUNTRIES.map(c => {
          const count = state.peerCounts[c.code] ?? 0
          return `
          <button class="country-btn ${selectedCountry === c.code ? 'selected' : ''} ${count === 0 ? 'no-peers' : ''}"
                  data-code="${c.code}">
            <span class="flag">${c.flag}</span>
            <span class="name">${c.name}</span>
            <span class="peers">${count > 0 ? count + ' devices' : 'no devices'}</span>
          </button>`
        }).join('')}
      </div>
    </div>
    <div class="section">
      <div class="section-label">Private code</div>
      <div style="display:grid;grid-template-columns:1fr auto;gap:8px">
        <input id="privateCodeInput" value="${state.privateCodeInput || ''}" placeholder="9-digit code" inputmode="numeric" maxlength="9" style="padding:10px 12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);font-family:'Courier New',monospace;font-size:11px;letter-spacing:1px" />
        <button class="connect-btn" id="connectPrivateBtn" style="padding:0 12px" ${!state.privateCodeInput || !state.isOnline || state.connecting ? 'disabled' : ''}>
          ${state.connecting && state.privateCodeInput ? '...' : 'CODE'}
        </button>
      </div>
      <div style="margin-top:6px;font-size:10px;color:var(--muted);line-height:1.5">Locks the session to one known device and its active slots only.</div>
    </div>
    <div class="section">
      <button class="connect-btn" id="connectBtn" ${!selectedCountry || !state.isOnline || state.connecting ? 'disabled' : ''}>
        ${state.connecting
          ? `<span style="display:inline-flex;align-items:center;gap:8px"><span style="width:10px;height:10px;border:2px solid rgba(0,0,0,0.2);border-top-color:#000;border-radius:50%;animation:spin 0.7s linear infinite;display:inline-block"></span>CONNECTING...</span>`
          : !state.isOnline ? 'NO INTERNET'
          : selectedCountry ? `CONNECT ${getFlagForCountry(selectedCountry)} ${selectedCountry}`
          : 'SELECT A COUNTRY'}
      </button>
      ${state.error && !state.session ? `
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:6px;margin-top:8px;padding:8px 10px;background:rgba(255,68,102,0.08);border:1px solid rgba(255,68,102,0.25);border-radius:8px;font-size:11px;color:#ff6060;line-height:1.5">
          <span>${state.error}</span>
          <button id="retryConnectBtn" style="background:none;border:none;color:#00ff88;font-family:'Courier New',monospace;font-size:10px;cursor:pointer;white-space:nowrap;padding:0;flex-shrink:0">RETRY</button>
        </div>` : ''}
    </div>
    `}

    <div class="section">
      <div class="share-row">
        <div class="share-info">
          <h4>Share my connection</h4>
          <p>${isSharing ? 'Sharing active — earning credits' : helperLabel}</p>
          ${isSharing ? `<div style="margin-top:4px;display:inline-block;font-family:'Courier New',monospace;font-size:9px;padding:2px 7px;border-radius:4px;background:${state.privateShare?.active ? 'rgba(0,255,136,0.12)' : 'rgba(255,255,255,0.05)'};border:1px solid ${state.privateShare?.active ? 'rgba(0,255,136,0.35)' : '#1e1e2a'};color:${state.privateShare?.active ? '#00ff88' : '#666680'}">${state.privateShare?.active ? '\uD83D\uDD12 PRIVATE' : '\uD83C\uDF10 PUBLIC'}</div>` : ''}
          ${state.user?.dailyLimitMb ? `<p style="font-size:10px;color:var(--muted);margin-top:2px">${formatBytes((state.user.dailyLimitMb ?? 0) * 1024 * 1024)} daily limit</p>` : ''}
          ${helper?.slots ? `<p style="font-size:10px;color:var(--muted);margin-top:4px">${helper.slots.active} / ${helper.slots.configured} slots active${helper.slots.warning ? ` - ${helper.slots.warning}` : ''}</p>` : ''}
        </div>
        ${state.shareToggling
          ? `<div style="width:44px;height:24px;border-radius:12px;background:var(--border);display:flex;align-items:center;justify-content:center;flex-shrink:0">
               <span style="width:10px;height:10px;border:2px solid rgba(255,255,255,0.2);border-top-color:#00ff88;border-radius:50%;animation:spin 0.7s linear infinite;display:inline-block"></span>
             </div>`
          : `<label class="toggle">
               <input type="checkbox" id="shareToggle" ${isSharing ? 'checked' : ''} ${!helperReady || !state.isOnline ? 'disabled style="opacity:0.4;cursor:not-allowed"' : ''}>
               <span class="toggle-slider"></span>
             </label>`
        }
      </div>
    </div>

    ${helperBaseDeviceId ? `
    <div class="section">
      <div class="share-info" style="margin-bottom:10px">
        <h4>Private sharing</h4>
        <p>${state.privateShare?.active ? 'Pinned to this device and all active slots.' : 'Optional device-scoped code for trusted requesters.'}</p>
      </div>
      <div style="display:grid;grid-template-columns:1fr auto;gap:8px;margin-bottom:8px">
        <div style="padding:10px 12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;font-family:'Courier New',monospace;font-size:13px;letter-spacing:2px;color:${state.privateShare?.code ? 'var(--accent)' : 'var(--muted)'}">${state.privateShare?.code || 'CODE OFF'}</div>
        <button id="copyPrivateCodeBtn" style="padding:0 10px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);font-family:'Courier New',monospace;font-size:10px;cursor:${state.privateShare?.code ? 'pointer' : 'not-allowed'}" ${!state.privateShare?.code ? 'disabled' : ''}>COPY</button>
      </div>
      <div style="display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap">
        <select id="privateExpirySelect" style="background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 8px;font-family:'Courier New',monospace;font-size:10px;cursor:pointer">
          <option value="none" ${state.privateExpiryHours === 'none' ? 'selected' : ''}>No expiry</option>
          <option value="1" ${state.privateExpiryHours === '1' ? 'selected' : ''}>1 hour</option>
          <option value="24" ${state.privateExpiryHours === '24' ? 'selected' : ''}>24 hours</option>
          <option value="168" ${state.privateExpiryHours === '168' ? 'selected' : ''}>7 days</option>
        </select>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button id="togglePrivateShareBtn" style="padding:7px 10px;background:${state.privateShare?.enabled ? 'transparent' : 'var(--accent)'};border:1px solid ${state.privateShare?.enabled ? 'var(--border)' : 'var(--accent)'};border-radius:7px;color:${state.privateShare?.enabled ? 'var(--text)' : '#000'};font-family:'Courier New',monospace;font-size:10px;cursor:${state.privateShareSaving ? 'not-allowed' : 'pointer'}" ${state.privateShareSaving ? 'disabled' : ''}>${state.privateShare?.enabled ? 'DISABLE' : 'ENABLE'}</button>
          <button id="refreshPrivateShareBtn" style="padding:7px 10px;background:transparent;border:1px solid var(--border);border-radius:7px;color:var(--text);font-family:'Courier New',monospace;font-size:10px;cursor:${state.privateShareSaving ? 'not-allowed' : 'pointer'}" ${state.privateShareSaving ? 'disabled' : ''}>REFRESH</button>
        </div>
      </div>
      ${state.privateShare?.expires_at ? `<div style="margin-top:8px;font-size:10px;color:var(--muted)">Expires ${new Date(state.privateShare.expires_at).toLocaleString()}</div>` : ''}
    </div>` : ''}

    <div class="stats">
      <div class="stat">
        <span class="val">${isSharing && state.helper?.stats?.bytesServed > 0 ? formatBytes(state.helper.stats.bytesServed) : formatBytes(user.totalShared || 0)}</span>
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

  if (!helperReady) {
    const shareSection = app.querySelector('.share-info')?.closest('.section')
    if (shareSection) {
      const helperNotice = document.createElement('div')
      helperNotice.style.cssText = 'font-size:11px;color:#ff6060;padding:6px 0 2px'
      helperNotice.innerHTML = 'No helper detected. <a id="installHelperBtn" href="#" style="color:#00ff88;font-family:\'Courier New\',monospace;font-size:11px;text-decoration:underline">INSTALL DESKTOP</a> or run <code style="font-family:\'Courier New\',monospace;font-size:10px;color:#00ff88">npx peermesh-provider</code>'
      shareSection.appendChild(helperNotice)
    }
    const toggle = document.getElementById('shareToggle')
    if (toggle) { toggle.disabled = true; toggle.style.opacity = '0.4'; toggle.style.cursor = 'not-allowed' }
  }

  document.getElementById('dismissErrorBtn')?.addEventListener('click', () => { state.error = null; render() })
  document.getElementById('retryConnectBtn')?.addEventListener('click', () => { state.error = null; connectSession() })
  document.querySelectorAll('.country-btn').forEach(btn => {
    btn.onclick = () => {
      state.selectedCountry = btn.dataset.code
      state.privateCodeInput = ''
      state.error = null
      chrome.storage.local.set({ selectedCountry: state.selectedCountry, privateCodeInput: '' })
      render()
    }
  })

  document.getElementById('privateCodeInput')?.addEventListener('input', (e) => {
    state.privateCodeInput = e.target.value.replace(/\D/g, '').slice(0, 9)
    state.error = null
    chrome.storage.local.set({ privateCodeInput: state.privateCodeInput })
    render()
  })
  document.getElementById('connectBtn')?.addEventListener('click', connectSession)
  document.getElementById('connectPrivateBtn')?.addEventListener('click', connectSession)
  document.getElementById('disconnectBtn')?.addEventListener('click', disconnectSession)
  document.getElementById('shareToggle')?.addEventListener('change', e => toggleSharing(e.target.checked))
  document.getElementById('signOutBtn')?.addEventListener('click', signOut)
  document.getElementById('installHelperBtn')?.addEventListener('click', (e) => {
    e.preventDefault()
    chrome.tabs.create({ url: `${API}/api/desktop-download` })
  })
  document.getElementById('copyPrivateCodeBtn')?.addEventListener('click', () => {
    if (state.privateShare?.code) navigator.clipboard.writeText(state.privateShare.code).catch(() => {})
  })
  document.getElementById('privateExpirySelect')?.addEventListener('change', (e) => {
    state.privateExpiryHours = e.target.value
  })
  document.getElementById('togglePrivateShareBtn')?.addEventListener('click', () => {
    savePrivateShareState({ enabled: !(state.privateShare?.enabled ?? false), expiryHours: state.privateExpiryHours })
  })
  document.getElementById('refreshPrivateShareBtn')?.addEventListener('click', () => {
    savePrivateShareState({ enabled: true, refresh: true, expiryHours: state.privateExpiryHours })
  })

  // Disclosure modal
  if (state.showDisclosure) {
    const overlay = document.createElement('div')
    overlay.id = 'pm-disclosure'
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.82);display:flex;align-items:center;justify-content:center;z-index:999;padding:16px'
    overlay.innerHTML = `
      <div style="background:#13131a;border:1px solid #1e1e2a;border-radius:14px;padding:22px;max-width:320px;width:100%">
        <div style="font-family:'Courier New',monospace;font-size:10px;color:#00ff88;letter-spacing:1px;margin-bottom:10px">BEFORE YOU SHARE</div>
        <div style="font-size:14px;font-weight:600;margin-bottom:14px;line-height:1.3">What sharing your connection means</div>
        ${[
          ['🌐', 'Your IP address will be used by other PeerMesh users to browse the web.'],
          ['🔒', 'All sessions are logged with signed receipts.'],
          ['🚫', 'Blocked: .onion sites, SMTP/mail, torrents, private IPs.'],
          ['⚡', 'You can stop sharing at any time.'],
          ['💸', 'Sharing earns you free browsing credits.'],
        ].map(([icon, text]) => `
          <div style="display:flex;gap:10px;margin-bottom:10px;font-size:12px;color:#666680;line-height:1.5">
            <span style="flex-shrink:0">${icon}</span><span>${text}</span>
          </div>`).join('')}
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:16px">
          <button id="pm-disclose-cancel" style="padding:10px;background:none;border:1px solid #1e1e2a;border-radius:8px;color:#666680;cursor:pointer;font-family:'Courier New',monospace;font-size:10px">CANCEL</button>
          <button id="pm-disclose-accept" style="padding:10px;background:#00ff88;border:none;border-radius:8px;color:#000;cursor:pointer;font-family:'Courier New',monospace;font-size:10px;font-weight:700">I UNDERSTAND — SHARE</button>
        </div>
      </div>`
    document.body.appendChild(overlay)
    document.getElementById('pm-disclose-cancel').onclick = () => {
      state.showDisclosure = false
      // Uncheck the toggle visually
      const toggle = document.getElementById('shareToggle')
      if (toggle) toggle.checked = false
      overlay.remove()
    }
    document.getElementById('pm-disclose-accept').onclick = async () => {
      state.showDisclosure = false
      state.hasAcceptedProviderTerms = true
      try {
        await fetch(`${API}/api/user/sharing`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.supabaseToken || state.user?.token}` },
          body: JSON.stringify({ acceptProviderTerms: true }),
        })
      } catch {}
      overlay.remove()
      toggleSharing(true)
    }
  }
}

// ── Actions ───────────────────────────────────────────────────────────────────

async function connectSession() {
  const privateCode = (state.privateCodeInput || '').trim()
  // Country selected = public mode; clear any stale private code
  if (state.selectedCountry && privateCode) {
    state.privateCodeInput = ''
    chrome.storage.local.set({ privateCodeInput: '' })
  }
  const isPrivateConnect = !state.selectedCountry && !!privateCode
  if ((!state.selectedCountry && !privateCode) || !state.user || state.connecting) return

  if (!state.isOnline) {
    state.error = 'No internet connection — check your network and try again'
    render()
    return
  }

  state.connecting = true
  state.error = null
  render()

  try {
    const res = await fetch(`${API}/api/session/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.supabaseToken || state.user.token}`,
      },
      body: JSON.stringify(isPrivateConnect ? { privateCode } : { country: state.selectedCountry }),
    })

    const data = await res.json()
    if (res.status === 401 || res.status === 403) { state.connecting = false; await handleExpiredSession(); return }
    if (!res.ok || data.error) throw new Error(data.error ?? `Server error (${res.status})`)

    const response = await chrome.runtime.sendMessage({
      type: 'CONNECT',
      relayEndpoint: data.relayEndpoint,
      country: data.country ?? state.selectedCountry,
      userId: state.user.id,
      dbSessionId: data.sessionId,
      preferredProviderUserId: data.preferredProviderUserId ?? null,
      privateProviderUserId: data.privateProviderUserId ?? null,
      privateBaseDeviceId: data.privateBaseDeviceId ?? null,
      token: state.supabaseToken || state.user.token,
    })

    if (!response?.success) throw new Error(response?.error || 'Connection failed')

    state.session = { id: data.sessionId, country: data.country ?? state.selectedCountry, relayEndpoint: data.relayEndpoint }
    state.connectionType = isPrivateConnect ? 'private' : 'public'
    await chrome.storage.local.set({ session: state.session, connectionType: state.connectionType })
  } catch (err) {
    state.error = err.message === 'Failed to fetch' ? 'Network error — could not reach server' : err.message
  } finally {
    state.connecting = false
    render()
  }
}

async function disconnectSession() {
  if (state.disconnecting) return
  state.disconnecting = true
  render()

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
  state.connectionType = 'public'
  state.disconnecting = false
  await chrome.storage.local.set({ session: null, connectionType: 'public' })
  render()
}

async function toggleSharing(on) {
  if (state.shareToggling) return

  // First-time share — show disclosure modal
  if (on && !state.hasAcceptedProviderTerms) {
    state.showDisclosure = true
    render()
    return
  }

  state.shareToggling = true
  render()

  if (on && !state.isOnline) {
    state.error = 'No internet connection — sharing requires an active network'
    state.shareToggling = false
    render()
    return
  }

  if (on && !state.helper?.available) {
    await refreshRuntimeStatus()
    if (!state.helper?.available) {
      state.error = 'No helper detected — <a href="#" id="dlHelperLink" style="color:#00ff88">install desktop</a> or run <code style="font-family:\'Courier New\',monospace;font-size:10px">npx peermesh-provider</code>'
      state.shareToggling = false
      render()
      document.getElementById('dlHelperLink')?.addEventListener('click', e => {
        e.preventDefault()
        chrome.tabs.create({ url: `${API}/api/desktop-download` })
      })
      return
    }
  }

  const previous = state.isSharing
  state.isSharing = on
  render()

  const response = await chrome.runtime.sendMessage({
    type: on ? 'START_SHARING' : 'STOP_SHARING',
    country: state.user?.country_code || state.user?.country,
    userId: state.user?.id,
    token: state.supabaseToken || state.user?.token,
    supabaseToken: state.supabaseToken,
    desktopToken: state.user?.token,
    trust: state.user?.trustScore || state.user?.trust_score || 50,
  })

  if (!response?.success) {
    state.isSharing = previous
    state.helper = response?.helper || state.helper
    state.shareToggling = false
    state.error = response?.error === 'Failed to fetch'
      ? 'Network error — could not reach desktop helper'
      : (response?.error || 'Desktop helper is required')
    render()
    return
  }

  state.error = null
  state.isSharing = on
  state.shareToggling = false
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
  // Preserve extId so auth polling can resume
  await chrome.storage.local.set({ extId: state.extId })
  render()
  startAuthPolling()
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

// ── Debug log panel ───────────────────────────────────────────────────────────

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
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_LOGS' })
    if (res?.logs) res.logs.forEach(appendLog)
  } catch {}
}

// ── Message listener ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'LOG') appendLog(msg.entry)

  if (msg.type === 'AUTH_SUCCESS') {
    state.user = msg.user
    chrome.storage.local.set({ user: msg.user })
    render()
  }

  // Relay found a new provider transparently — update sessionId, no UI disruption
  if (msg.type === 'SESSION_RECONNECTED') {
    if (state.session) {
      state.session = { ...state.session, id: msg.sessionId }
      chrome.storage.local.set({ session: state.session })
    }
    // Brief visual pulse on the status pill so user knows a switch happened
    const pill = document.querySelector('.status-pill')
    if (pill) {
      pill.style.opacity = '0.4'
      setTimeout(() => { pill.style.opacity = '1' }, 600)
    }
  }

  // Provider dropped and relay gave up finding a replacement
  if (msg.type === 'SESSION_ENDED') {
    state.session = null
    state.error = 'Connection lost — your peer disconnected. Select a country to reconnect.'
    chrome.storage.local.set({ session: null })
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

init()
