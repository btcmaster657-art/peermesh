// renderer/app.js

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

function getFlagForCountry(code) {
  const flags = { NG:'🇳🇬', GB:'🇬🇧', US:'🇺🇸', KE:'🇰🇪', ZA:'🇿🇦', DE:'🇩🇪', CA:'🇨🇦', AU:'🇦🇺', BR:'🇧🇷', JP:'🇯🇵', RW:'🇷🇼', GH:'🇬🇭' }
  return flags[code] ?? '🌍'
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'))
  document.getElementById(id).classList.add('active')
}

function updateUI(state) {
  const { running, config, stats } = state

  if (!config.userId) {
    showScreen('auth-screen')
    return
  }

  showScreen('main-screen')

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

  const toggle = document.getElementById('share-toggle')
  toggle.className = 'toggle' + (running ? ' on' : '')
  document.getElementById('toggle-desc').textContent = running
    ? 'Sharing active — earning credits'
    : 'Help others browse. Stay free.'

  document.getElementById('stat-requests').textContent = String(stats.requestsHandled)
  document.getElementById('stat-bytes').textContent = formatBytes(stats.bytesServed)
  document.getElementById('user-label').textContent = config.userId ? `ID: ${config.userId}` : ''
}

// ── Poll state every 2s ───────────────────────────────────────────────────────

async function pollState() {
  try {
    const state = await window.peermesh.getState()
    updateUI(state)
    return state
  } catch {}
}

setInterval(pollState, 2000)
pollState()

// ── Poll website auth via main process (no CORS) ──────────────────────────────

let authPollInterval = null

function startAuthPoll() {
  if (authPollInterval) return
  authPollInterval = setInterval(async () => {
    try {
      const state = await window.peermesh.getState()
      if (!state || state.config.userId) {
        clearInterval(authPollInterval)
        authPollInterval = null
        return
      }
      const result = await window.peermesh.checkWebsiteAuth()
      if (result?.user?.token) {
        clearInterval(authPollInterval)
        authPollInterval = null
        await window.peermesh.signIn({
          token: result.user.token,
          userId: result.user.id,
          country: result.user.country || 'RW',
          trust: result.user.trustScore || 50,
        })
        await pollState()
      } else if (result?.error) {
        clearInterval(authPollInterval)
        authPollInterval = null
        const errEl = document.getElementById('auth-error')
        errEl.textContent = result.error
        errEl.style.display = 'block'
        // Allow retry after showing error
        setTimeout(() => { errEl.style.display = 'none'; startAuthPoll() }, 5000)
      }
    } catch {}
  }, 1500)
}

// Start polling immediately and restart whenever auth screen is shown
startAuthPoll()

// ── Event listeners ───────────────────────────────────────────────────────────

document.getElementById('btn-open-browser').addEventListener('click', async () => {
  await window.peermesh.openAuth()
  startAuthPoll()
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
