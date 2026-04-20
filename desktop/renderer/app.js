const api = window.peermesh || {}

const startupBusy = {
  launchOnStartup: false,
  autoShareOnLaunch: false,
}

let devicePollInterval = null
let deviceFlowActive = false
let togglingShare = false
let privateShare = null
let privateShareSaving = false
let privateShareExpiry = '24'
let lastPrivateShareLoadAt = 0
const PRIVATE_SHARE_REFRESH_TTL = 2500

function invoke(name, ...args) {
  const fn = api[name]
  if (typeof fn !== 'function') return Promise.resolve(null)
  return fn(...args)
}

function setVersion(version) {
  if (!version) return
  const tag = document.getElementById('version-tag')
  if (tag) tag.textContent = `v${version}`
}

setVersion(api.version)

function setToggleVisual(element, { on = false, loading = false, disabled = false } = {}) {
  if (!element) return
  const classes = ['toggle']
  if (on) classes.push('on')
  if (loading) classes.push('loading')
  element.className = classes.join(' ')
  element.disabled = disabled || loading
}

function setOffline(isOffline) {
  const authBanner = document.getElementById('offline-banner')
  const mainBanner = document.getElementById('main-offline-banner')
  const display = isOffline ? 'flex' : 'none'
  if (authBanner) authBanner.style.display = display
  if (mainBanner) mainBanner.style.display = display
  const btn = document.getElementById('btn-open-browser')
  if (btn && document.getElementById('auth-screen').classList.contains('active')) {
    btn.disabled = isOffline
    btn.textContent = isOffline ? 'NO INTERNET' : 'SIGN IN WITH BROWSER'
  }
}

window.addEventListener('online', () => setOffline(false))
window.addEventListener('offline', () => setOffline(true))

function showMainError(message) {
  const el = document.getElementById('main-error')
  const text = document.getElementById('main-error-text')
  if (!el || !text) return
  text.textContent = message
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
  const flags = {
    NG: '🇳🇬',
    GB: '🇬🇧',
    US: '🇺🇸',
    KE: '🇰🇪',
    ZA: '🇿🇦',
    DE: '🇩🇪',
    CA: '🇨🇦',
    AU: '🇦🇺',
    BR: '🇧🇷',
    JP: '🇯🇵',
    RW: '🇷🇼',
    GH: '🇬🇭',
  }
  return flags[code] ?? '🌍'
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach((screen) => screen.classList.remove('active'))
  const active = document.getElementById(id)
  if (active) active.classList.add('active')
  setOffline(!navigator.onLine)
}

function getPrivateShareExpiryPreset(expiresAt) {
  if (!expiresAt) return 'none'
  const hours = Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 3600000))
  if (hours <= 2) return '1'
  if (hours <= 30) return '24'
  if (hours <= 24 * 8) return '168'
  return 'none'
}

function renderPrivateShare() {
  const codeEl = document.getElementById('private-share-code')
  const copyBtn = document.getElementById('copy-private-share')
  const refreshBtn = document.getElementById('refresh-private-share')
  const toggleBtn = document.getElementById('toggle-private-share')
  const expiryEl = document.getElementById('private-share-expiry')
  const statusEl = document.getElementById('private-share-status')
  const state = window.__lastPeerMeshState || null
  const signedIn = !!state?.config?.userId

  if (codeEl) codeEl.textContent = privateShare?.code ?? '---------'
  if (expiryEl) expiryEl.value = privateShareExpiry

  if (copyBtn) copyBtn.disabled = !signedIn || !privateShare?.code || privateShareSaving
  if (refreshBtn) refreshBtn.disabled = !signedIn || privateShareSaving
  if (toggleBtn) {
    toggleBtn.disabled = !signedIn || privateShareSaving
    toggleBtn.textContent = privateShareSaving
      ? 'SAVING...'
      : ((privateShare?.enabled ?? false) ? 'DISABLE PRIVATE' : 'ENABLE PRIVATE')
  }

  if (!statusEl) return
  if (!signedIn) {
    statusEl.textContent = 'Sign in to manage private sharing.'
    return
  }
  if (privateShareSaving) {
    statusEl.textContent = 'Updating private sharing...'
    return
  }

  const mode = (privateShare?.enabled ?? false)
    ? (privateShare?.active ? 'ACTIVE' : 'ENABLED - waiting for expiry refresh')
    : 'DISABLED'
  const expires = privateShare?.expires_at
    ? ` Expires ${new Date(privateShare.expires_at).toLocaleString()}.`
    : ' No expiry.'

  statusEl.textContent = `This desktop is ${mode}.${expires}`
}

