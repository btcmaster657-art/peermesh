// renderer/app.js

function setVersion(v) {
  if (!v) return
  document.getElementById('version-tag').textContent = `v${v}`
}

setVersion(window.peermesh.version)

// ── Network status ────────────────────────────────────────────────────────────

function setOffline(isOffline) {
  const authBanner = document.getElementById('offline-banner')
  const mainBanner = document.getElementById('main-offline-banner')
  const display = isOffline ? 'flex' : 'none'
  if (authBanner) authBanner.style.display = display
  if (mainBanner) mainBanner.style.display = display
  const btn = document.getElementById('btn-open-browser')
  if (btn && document.getElementById('auth-screen').classList.contains('active')) {
    btn.disabled = isOffline
    if (isOffline) btn.textContent = 'NO INTERNET'
  }
}

window.addEventListener('online', () => setOffline(false))
window.addEventListener('offline', () => setOffline(true))
setOffline(!navigator.onLine)

function showMainError(msg) {
  const el = document.getElementById('main-error')
  const txt = document.getElementById('main-error-text')
  if (!el || !txt) return
  txt.textContent = msg
  el.style.display = 'block'
}

function clearMainError() {
  const el = document.getElementById('main-error')
  if (el) el.style.display = 'none'
}

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
  // Re-apply offline state whenever screen changes
  setOffline(!navigator.onLine)
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
    : config.userId
      ? 'Help others browse. Stay free.'
      : 'Sign in to start sharing.'

  document.getElementById('stat-requests').textContent = String(stats.requestsHandled)
  document.getElementById('stat-bytes').textContent = formatBytes(stats.bytesServed)
  document.getElementById('user-label').textContent = config.userId ? `ID: ${config.userId.slice(0, 8)}` : ''
}

// ── Poll state every 2s ───────────────────────────────────────────────────────

async function pollState() {
  try {
    const state = await window.peermesh.getState()
    if (state.version) setVersion(state.version)
    // Desktop IPC is always authoritative
    updateUI(state)
    return state
  } catch {}
}

setInterval(pollState, 2000)

// ── Device flow auth ──────────────────────────────────────────────────────────

let devicePollInterval = null
let deviceFlowActive = false

function stopDevicePoll() {
  if (devicePollInterval) { clearInterval(devicePollInterval); devicePollInterval = null }
  deviceFlowActive = false
}

function resetAuthUI() {
  const codeEl = document.getElementById('device-code-display')
  const codeHint = document.getElementById('code-hint')
  const codeWaiting = document.getElementById('code-waiting')
  const errEl = document.getElementById('auth-error')
  const btn = document.getElementById('btn-open-browser')
  const copyBtn = document.getElementById('btn-copy-code')
  const statusEl = document.getElementById('auth-status')
  codeEl.style.display = 'none'
  codeEl.textContent = ''
  codeHint.style.display = 'none'
  codeWaiting.style.display = 'flex'
  copyBtn.style.display = 'none'
  errEl.style.display = 'none'
  statusEl.innerHTML = '<span style="display:inline-block;width:8px;height:8px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin 0.8s linear infinite"></span> WAITING FOR SIGN IN...'
  btn.disabled = !navigator.onLine
  btn.textContent = navigator.onLine ? 'SIGN IN WITH BROWSER' : 'NO INTERNET'
}

