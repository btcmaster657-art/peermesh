// renderer/app.js — runs in the Electron renderer process

const API_BASE = 'https://peermesh-beta.vercel.app'

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`
}

function getFlagForCountry(code) {
  const flags = { NG:'🇳🇬', GB:'🇬🇧', US:'🇺🇸', KE:'🇰🇪', ZA:'🇿🇦', DE:'🇩🇪', CA:'🇨🇦', AU:'🇦🇺', BR:'🇧🇷', JP:'🇯🇵', RW:'🇷🇼', GH:'🇬🇭' }
  return flags[code] ?? '🌍'
}

// ── Screen management ─────────────────────────────────────────────────────────

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'))
  document.getElementById(id).classList.add('active')
}

// ── Update UI from state ──────────────────────────────────────────────────────

function updateUI(state) {
  const { running, config, stats } = state

  // Auth check — if no userId, show auth screen
  if (!config.userId) {
    showScreen('auth-screen')
    return
  }

  showScreen('main-screen')

  // Status card
  const dot = document.getElementById('status-dot')
  const label = document.getElementById('status-label')
  const country = document.getElementById('status-country')
  const statsEl = document.getElementById('status-stats')
  const card = document.getElementById('status-card')

  if (running) {
    dot.className = 'status-dot on'
    label.textContent = `SHARING — ${config.country}`
    label.style.color = 'var(--accent)'
    country.textContent = getFlagForCountry(config.country)
    statsEl.textContent = `${stats.requestsHandled} requests · ${formatBytes(stats.bytesServed)} served`
    card.className = 'status-card active'
  } else {
    dot.className = 'status-dot'
    label.textContent = 'NOT SHARING'
    label.style.color = 'var(--muted)'
    country.textContent = ''
    statsEl.textContent = 'Toggle below to start sharing'
    card.className = 'status-card'
  }

  // Toggle
  const toggle = document.getElementById('share-toggle')
  toggle.className = 'toggle' + (running ? ' on' : '')

  const desc = document.getElementById('toggle-desc')
  desc.textContent = running ? 'Sharing active — earning credits' : 'Help others browse. Stay free.'

  // Stats
  document.getElementById('stat-requests').textContent = String(stats.requestsHandled)
  document.getElementById('stat-bytes').textContent = formatBytes(stats.bytesServed)

  // User label
  document.getElementById('user-label').textContent = config.userId ? `ID: ${config.userId}` : ''
}

// ── Poll state every 2s ───────────────────────────────────────────────────────

async function pollState() {
  try {
    const state = await window.peermesh.getState()
    updateUI(state)
  } catch {}
}

setInterval(pollState, 2000)
pollState()

// ── Auth polling — check website for login every 2s ──────────────────────────

async function checkWebsiteAuth() {
  try {
    const res = await fetch(`${API_BASE}/api/extension-auth`, {
      credentials: 'include',
      headers: { 'Accept': 'application/json' },
    })
    if (!res.ok) return
    const data = await res.json()
    if (data.user?.token) {
      await window.peermesh.signIn({
        token: data.user.token,
        userId: data.user.id,
        country: data.user.country || 'RW',
        trust: data.user.trustScore || 50,
      })
      await pollState()
    }
  } catch {}
}

// Poll for auth while on auth screen
setInterval(async () => {
  const state = await window.peermesh.getState().catch(() => null)
  if (state && !state.config.userId) {
    checkWebsiteAuth()
  }
}, 2000)

// ── Event listeners ───────────────────────────────────────────────────────────

document.getElementById('btn-open-browser').addEventListener('click', async () => {
  await window.peermesh.openDashboard()
})

document.getElementById('share-toggle').addEventListener('click', async () => {
  await window.peermesh.toggleSharing()
  await pollState()
})

document.getElementById('btn-dashboard').addEventListener('click', async () => {
  await window.peermesh.openDashboard()
})

document.getElementById('btn-signout').addEventListener('click', async () => {
  await window.peermesh.signOut()
  await pollState()
})
