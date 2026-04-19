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
  const peerBanner = document.getElementById('peer-active-banner')

  // Check if CLI peer is sharing (state.peerRunning set by pollPeerState)
  const peerSharing = !!state.peerRunning

  if (running) {
    dot.className = 'status-dot on'
    dot.style.cssText = ''
    label.textContent = `SHARING — ${config.country}`
    label.style.color = 'var(--accent)'
    country.textContent = getFlagForCountry(config.country)
    statsEl.textContent = `${stats.requestsHandled} requests · ${formatBytes(stats.bytesServed)} served`
    card.className = 'status-card active'
    if (peerBanner) peerBanner.style.display = 'none'
  } else if (peerSharing) {
    dot.className = 'status-dot on'
    dot.style.cssText = ''
    label.textContent = 'CLI IS SHARING'
    label.style.color = 'var(--accent)'
    country.textContent = ''
    const cs = state.peerStats
    statsEl.textContent = cs ? `${cs.requestsHandled ?? 0} requests · ${formatBytes(cs.bytesServed ?? 0)} served` : 'CLI provider running on this machine'
    card.className = 'status-card active'
    if (peerBanner) peerBanner.style.display = 'none'
  } else {
    dot.className = 'status-dot'
    dot.style.cssText = ''
    label.textContent = 'NOT SHARING'
    label.style.color = 'var(--muted)'
    country.textContent = ''
    statsEl.textContent = 'Toggle below to start sharing'
    card.className = 'status-card'
    if (peerBanner) peerBanner.style.display = 'none'
  }

  const toggle = document.getElementById('share-toggle')
  toggle.className = 'toggle' + ((running || peerSharing) ? ' on' : '')
  document.getElementById('toggle-desc').textContent = running
    ? 'Sharing active — earning credits'
    : peerSharing
      ? 'CLI is sharing'
      : config.userId
        ? 'Help others browse. Stay free.'
        : 'Sign in to start sharing.'

  const displayStats = (peerSharing && state.peerStats) ? state.peerStats : stats

  document.getElementById('stat-requests').textContent = String(displayStats.requestsHandled ?? 0)
  document.getElementById('stat-bytes').textContent = formatBytes(displayStats.bytesServed ?? 0)
  document.getElementById('user-label').textContent = config.userId ? `ID: ${config.userId.slice(0, 8)}` : ''
}

// ── Poll state every 2s ───────────────────────────────────────────────────────

async function pollState() {
  try {
    const state = await window.peermesh.getState()
    if (state.version) setVersion(state.version)
    // Also check CLI peer on port 7656
    try {
      const r = await fetch('http://127.0.0.1:7656/native/state', { signal: AbortSignal.timeout(800) })
      if (r.ok) {
        const cli = await r.json()
        state.peerRunning = !!cli.running
        state.peerStats = cli.stats
      } else {
        state.peerRunning = false
      }
    } catch {
      state.peerRunning = false
    }
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
      // Show a brief "getting codes" flash before transitioning
      const codeWaiting = document.getElementById('code-waiting')
      if (codeWaiting) {
        codeWaiting.style.display = 'flex'
        codeWaiting.innerHTML = '<span style="display:inline-block;width:10px;height:10px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin 0.8s linear infinite"></span> SIGNING IN...'
      }
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
        if (codeWaiting) codeWaiting.style.display = 'none'
        return
      }
      // Poll rapidly a few times so the share toggle turns green quickly
      for (let i = 0; i < 5; i++) {
        await new Promise(r => setTimeout(r, 600))
        const s = await pollState()
        if (s && s.running) break
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
      copyBtn.style.display = 'none'
      const txt = document.getElementById('auth-error-text')
      if (txt) txt.textContent = 'Code expired — click below to get a new one.'
      errEl.style.display = 'block'
      document.getElementById('auth-status').textContent = ''
      btn.disabled = false
      btn.textContent = 'GET NEW CODE'
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

  // isSharing = A.running || B.running (set by pollState via updateUI)
  const state = await window.peermesh.getState()
  const isSharing = state.running || !!state.peerRunning

  if (!isSharing) {
    // Turning ON — check disclosure
    let accepted = state.config.hasAcceptedProviderTerms
    if (!accepted) {
      try {
        const result = await window.peermesh.acceptProviderTerms({ checkOnly: true })
        accepted = result?.accepted === true
      } catch {}
    }
    if (!accepted) {
      showDisclosureModal()
      return
    }
  }

  await doToggleSharing(isSharing)
})