async function startDeviceFlow() {
  if (deviceFlowActive) return
  deviceFlowActive = true

  const codeEl = document.getElementById('device-code-display')
  const codeHint = document.getElementById('code-hint')
  const codeWaiting = document.getElementById('code-waiting')
  const errEl = document.getElementById('auth-error')
  const btn = document.getElementById('btn-open-browser')
  const copyBtn = document.getElementById('btn-copy-code')

  errEl.style.display = 'none'
  codeEl.style.display = 'none'
  codeEl.textContent = ''
  codeHint.style.display = 'none'
  codeWaiting.style.display = 'flex'
  btn.disabled = true
  btn.textContent = 'OPENING BROWSER...'

  if (!navigator.onLine) {
    const txt = document.getElementById('auth-error-text')
    if (txt) txt.textContent = 'No internet connection — check your network and try again'
    errEl.style.display = 'block'
    codeWaiting.style.display = 'none'
    btn.disabled = true
    btn.textContent = 'NO INTERNET'
    deviceFlowActive = false
    return
  }

  const result = await window.peermesh.requestDeviceCode()
  if (result.error) {
    const txt = document.getElementById('auth-error-text')
    if (txt) txt.textContent = result.error === 'Could not reach server'
      ? 'Could not reach server — check your internet connection'
      : result.error
    errEl.style.display = 'block'
    codeWaiting.style.display = 'none'
    btn.disabled = false
    btn.textContent = 'TRY AGAIN'
    deviceFlowActive = false
    return
  }

  const { device_code, user_code, verification_uri, interval = 3 } = result

  codeWaiting.style.display = 'none'
  codeEl.textContent = user_code
  codeEl.style.display = 'block'
  codeHint.style.display = 'block'
  copyBtn.style.display = 'inline-block'
  copyBtn.onclick = () => {
    navigator.clipboard.writeText(user_code).then(() => {
      copyBtn.textContent = 'COPIED!'
      copyBtn.style.color = 'var(--accent)'
      copyBtn.style.borderColor = 'var(--accent)'
      setTimeout(() => { copyBtn.textContent = 'COPY CODE'; copyBtn.style.color = ''; copyBtn.style.borderColor = '' }, 2000)
    })
  }
  btn.disabled = false
  btn.textContent = 'OPEN BROWSER AGAIN'

  // open-auth now shows a dialog: Open Browser or Copy Link
  await window.peermesh.openAuth(`${verification_uri}?activate=1&code=${encodeURIComponent(user_code)}`)

  stopDevicePoll()
  deviceFlowActive = true
  devicePollInterval = setInterval(async () => {
    const poll = await window.peermesh.pollDeviceCode(device_code)

    if (poll.status === 'approved' && poll.user) {
      stopDevicePoll()
      resetAuthUI()
      const res = await window.peermesh.signIn({
        token: poll.user.token,
        userId: poll.user.id,
        country: poll.user.country || 'RW',
        trust: poll.user.trustScore || 50,
      })
      if (res && res.success === false) {
        const txt = document.getElementById('auth-error-text')
        if (txt) txt.textContent = res.error || 'Sign-in failed — please try again'
        document.getElementById('auth-error').style.display = 'block'
        document.getElementById('btn-open-browser').disabled = false
        document.getElementById('btn-open-browser').textContent = 'SIGN IN WITH BROWSER'
        return
      }
      await pollState()
    } else if (poll.status === 'denied') {
      stopDevicePoll()
      codeEl.style.display = 'none'
      codeHint.style.display = 'none'
      const txt = document.getElementById('auth-error-text')
      if (txt) txt.textContent = 'Sign-in was denied. Click below to try again.'
      errEl.style.display = 'block'
      btn.disabled = false
      btn.textContent = 'SIGN IN WITH BROWSER'
    } else if (poll.status === 'expired') {
      stopDevicePoll()
      codeEl.style.display = 'none'
      codeHint.style.display = 'none'
      const txt = document.getElementById('auth-error-text')
      if (txt) txt.textContent = 'Code expired — click below to get a new one.'
      errEl.style.display = 'block'
      btn.disabled = false
      btn.textContent = 'SIGN IN WITH BROWSER'
    }
  }, interval * 1000)
}

// ── Event listeners ───────────────────────────────────────────────────────────

document.getElementById('btn-open-browser').addEventListener('click', () => {
  stopDevicePoll()
  deviceFlowActive = false
  startDeviceFlow()
})

document.getElementById('share-toggle').addEventListener('click', async () => {
  if (!navigator.onLine) {
    showMainError('No internet connection — sharing requires an active network')
    return
  }
  clearMainError()
  const toggle = document.getElementById('share-toggle')
  toggle.style.opacity = '0.5'
  toggle.style.pointerEvents = 'none'
  try {
    const result = await window.peermesh.toggleSharing()
    if (result && result.error) showMainError(result.error)
  } catch {
    showMainError('Could not toggle sharing — please try again')
  } finally {
    toggle.style.opacity = ''
    toggle.style.pointerEvents = ''
  }
  await pollState()
})

document.getElementById('btn-dashboard').addEventListener('click', async () => {
  await window.peermesh.openDashboard()
})

document.getElementById('btn-signout').addEventListener('click', async () => {
  stopDevicePoll()
  resetAuthUI()
  await window.peermesh.signOut()
  await pollState()
})

// On load: apply network state then auto-start device flow if not signed in
setOffline(!navigator.onLine)
pollState().then(state => {
  if (!state || !state.config.userId) startDeviceFlow()
})
