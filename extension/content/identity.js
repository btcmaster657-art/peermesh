// identity.js — PeerMesh identity spoofing
// Injected as MAIN world script when a session is active
// Spoofs: timezone, language, WebRTC ICE policy, UA hints, canvas noise

;(function () {
  const tz = document.currentScript?.dataset?.tz || ''
  const lang = document.currentScript?.dataset?.lang || 'en-US'
  if (!tz) return

  // 1. Timezone
  const _DTF = Intl.DateTimeFormat
  Intl.DateTimeFormat = function (locales, opts = {}) {
    opts.timeZone = opts.timeZone || tz
    return new _DTF(locales, opts)
  }
  Intl.DateTimeFormat.prototype = _DTF.prototype
  Intl.DateTimeFormat.supportedLocalesOf = _DTF.supportedLocalesOf.bind(_DTF)

  const tzOffset = (() => {
    try {
      const now = new Date()
      const utc = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }))
      const peer = new Date(now.toLocaleString('en-US', { timeZone: tz }))
      return (utc - peer) / 60000
    } catch { return 0 }
  })()
  Date.prototype.getTimezoneOffset = function () { return tzOffset }

  // 2. Language
  Object.defineProperty(navigator, 'language', { get: () => lang, configurable: true })
  Object.defineProperty(navigator, 'languages', { get: () => [lang, lang.split('-')[0]], configurable: true })

  // 3. WebRTC — relay-only ICE so no local IP leaks
  const _RPC = window.RTCPeerConnection
  if (_RPC) {
    window.RTCPeerConnection = function (cfg = {}) {
      cfg.iceTransportPolicy = 'relay'
      cfg.iceServers = (cfg.iceServers || []).filter(s =>
        [].concat(s.urls).some(u => u.startsWith('turn:') || u.startsWith('turns:'))
      )
      return new _RPC(cfg)
    }
    window.RTCPeerConnection.prototype = _RPC.prototype
  }

  // 4. UA client hints — Windows Chrome 124
  try {
    const brands = [
      { brand: 'Google Chrome', version: '124' },
      { brand: 'Chromium', version: '124' },
      { brand: 'Not-A.Brand', version: '99' },
    ]
    Object.defineProperty(navigator, 'userAgentData', {
      get: () => ({
        brands,
        mobile: false,
        platform: 'Windows',
        getHighEntropyValues: async () => ({
          architecture: 'x86', bitness: '64', brands,
          fullVersionList: [{ brand: 'Google Chrome', version: '124.0.0.0' }],
          mobile: false, model: '', platform: 'Windows',
          platformVersion: '10.0.0', uaFullVersion: '124.0.0.0',
        }),
      }),
      configurable: true,
    })
  } catch {}

  // 5. Canvas fingerprint noise — deterministic per timezone so consistent
  const seed = tz.split('').reduce((a, c) => a + c.charCodeAt(0), 0)
  const _getImageData = CanvasRenderingContext2D.prototype.getImageData
  const _toDataURL = HTMLCanvasElement.prototype.toDataURL
  const _toBlob = HTMLCanvasElement.prototype.toBlob

  function noise(data) {
    for (let i = 0; i < data.length; i += 4) {
      const n = ((seed * (i + 1)) % 3) - 1
      data[i] = Math.max(0, Math.min(255, data[i] + n))
    }
  }

  HTMLCanvasElement.prototype.toDataURL = function (...a) {
    const ctx = this.getContext('2d')
    if (ctx && this.width && this.height) {
      const img = _getImageData.call(ctx, 0, 0, this.width, this.height)
      noise(img.data)
      ctx.putImageData(img, 0, 0)
    }
    return _toDataURL.apply(this, a)
  }

  HTMLCanvasElement.prototype.toBlob = function (cb, ...a) {
    const ctx = this.getContext('2d')
    if (ctx && this.width && this.height) {
      const img = _getImageData.call(ctx, 0, 0, this.width, this.height)
      noise(img.data)
      ctx.putImageData(img, 0, 0)
    }
    return _toBlob.call(this, cb, ...a)
  }
})()
