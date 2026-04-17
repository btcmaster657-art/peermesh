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

// ── Device flow auth ──────────────────────────────────────────────────────────

let devicePollInterval = null

function stopDevicePoll() {
  if (devicePollInterval) { clearInterval(devicePollInterval); devicePollInterval = null }
}

async function startDeviceFlow() {
  const statusEl = document.getElementById('auth-status')
  const codeEl = document.getElementById('device-code-display')
  const errEl = document.getElementById('auth-error')

  errEl.style.display = 'none'
  codeEl.textContent = ''
  statusEl.textContent = 'Requesting code...'

  const result = await window.peermesh.requestDeviceCode()
  if (result.error) {
    errEl.textContent = result.error
    errEl.style.display = 'block'
    statusEl.textContent = 'Could not connect to server.'
    return
  }

  const { device_code, user_code, verification_uri, interval = 3 } = result

  codeEl.textContent = user_code
  statusEl.textContent = 'Enter this code on the website:'

  // Open browser to activation page with code pre-filled
  await window.peermesh.openAuth(`${verification_uri}?code=${encodeURIComponent(user_code)}`)

  stopDevicePoll()
  devicePollInterval = setInterval(async () => {
    const poll = await window.peermesh.pollDeviceCode(device_code)

    if (poll.status === 'approved' && poll.user) {
      stopDevicePoll()
      await window.peermesh.signIn({
        token: poll.user.token,
        userId: poll.user.id,
        country: poll.user.country || 'RW',
        trust: poll.user.trustScore || 50,
      })
      await pollState()
    } else if (poll.status === 'denied') {
      stopDevicePoll()
      codeEl.textContent = ''
      statusEl.textContent = ''
      errEl.textContent = 'Sign-in was denied.'
      errEl.style.display = 'block'
    } else if (poll.status === 'expired') {
      stopDevicePoll()
      codeEl.textContent = ''
      statusEl.textContent = ''
      errEl.textContent = 'Code expired. Click the button to try again.'
      errEl.style.display = 'block'
    }
  }, interval * 1000)
}

// ── Event listeners ───────────────────────────────────────────────────────────

document.getElementById('btn-open-browser').addEventListener('click', startDeviceFlow)

document.getElementById('share-toggle').addEventListener('click', async () => {
  await window.peermesh.toggleSharing()
  await pollState()
})

document.getElementById('btn-dashboard').addEventListener('click', async () => {
  await window.peermesh.openDashboard()
})

document.getElementById('btn-signout').addEventListener('click', async () => {
  stopDevicePoll()
  await window.peermesh.signOut()
  await pollState()
})

// Auto-start device flow on load if not signed in
pollState().then(state => {
  if (state && !state.config.userId) startDeviceFlow()
})