function showDisclosureModal() {
  const existing = document.getElementById('pm-disclosure')
  if (existing) return
  const overlay = document.createElement('div')
  overlay.id = 'pm-disclosure'
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.82);display:flex;align-items:center;justify-content:center;z-index:999;padding:16px'
  overlay.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:22px;max-width:320px;width:100%">
      <div style="font-family:'Courier New',monospace;font-size:10px;color:var(--accent);letter-spacing:1px;margin-bottom:10px">BEFORE YOU SHARE</div>
      <div style="font-size:14px;font-weight:600;margin-bottom:14px;line-height:1.3">What sharing your connection means</div>
      <div style="display:flex;gap:10px;margin-bottom:10px;font-size:12px;color:var(--muted);line-height:1.5"><span>🌐</span><span>Your IP address will be used by other PeerMesh users to browse the web.</span></div>
      <div style="display:flex;gap:10px;margin-bottom:10px;font-size:12px;color:var(--muted);line-height:1.5"><span>🔒</span><span>All sessions are logged with signed receipts.</span></div>
      <div style="display:flex;gap:10px;margin-bottom:10px;font-size:12px;color:var(--muted);line-height:1.5"><span>🚫</span><span>Blocked: .onion sites, SMTP/mail, torrents, private IPs.</span></div>
      <div style="display:flex;gap:10px;margin-bottom:10px;font-size:12px;color:var(--muted);line-height:1.5"><span>⚡</span><span>You can stop sharing at any time.</span></div>
      <div style="display:flex;gap:10px;margin-bottom:10px;font-size:12px;color:var(--muted);line-height:1.5"><span>💸</span><span>Sharing earns you free browsing credits.</span></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:16px">
        <button id="pm-disclose-cancel" style="padding:10px;background:none;border:1px solid var(--border);border-radius:8px;color:var(--muted);cursor:pointer;font-family:'Courier New',monospace;font-size:10px">CANCEL</button>
        <button id="pm-disclose-accept" style="padding:10px;background:var(--accent);border:none;border-radius:8px;color:#000;cursor:pointer;font-family:'Courier New',monospace;font-size:10px;font-weight:700">I UNDERSTAND — SHARE</button>
      </div>
    </div>`
  document.body.appendChild(overlay)
  document.getElementById('pm-disclose-cancel').onclick = () => overlay.remove()
  document.getElementById('pm-disclose-accept').onclick = async () => {
    overlay.remove()
    await window.peermesh.acceptProviderTerms()
    await doToggleSharing(false)
  }
}

async function doToggleSharing(isSharing) {
  const toggle = document.getElementById('share-toggle')
  const label = document.getElementById('status-label')
  const dot = document.getElementById('status-dot')
  const card = document.getElementById('status-card')
  const desc = document.getElementById('toggle-desc')

  toggle.classList.add('loading')
  label.textContent = isSharing ? 'STOPPING...' : 'CONNECTING...'
  label.style.color = 'var(--muted)'
  dot.className = 'status-dot'
  dot.style.cssText = 'animation:spin 0.7s linear infinite;background:transparent;border:2px solid var(--border);border-top-color:var(--accent)'
  card.className = 'status-card'
  desc.textContent = 'Please wait...'

  try {
    if (isSharing) {
      // Stop both A(7654) and B(7656)
      await Promise.allSettled([
        fetch('http://127.0.0.1:7654/native/share/stop', { method: 'POST', signal: AbortSignal.timeout(2000) }),
        fetch('http://127.0.0.1:7656/native/share/stop', { method: 'POST', signal: AbortSignal.timeout(2000) }),
      ])
    } else {
      const result = await window.peermesh.toggleSharing()
      if (result && result.error) showMainError(result.error)
    }
  } catch {
    showMainError('Could not toggle sharing — please try again')
  } finally {
    toggle.classList.remove('loading')
    dot.style.cssText = ''
  }
  for (let i = 0; i < 6; i++) {
    await new Promise(r => setTimeout(r, 500))
    const s = await pollState()
    if (s && (!isSharing ? (s.running || s.peerRunning) : (!s.running && !s.peerRunning))) break
  }
  await pollState()
}

document.getElementById('btn-dashboard').addEventListener('click', async () => {
  await window.peermesh.openDashboard()
})

document.getElementById('btn-signout').addEventListener('click', async () => {
  stopDevicePoll()
  deviceFlowActive = false
  resetAuthUI()
  await window.peermesh.signOut()
  await pollState()
  startDeviceFlow()
})

// On load: apply network state then auto-start device flow if not signed in
setOffline(!navigator.onLine)
pollState().then(state => {
  if (!state || !state.config.userId) startDeviceFlow()
})