async function loadPrivateShare(force = false) {
  const now = Date.now()
  if (!force && now - lastPrivateShareLoadAt < PRIVATE_SHARE_REFRESH_TTL) return
  lastPrivateShareLoadAt = now
  const result = await invoke('getPrivateShare')
  if (!result?.success) return
  privateShare = result.privateShare ?? null
  privateShareExpiry = result.expiryPreset ?? getPrivateShareExpiryPreset(privateShare?.expires_at ?? null)
  renderPrivateShare()
}

async function savePrivateShare(payload) {
  if (privateShareSaving) return
  privateShareSaving = true
  clearMainError()
  renderPrivateShare()
  try {
    const result = await invoke('updatePrivateShare', payload)
    if (!result?.success) throw new Error(result?.error || 'Could not update private sharing')
    privateShare = result.privateShare ?? null
    privateShareExpiry = result.expiryPreset ?? getPrivateShareExpiryPreset(privateShare?.expires_at ?? null)
    await pollState()
  } catch (error) {
    showMainError(error?.message || 'Could not update private sharing')
  } finally {
    privateShareSaving = false
    renderPrivateShare()
  }
}

function getSlotWarning(slots) {
  if (slots > 16) return 'Very high resource usage - recommended for servers or dedicated machines only.'
  if (slots > 8) return 'High resource usage - ensure a stable connection.'
  return ''
}

function renderSlots(configured, slots) {
  const dots = document.getElementById('slots-dots')
  const summary = document.getElementById('slots-summary')
  const warning = document.getElementById('slots-warning')
  const slotValue = document.getElementById('slots-value')
  const decrementBtn = document.getElementById('slots-decrement')
  const incrementBtn = document.getElementById('slots-increment')
  if (!dots || !summary || !warning || !slotValue || !decrementBtn || !incrementBtn) return

  slotValue.textContent = String(configured)
  decrementBtn.disabled = configured <= 1
  incrementBtn.disabled = configured >= 32
  dots.innerHTML = ''

  const statuses = slots?.statuses ?? []
  const active = slots?.active ?? statuses.filter((slot) => slot.running).length
  for (let i = 0; i < configured; i += 1) {
    const dot = document.createElement('span')
    dot.className = `slot-dot${statuses[i]?.running ? ' on' : ''}`
    dot.title = statuses[i]?.running ? `Slot ${i} active` : `Slot ${i} idle`
    dots.appendChild(dot)
  }

  summary.textContent = `${active} / ${configured} slots active`
  const warningText = getSlotWarning(configured)
  warning.textContent = warningText
  warning.style.display = warningText ? 'block' : 'none'
}

function renderStartupPreferences(state) {
  const config = state?.config ?? {}
  const launchToggle = document.getElementById('launch-startup-toggle')
  const autoShareToggle = document.getElementById('auto-share-toggle')
  const launchDesc = document.getElementById('launch-startup-desc')
  const autoShareDesc = document.getElementById('auto-share-desc')
  const note = document.getElementById('startup-note')
  const signedIn = !!config.userId
  const accepted = !!config.hasAcceptedProviderTerms

  setToggleVisual(launchToggle, {
    on: !!config.launchOnStartup,
    loading: startupBusy.launchOnStartup,
    disabled: startupBusy.launchOnStartup,
  })
  setToggleVisual(autoShareToggle, {
    on: !!config.autoShareOnLaunch,
    loading: startupBusy.autoShareOnLaunch,
    disabled: !signedIn || !accepted || startupBusy.autoShareOnLaunch,
  })

  if (launchDesc) {
    launchDesc.textContent = config.launchOnStartup
      ? 'PeerMesh will launch quietly in the tray when your PC starts.'
      : 'Keep launch disabled if you only want to open PeerMesh manually.'
  }

  if (autoShareDesc) {
    if (!signedIn) {
      autoShareDesc.textContent = 'Sign in before enabling automatic sharing.'
    } else if (!accepted) {
      autoShareDesc.textContent = 'Turn sharing on once and accept the disclosure before enabling this.'
    } else if (config.autoShareOnLaunch) {
      autoShareDesc.textContent = 'When PeerMesh launches, sharing will start automatically for this signed-in account.'
    } else {
      autoShareDesc.textContent = 'Requires prior disclosure acceptance. Sharing stays manual until you enable this.'
    }
  }

  if (note) {
    note.textContent = config.launchOnStartup
      ? 'Launch on startup hides the window and starts PeerMesh in the tray.'
      : 'These settings apply to this desktop only.'
  }
}

function resetAuthUI() {
  const codeEl = document.getElementById('device-code-display')
  const codeHint = document.getElementById('code-hint')
  const codeWaiting = document.getElementById('code-waiting')
  const errEl = document.getElementById('auth-error')
  const btn = document.getElementById('btn-open-browser')
  const copyBtn = document.getElementById('btn-copy-code')
  const statusEl = document.getElementById('auth-status')

  if (codeEl) {
    codeEl.style.display = 'none'
    codeEl.textContent = ''
  }
  if (codeHint) codeHint.style.display = 'none'
  if (codeWaiting) {
    codeWaiting.style.display = 'flex'
    codeWaiting.innerHTML = '<span id="code-spinner" style="display:inline-block;width:10px;height:10px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin 0.8s linear infinite"></span> GETTING CODE...'
  }
  if (copyBtn) {
    copyBtn.style.display = 'none'
    copyBtn.onclick = null
  }
  if (errEl) errEl.style.display = 'none'
  if (statusEl) {
    statusEl.innerHTML = '<span style="display:inline-block;width:8px;height:8px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin 0.8s linear infinite"></span> WAITING FOR SIGN IN...'
  }
  if (btn) {
    btn.disabled = !navigator.onLine
    btn.textContent = navigator.onLine ? 'SIGN IN WITH BROWSER' : 'NO INTERNET'
  }
}

function stopDevicePoll() {
  if (devicePollInterval) {
    clearInterval(devicePollInterval)
    devicePollInterval = null
  }
  deviceFlowActive = false
}

async function startDeviceFlow() {
  if (deviceFlowActive || typeof api.requestDeviceCode !== 'function') return
  deviceFlowActive = true

  const codeEl = document.getElementById('device-code-display')
  const codeHint = document.getElementById('code-hint')
  const codeWaiting = document.getElementById('code-waiting')
  const errEl = document.getElementById('auth-error')
  const btn = document.getElementById('btn-open-browser')
  const copyBtn = document.getElementById('btn-copy-code')
  const errorText = document.getElementById('auth-error-text')

  if (errEl) errEl.style.display = 'none'
  if (codeEl) {
    codeEl.style.display = 'none'
    codeEl.textContent = ''
  }
  if (codeHint) codeHint.style.display = 'none'
  if (codeWaiting) codeWaiting.style.display = 'flex'
  if (btn) {
    btn.disabled = true
    btn.textContent = 'OPENING BROWSER...'
  }

  if (!navigator.onLine) {
    if (errorText) errorText.textContent = 'No internet connection - check your network and try again'
    if (errEl) errEl.style.display = 'block'
    if (codeWaiting) codeWaiting.style.display = 'none'
    if (btn) {
      btn.disabled = true
      btn.textContent = 'NO INTERNET'
    }
    deviceFlowActive = false
    return
  }

  const result = await invoke('requestDeviceCode')
  if (!result || result.error) {
    if (errorText) errorText.textContent = result?.error || 'Could not reach server'
    if (errEl) errEl.style.display = 'block'
    if (codeWaiting) codeWaiting.style.display = 'none'
    if (btn) {
      btn.disabled = false
      btn.textContent = 'TRY AGAIN'
    }
    deviceFlowActive = false
    return
  }

  const { device_code: deviceCode, user_code: userCode, verification_uri: verificationUri, interval = 3 } = result

  if (codeWaiting) codeWaiting.style.display = 'none'
  if (codeEl) {
    codeEl.textContent = userCode
    codeEl.style.display = 'block'
  }
  if (codeHint) codeHint.style.display = 'block'
  if (copyBtn) {
    copyBtn.style.display = 'inline-block'
    copyBtn.onclick = () => {
      navigator.clipboard.writeText(userCode).then(() => {
        copyBtn.textContent = 'COPIED!'
        copyBtn.style.color = 'var(--accent)'
        copyBtn.style.borderColor = 'var(--accent)'
        setTimeout(() => {
          copyBtn.textContent = 'COPY CODE'
          copyBtn.style.color = ''
          copyBtn.style.borderColor = ''
        }, 2000)
      }).catch(() => {})
    }
  }
  if (btn) {
    btn.disabled = false
    btn.textContent = 'OPEN BROWSER AGAIN'
  }

  await invoke('openAuth', `${verificationUri}?activate=1&code=${encodeURIComponent(userCode)}`)

  stopDevicePoll()
  deviceFlowActive = true
  devicePollInterval = setInterval(async () => {
    const poll = await invoke('pollDeviceCode', deviceCode)
    if (!poll) return

    if (poll.status === 'approved' && poll.user) {
      stopDevicePoll()
      resetAuthUI()
      const waiting = document.getElementById('code-waiting')
      if (waiting) {
        waiting.style.display = 'flex'
        waiting.innerHTML = '<span style="display:inline-block;width:10px;height:10px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin 0.8s linear infinite"></span> SIGNING IN...'
      }
      const signInResult = await invoke('signIn', {
        token: poll.user.token,
        userId: poll.user.id,
        country: poll.user.country || 'RW',
        trust: poll.user.trustScore || 50,
      })
      if (signInResult?.success === false) {
        if (errorText) errorText.textContent = signInResult.error || 'Sign-in failed - please try again'
        if (errEl) errEl.style.display = 'block'
        if (btn) {
          btn.disabled = false
          btn.textContent = 'SIGN IN WITH BROWSER'
        }
        if (waiting) waiting.style.display = 'none'
        return
      }
      for (let i = 0; i < 5; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 600))
        const state = await pollState()
        if (state?.running) break
      }
      await pollState()
    } else if (poll.status === 'denied') {
      stopDevicePoll()
      if (codeEl) codeEl.style.display = 'none'
      if (codeHint) codeHint.style.display = 'none'
      if (errorText) errorText.textContent = 'Sign-in was denied. Click below to try again.'
      if (errEl) errEl.style.display = 'block'
      if (btn) {
        btn.disabled = false
        btn.textContent = 'SIGN IN WITH BROWSER'
      }
    } else if (poll.status === 'expired') {
      stopDevicePoll()
      if (codeEl) codeEl.style.display = 'none'
      if (codeHint) codeHint.style.display = 'none'
      if (copyBtn) copyBtn.style.display = 'none'
      if (errorText) errorText.textContent = 'Code expired - click below to get a new one.'
      if (errEl) errEl.style.display = 'block'
      const statusEl = document.getElementById('auth-status')
      if (statusEl) statusEl.textContent = ''
      if (btn) {
        btn.disabled = false
        btn.textContent = 'GET NEW CODE'
      }
    }
  }, interval * 1000)
}

function showDisclosureModal() {
  if (document.getElementById('pm-disclosure')) return
  const overlay = document.createElement('div')
  overlay.id = 'pm-disclosure'
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.82);display:flex;align-items:center;justify-content:center;z-index:999;padding:16px'
  overlay.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:22px;max-width:320px;width:100%">
      <div style="font-family:'Courier New',monospace;font-size:10px;color:var(--accent);letter-spacing:1px;margin-bottom:10px">BEFORE YOU SHARE</div>
      <div style="font-size:14px;font-weight:600;margin-bottom:14px;line-height:1.3">What sharing your connection means</div>
      <div style="display:flex;gap:10px;margin-bottom:10px;font-size:12px;color:var(--muted);line-height:1.5"><span>1.</span><span>Your IP address will be used by other PeerMesh users to browse the web.</span></div>
      <div style="display:flex;gap:10px;margin-bottom:10px;font-size:12px;color:var(--muted);line-height:1.5"><span>2.</span><span>All sessions are logged with signed receipts.</span></div>
      <div style="display:flex;gap:10px;margin-bottom:10px;font-size:12px;color:var(--muted);line-height:1.5"><span>3.</span><span>Blocked: .onion sites, SMTP/mail, torrents, private IPs.</span></div>
      <div style="display:flex;gap:10px;margin-bottom:10px;font-size:12px;color:var(--muted);line-height:1.5"><span>4.</span><span>You can stop sharing at any time.</span></div>
      <div style="display:flex;gap:10px;margin-bottom:10px;font-size:12px;color:var(--muted);line-height:1.5"><span>5.</span><span>Sharing earns you free browsing credits.</span></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:16px">
        <button id="pm-disclose-cancel" style="padding:10px;background:none;border:1px solid var(--border);border-radius:8px;color:var(--muted);cursor:pointer;font-family:'Courier New',monospace;font-size:10px">CANCEL</button>
        <button id="pm-disclose-accept" style="padding:10px;background:var(--accent);border:none;border-radius:8px;color:#000;cursor:pointer;font-family:'Courier New',monospace;font-size:10px;font-weight:700">I UNDERSTAND - SHARE</button>
      </div>
    </div>`
  document.body.appendChild(overlay)
  document.getElementById('pm-disclose-cancel').onclick = () => overlay.remove()
  document.getElementById('pm-disclose-accept').onclick = async () => {
    overlay.remove()
    await invoke('acceptProviderTerms')
    await doToggleSharing(false)
  }
}

async function doToggleSharing(isSharing) {
  if (togglingShare) return
  togglingShare = true
  clearMainError()

  const toggle = document.getElementById('share-toggle')
  const label = document.getElementById('status-label')
  const dot = document.getElementById('status-dot')
  const card = document.getElementById('status-card')
  const desc = document.getElementById('toggle-desc')

  setToggleVisual(toggle, { loading: true })
  if (label) {
    label.textContent = isSharing ? 'STOPPING...' : 'STARTING...'
    label.style.color = 'var(--muted)'
  }
  if (dot) {
    dot.className = 'status-dot'
    dot.style.cssText = 'animation:spin 0.7s linear infinite;background:transparent;border:2px solid var(--border);border-top-color:var(--accent)'
  }
  if (card) card.className = 'status-card'
  if (desc) desc.textContent = 'Please wait...'

  try {
    if (isSharing) {
      await Promise.allSettled([
        fetch('http://127.0.0.1:7654/native/share/stop', { method: 'POST', signal: AbortSignal.timeout(2000) }),
        fetch('http://127.0.0.1:7656/native/share/stop', { method: 'POST', signal: AbortSignal.timeout(2000) }),
      ])
    } else {
      const result = await invoke('toggleSharing')
      if (result?.error) showMainError(result.error)
    }
  } catch {
    showMainError('Could not toggle sharing - please try again')
  } finally {
    if (dot) dot.style.cssText = ''
    togglingShare = false
  }

  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    const state = await pollState()
    if (!state) continue
    const shouldBreak = !isSharing
      ? (state.running || state.peerRunning)
      : (!state.running && !state.peerRunning)
    if (shouldBreak) break
  }
}

function updateUI(state) {
  window.__lastPeerMeshState = state
  const running = !!state?.running
  const config = state?.config ?? {}
  const stats = state?.stats ?? { requestsHandled: 0, bytesServed: 0 }

  if (!config.userId) {
    privateShare = null
    renderPrivateShare()
    renderStartupPreferences(state)
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
  const peerSharing = !!state.peerRunning
  const starting = !!state?.shareEnabled && !running && !peerSharing
  const desktopSlots = state.slots
  const peerSlots = state.peerSlots
  const configuredSlots = state.connectionSlots ?? config.connectionSlots ?? 1
  const desktopPrivateShareActive = !!state.privateShareActive
  const peerPrivateShareActive = !!state.peerPrivateShareActive
  const displayStats = (peerSharing && state.peerStats) ? state.peerStats : stats
  const displaySlots = peerSharing
    ? (peerSlots ?? { configured: state.peerConnectionSlots ?? 1, active: 0, statuses: [] })
    : (desktopSlots ?? { configured: configuredSlots, active: 0, statuses: [] })

  if (state.privateShare !== undefined) {
    privateShare = state.privateShare ?? null
    privateShareExpiry = getPrivateShareExpiryPreset(privateShare?.expires_at ?? null)
  }

  renderPrivateShare()
  renderStartupPreferences(state)
  renderSlots(displaySlots.configured ?? configuredSlots, displaySlots)

  document.getElementById('stat-requests').textContent = String(displayStats.requestsHandled ?? 0)
  document.getElementById('stat-bytes').textContent = formatBytes(displayStats.bytesServed ?? 0)
  document.getElementById('stat-slots').textContent = `${displaySlots.active ?? 0} / ${displaySlots.configured ?? configuredSlots}`
  document.getElementById('user-label').textContent = config.userId ? `ID: ${config.userId.slice(0, 8)}` : ''

  if (!togglingShare) {
    if (running) {
      const privateBadge = desktopPrivateShareActive ? ' [PRIVATE]' : ' [PUBLIC]'
      if (dot) {
        dot.className = 'status-dot on'
        dot.style.cssText = ''
      }
      if (label) {
        label.textContent = `SHARING - ${config.country} (${configuredSlots} slots)${privateBadge}`
        label.style.color = 'var(--accent)'
      }
      if (country) country.textContent = getFlagForCountry(config.country)
      if (statsEl) {
        statsEl.textContent = `${desktopSlots?.active ?? 0} / ${desktopSlots?.configured ?? configuredSlots} slots active - ${stats.requestsHandled} requests - ${formatBytes(stats.bytesServed)} served`
      }
      if (card) card.className = 'status-card active'
      if (peerBanner) peerBanner.style.display = 'none'
    } else if (peerSharing) {
      const privateBadge = peerPrivateShareActive ? ' [PRIVATE]' : ' [PUBLIC]'
      const peerConfigured = state.peerConnectionSlots ?? peerSlots?.configured ?? 1
      const peerActive = peerSlots?.active ?? 0
      if (dot) {
        dot.className = 'status-dot on'
        dot.style.cssText = ''
      }
      if (label) {
        label.textContent = `CLI IS SHARING${privateBadge}`
        label.style.color = 'var(--accent)'
      }
      if (country) country.textContent = ''
      if (statsEl) {
        statsEl.textContent = state.peerStats
          ? `${peerActive} / ${peerConfigured} slots active - ${state.peerStats.requestsHandled ?? 0} requests - ${formatBytes(state.peerStats.bytesServed ?? 0)} served`
          : 'CLI provider running on this machine'
      }
      if (card) card.className = 'status-card active'
      if (peerBanner) peerBanner.style.display = 'none'
    } else if (starting) {
      if (dot) {
        dot.className = 'status-dot'
        dot.style.cssText = 'animation:spin 0.7s linear infinite;background:transparent;border:2px solid var(--border);border-top-color:var(--accent)'
      }
      if (label) {
        label.textContent = `STARTING - ${config.country} (${configuredSlots} slots)`
        label.style.color = 'var(--muted)'
      }
      if (country) country.textContent = ''
      if (statsEl) statsEl.textContent = `Connecting ${configuredSlots} slot${configuredSlots === 1 ? '' : 's'}...`
      if (card) card.className = 'status-card'
      if (peerBanner) peerBanner.style.display = 'none'
    } else {
      if (dot) {
        dot.className = 'status-dot'
        dot.style.cssText = ''
      }
      if (label) {
        label.textContent = 'NOT SHARING'
        label.style.color = 'var(--muted)'
      }
      if (country) country.textContent = ''
      if (statsEl) statsEl.textContent = 'Toggle below to start sharing'
      if (card) card.className = 'status-card'
      if (peerBanner) peerBanner.style.display = 'none'
    }
  }

  setToggleVisual(document.getElementById('share-toggle'), {
    on: running || peerSharing,
    loading: togglingShare,
  })

  document.getElementById('toggle-desc').textContent = running
    ? 'Sharing active - earning credits'
    : peerSharing
      ? 'CLI is sharing'
      : starting
        ? 'Starting local sharing...'
        : 'Help others browse. Stay free.'
}

async function pollState() {
  const state = await invoke('getState')
  if (!state) return null
  if (state.version) setVersion(state.version)

  try {
    const response = await fetch('http://127.0.0.1:7656/native/state', { signal: AbortSignal.timeout(800) })
    if (response.ok) {
      const cli = await response.json()
      state.peerRunning = !!cli.running
      state.peerStats = cli.stats
      state.peerSlots = cli.slots
      state.peerConnectionSlots = cli.connectionSlots
      state.peerPrivateShareActive = !!cli.privateShareActive
    } else {
      state.peerRunning = false
    }
  } catch {
    state.peerRunning = false
  }

  updateUI(state)
  loadPrivateShare(false).catch(() => {})
  return state
}

async function updateStartupPreference(key, enabled) {
  const toggleId = key === 'launchOnStartup' ? 'setLaunchOnStartup' : 'setAutoShareOnLaunch'
  startupBusy[key] = true
  renderStartupPreferences(window.__lastPeerMeshState || null)
  clearMainError()
  try {
    const result = await invoke(toggleId, enabled)
    if (!result?.success) throw new Error(result?.error || 'Could not update startup preference')
    await pollState()
  } catch (error) {
    showMainError(error?.message || 'Could not update startup preference')
  } finally {
    startupBusy[key] = false
    renderStartupPreferences(window.__lastPeerMeshState || null)
  }
}

document.getElementById('btn-open-browser').addEventListener('click', () => {
  stopDevicePoll()
  deviceFlowActive = false
  startDeviceFlow()
})

document.getElementById('share-toggle').addEventListener('click', async () => {
  if (!navigator.onLine) {
    showMainError('No internet connection - sharing requires an active network')
    return
  }

  clearMainError()
  const state = await pollState() || await invoke('getState')
  const isSharing = !!(state?.running || state?.peerRunning)

  if (!isSharing) {
    let accepted = !!state?.config?.hasAcceptedProviderTerms
    if (!accepted) {
      const result = await invoke('acceptProviderTerms', { checkOnly: true })
      accepted = result?.accepted === true
    }
    if (!accepted) {
      showDisclosureModal()
      return
    }
  }

  await doToggleSharing(isSharing)
})

document.getElementById('launch-startup-toggle').addEventListener('click', async () => {
  const current = !!window.__lastPeerMeshState?.config?.launchOnStartup
  await updateStartupPreference('launchOnStartup', !current)
})

document.getElementById('auto-share-toggle').addEventListener('click', async () => {
  const current = !!window.__lastPeerMeshState?.config?.autoShareOnLaunch
  await updateStartupPreference('autoShareOnLaunch', !current)
})

document.getElementById('btn-dashboard').addEventListener('click', async () => {
  await invoke('openDashboard')
})

document.getElementById('btn-signout').addEventListener('click', async () => {
  stopDevicePoll()
  resetAuthUI()
  await invoke('signOut')
  privateShare = null
  privateShareExpiry = '24'
  renderPrivateShare()
  await pollState()
  if (typeof api.requestDeviceCode === 'function') startDeviceFlow()
})

document.getElementById('copy-private-share').addEventListener('click', async () => {
  if (!privateShare?.code) return
  try {
    await navigator.clipboard.writeText(privateShare.code)
    const btn = document.getElementById('copy-private-share')
    const previous = btn.textContent
    btn.textContent = 'COPIED'
    setTimeout(() => { btn.textContent = previous }, 1500)
  } catch {}
})

document.getElementById('private-share-expiry').addEventListener('change', async (event) => {
  privateShareExpiry = event.target.value
  renderPrivateShare()
  if (privateShare?.enabled) {
    await savePrivateShare({ enabled: true, expiryHours: privateShareExpiry })
  }
})

document.getElementById('refresh-private-share').addEventListener('click', async () => {
  await savePrivateShare({ enabled: true, refresh: true, expiryHours: privateShareExpiry })
})

document.getElementById('toggle-private-share').addEventListener('click', async () => {
  const nextEnabled = !(privateShare?.enabled ?? false)
  await savePrivateShare({ enabled: nextEnabled, expiryHours: privateShareExpiry })
})

async function updateConnectionSlots(slots) {
  const nextSlots = Math.max(1, Math.min(32, parseInt(String(slots), 10) || 1))
  try {
    await invoke('setConnectionSlots', nextSlots)
    await pollState()
  } catch {
    showMainError('Could not update connection slots')
  }
}

document.getElementById('slots-decrement').addEventListener('click', async () => {
  const current = parseInt(document.getElementById('slots-value').textContent || '1', 10)
  await updateConnectionSlots(current - 1)
})

document.getElementById('slots-increment').addEventListener('click', async () => {
  const current = parseInt(document.getElementById('slots-value').textContent || '1', 10)
  await updateConnectionSlots(current + 1)
})

setInterval(() => {
  pollState().catch(() => {})
}, 2000)

setOffline(!navigator.onLine)
renderPrivateShare()
renderStartupPreferences(null)

pollState().then((state) => {
  if (!state?.config?.userId) {
    resetAuthUI()
    if (typeof api.requestDeviceCode === 'function') startDeviceFlow()
  }
})
