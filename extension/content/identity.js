// // identity.js - PeerMesh identity spoofing
// // Injected into the MAIN world while a PeerMesh session is active.

// ;(function () {
//   const rawProfile = document.currentScript?.dataset?.profile || ''
//   if (!rawProfile) return

//   let profile
//   try {
//     profile = JSON.parse(rawProfile)
//   } catch {
//     return
//   }

//   // Seed anchored to userId + country + platform + userAgent.
//   // userId ensures each user gets unique noise values.
//   // country + platform + userAgent ensure the noise is consistent with
//   // the spoofed device — same user, same country = identical fingerprint
//   // across every session, reconnect, and provider change.
//   const seedSource = `${profile.userId || ''}:${profile.country}:${profile.tz}:${profile.platform}:${profile.userAgent}`
//   const seed = Array.from(seedSource).reduce((sum, char, index) => sum + (char.charCodeAt(0) * (index + 1)), 0)

//   function defineGetter(target, property, getter) {
//     try {
//       Object.defineProperty(target, property, { get: getter, configurable: true })
//     } catch {}
//   }

//   function seededOffset(value, spread) {
//     return ((((seed * (value + 3)) % (spread * 2 + 1)) - spread) || 0) / 1000
//   }

//   function deterministicNoise(index, scale) {
//     return ((((seed + index * 17) % 11) - 5) / 5) * scale
//   }

//   function makePluginArray() {
//     const pdfPlugin = {
//       name: 'Chrome PDF Viewer',
//       filename: 'internal-pdf-viewer',
//       description: 'Portable Document Format',
//       length: 1,
//       0: { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
//       item(i) { return this[i] ?? null },
//       namedItem(name) { return name === 'application/pdf' ? this[0] : null },
//     }
//     const plugins = {
//       0: pdfPlugin,
//       length: 1,
//       item(i) { return this[i] ?? null },
//       namedItem(name) { return name === 'Chrome PDF Viewer' ? this[0] : null },
//       refresh() {},
//       [Symbol.iterator]: function* iterator() { yield this[0] },
//     }
//     const mimeTypes = {
//       0: pdfPlugin[0],
//       length: 1,
//       item(i) { return this[i] ?? null },
//       namedItem(name) { return name === 'application/pdf' ? this[0] : null },
//       [Symbol.iterator]: function* iterator() { yield this[0] },
//     }
//     return { plugins, mimeTypes }
//   }

//   const pluginData = makePluginArray()

//   // Timezone
//   const NativeDTF = Intl.DateTimeFormat
//   Intl.DateTimeFormat = function DateTimeFormat(locales, options = {}) {
//     return new NativeDTF(locales, { ...options, timeZone: options.timeZone || profile.tz })
//   }
//   Intl.DateTimeFormat.prototype = NativeDTF.prototype
//   Intl.DateTimeFormat.supportedLocalesOf = NativeDTF.supportedLocalesOf.bind(NativeDTF)

//   const tzOffset = (() => {
//     try {
//       const now = new Date()
//       const utc = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }))
//       const peer = new Date(now.toLocaleString('en-US', { timeZone: profile.tz }))
//       return (utc - peer) / 60000
//     } catch {
//       return 0
//     }
//   })()
//   Date.prototype.getTimezoneOffset = function getTimezoneOffset() {
//     return tzOffset
//   }

//   // Navigator identity
//   defineGetter(Navigator.prototype, 'language', () => profile.lang)
//   defineGetter(Navigator.prototype, 'languages', () => [profile.lang, profile.lang.split('-')[0]])
//   defineGetter(Navigator.prototype, 'userAgent', () => profile.userAgent)
//   defineGetter(Navigator.prototype, 'appVersion', () => profile.userAgent.replace(/^Mozilla\//, '5.0 '))
//   defineGetter(Navigator.prototype, 'platform', () => profile.platform)
//   defineGetter(Navigator.prototype, 'vendor', () => 'Google Inc.')
//   defineGetter(Navigator.prototype, 'hardwareConcurrency', () => profile.hardwareConcurrency)
//   defineGetter(Navigator.prototype, 'deviceMemory', () => profile.deviceMemory)
//   defineGetter(Navigator.prototype, 'maxTouchPoints', () => profile.maxTouchPoints)
//   defineGetter(Navigator.prototype, 'plugins', () => pluginData.plugins)
//   defineGetter(Navigator.prototype, 'mimeTypes', () => pluginData.mimeTypes)

//   const chromeVersion = String(profile.uaVersion || '124')
//   const chromeFullVersion = profile.uaFullVersion || `${chromeVersion}.0.0.0`
//   const brands = [
//     { brand: 'Google Chrome', version: chromeVersion },
//     { brand: 'Chromium', version: chromeVersion },
//     { brand: 'Not-A.Brand', version: '99' },
//   ]
//   defineGetter(Navigator.prototype, 'userAgentData', () => ({
//     brands,
//     mobile: profile.mobile,
//     platform: profile.platformLabel,
//     getHighEntropyValues: async () => ({
//       architecture: profile.architecture || (profile.mobile ? 'arm' : 'x86'),
//       bitness: profile.bitness || '64',
//       brands,
//       fullVersionList: [{ brand: 'Google Chrome', version: chromeFullVersion }],
//       mobile: profile.mobile,
//       model: profile.deviceModel || '',
//       platform: profile.platformLabel,
//       platformVersion: profile.platformVersion || (profile.mobile ? '14.0.0' : '10.0.0'),
//       uaFullVersion: chromeFullVersion,
//     }),
//   }))

//   // Connection
//   const connection = {
//     effectiveType: profile.connection.effectiveType,
//     downlink: profile.connection.downlink,
//     rtt: profile.connection.rtt,
//     saveData: profile.connection.saveData,
//     onchange: null,
//     addEventListener() {},
//     removeEventListener() {},
//     dispatchEvent() { return false },
//   }
//   defineGetter(Navigator.prototype, 'connection', () => connection)

//   // Screen and viewport
//   defineGetter(Screen.prototype, 'width', () => profile.screen.width)
//   defineGetter(Screen.prototype, 'height', () => profile.screen.height)
//   defineGetter(Screen.prototype, 'availWidth', () => profile.screen.availWidth)
//   defineGetter(Screen.prototype, 'availHeight', () => profile.screen.availHeight)
//   defineGetter(Screen.prototype, 'colorDepth', () => profile.colorDepth)
//   defineGetter(Screen.prototype, 'pixelDepth', () => profile.pixelDepth)
//   defineGetter(window, 'innerWidth', () => profile.screen.innerWidth)
//   defineGetter(window, 'innerHeight', () => profile.screen.innerHeight)
//   defineGetter(window, 'outerWidth', () => profile.screen.width)
//   defineGetter(window, 'outerHeight', () => profile.screen.height)

//   // WebRTC - relay only, no IP leak
//   const NativeRTCPeerConnection = window.RTCPeerConnection
//   if (NativeRTCPeerConnection) {
//     window.RTCPeerConnection = function RTCPeerConnection(config = {}) {
//       const safeConfig = { ...config }
//       safeConfig.iceTransportPolicy = 'relay'
//       safeConfig.iceServers = (safeConfig.iceServers || []).filter(server =>
//         [].concat(server.urls).some(url => String(url).startsWith('turn:') || String(url).startsWith('turns:'))
//       )
//       return new NativeRTCPeerConnection(safeConfig)
//     }
//     window.RTCPeerConnection.prototype = NativeRTCPeerConnection.prototype
//   }

//   // Canvas + font metrics
//   const nativeGetImageData = CanvasRenderingContext2D.prototype.getImageData
//   const nativeToDataURL = HTMLCanvasElement.prototype.toDataURL
//   const nativeToBlob = HTMLCanvasElement.prototype.toBlob
//   const nativeMeasureText = CanvasRenderingContext2D.prototype.measureText

//   function applyCanvasNoise(data) {
//     for (let i = 0; i < data.length; i += 4) {
//       const delta = ((seed + i) % 3) - 1
//       data[i] = Math.max(0, Math.min(255, data[i] + delta))
//       data[i + 1] = Math.max(0, Math.min(255, data[i + 1] - delta))
//     }
//   }

//   function mutateCanvas(canvas, callback, args) {
//     const ctx = canvas.getContext && canvas.getContext('2d')
//     if (ctx && canvas.width && canvas.height) {
//       try {
//         const image = nativeGetImageData.call(ctx, 0, 0, canvas.width, canvas.height)
//         applyCanvasNoise(image.data)
//         ctx.putImageData(image, 0, 0)
//       } catch {}
//     }
//     return callback.apply(canvas, args)
//   }

//   HTMLCanvasElement.prototype.toDataURL = function toDataURL(...args) {
//     return mutateCanvas(this, nativeToDataURL, args)
//   }

//   HTMLCanvasElement.prototype.toBlob = function toBlob(callback, ...args) {
//     return mutateCanvas(this, nativeToBlob, [callback, ...args])
//   }

//   CanvasRenderingContext2D.prototype.measureText = function measureText(text) {
//     const metrics = nativeMeasureText.call(this, text)
//     const width = metrics.width + seededOffset(String(text).length, 3)
//     return new Proxy(metrics, {
//       get(target, property) {
//         if (property === 'width') return width
//         return Reflect.get(target, property)
//       },
//     })
//   }

//   // Geolocation — stable coords near provider country capital, jitter seeded from userId
//   if (navigator.geolocation) {
//     function fakePosition(success) {
//       const accuracy = 20 + ((seed % 80))
//       const latJitter = (((seed * 7) % 100) - 50) / 10000
//       const lonJitter = (((seed * 13) % 100) - 50) / 10000
//       success({
//         coords: {
//           latitude: profile.lat + latJitter,
//           longitude: profile.lon + lonJitter,
//           accuracy,
//           altitude: null,
//           altitudeAccuracy: null,
//           heading: null,
//           speed: null,
//         },
//         timestamp: Date.now(),
//       })
//     }
//     Object.defineProperty(navigator, 'geolocation', {
//       get: () => ({
//         getCurrentPosition: (success, error, opts) => fakePosition(success),
//         watchPosition: (success, error, opts) => { fakePosition(success); return 0 },
//         clearWatch: () => {},
//       }),
//       configurable: true,
//     })
//   }

//   // Screen orientation — mobile personas report portrait
//   if (window.screen?.orientation) {
//     const orientationType = profile.mobile ? 'portrait-primary' : 'landscape-primary'
//     const orientationAngle = profile.mobile ? 0 : 0
//     try {
//       Object.defineProperty(window.screen, 'orientation', {
//         get: () => ({
//           type: orientationType,
//           angle: orientationAngle,
//           onchange: null,
//           addEventListener() {},
//           removeEventListener() {},
//           dispatchEvent() { return false },
//           lock: () => Promise.reject(new DOMException('Not supported')),
//           unlock: () => {},
//         }),
//         configurable: true,
//       })
//     } catch {}
//   }

//   // Audio fingerprinting — sampleRate + channel data noise seeded from userId
//   const NativeAudioContext = window.AudioContext || window.webkitAudioContext
//   const NativeOfflineAudioContext = window.OfflineAudioContext || window.webkitOfflineAudioContext
//   const NativeGetChannelData = AudioBuffer.prototype.getChannelData

//   function patchAudioContext(ContextCtor) {
//     if (!ContextCtor) return ContextCtor
//     function WrappedAudioContext(...args) {
//       const ctx = new ContextCtor(...args)
//       try {
//         defineGetter(ctx, 'sampleRate', () => profile.sampleRate)
//       } catch {}
//       return ctx
//     }
//     WrappedAudioContext.prototype = ContextCtor.prototype
//     return WrappedAudioContext
//   }

//   if (NativeAudioContext) {
//     window.AudioContext = patchAudioContext(NativeAudioContext)
//     if (window.webkitAudioContext) window.webkitAudioContext = window.AudioContext
//   }

//   if (NativeOfflineAudioContext) {
//     window.OfflineAudioContext = patchAudioContext(NativeOfflineAudioContext)
//     if (window.webkitOfflineAudioContext) window.webkitOfflineAudioContext = window.OfflineAudioContext
//   }

//   AudioBuffer.prototype.getChannelData = function getChannelData(channel) {
//     const data = NativeGetChannelData.call(this, channel)
//     const copy = new Float32Array(data.length)
//     copy.set(data)
//     for (let i = 0; i < copy.length; i += 128) {
//       copy[i] = copy[i] + deterministicNoise(i + channel, 0.00002)
//     }
//     return copy
//   }
// })()
// identity.js - PeerMesh identity spoofing
// Injected into the MAIN world while a PeerMesh session is active.

;(function () {
  const rawProfile = document.currentScript?.dataset?.profile || ''
  if (!rawProfile) return

  let profile
  try {
    profile = JSON.parse(rawProfile)
  } catch {
    return
  }

  const seedSource = `${profile.userId || ''}:${profile.country}:${profile.tz}:${profile.platform}:${profile.userAgent}`
  const seed = Array.from(seedSource).reduce((sum, char, index) => sum + (char.charCodeAt(0) * (index + 1)), 0)

  function defineGetter(target, property, getter) {
    try {
      Object.defineProperty(target, property, { get: getter, configurable: true })
    } catch {}
  }

  function seededOffset(value, spread) {
    return ((((seed * (value + 3)) % (spread * 2 + 1)) - spread) || 0) / 1000
  }

  function deterministicNoise(index, scale) {
    return ((((seed + index * 17) % 11) - 5) / 5) * scale
  }

  function makePluginArray() {
    const pdfPlugin = {
      name: 'Chrome PDF Viewer',
      filename: 'internal-pdf-viewer',
      description: 'Portable Document Format',
      length: 1,
      0: { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
      item(i) { return this[i] ?? null },
      namedItem(name) { return name === 'application/pdf' ? this[0] : null },
    }
    const plugins = {
      0: pdfPlugin,
      length: 1,
      item(i) { return this[i] ?? null },
      namedItem(name) { return name === 'Chrome PDF Viewer' ? this[0] : null },
      refresh() {},
      [Symbol.iterator]: function* iterator() { yield this[0] },
    }
    const mimeTypes = {
      0: pdfPlugin[0],
      length: 1,
      item(i) { return this[i] ?? null },
      namedItem(name) { return name === 'application/pdf' ? this[0] : null },
      [Symbol.iterator]: function* iterator() { yield this[0] },
    }
    return { plugins, mimeTypes }
  }

  const pluginData = makePluginArray()

  // ── Timezone ────────────────────────────────────────────────────────────────
  const NativeDTF = Intl.DateTimeFormat
  Intl.DateTimeFormat = function DateTimeFormat(locales, options = {}) {
    return new NativeDTF(locales, { ...options, timeZone: options.timeZone || profile.tz })
  }
  Intl.DateTimeFormat.prototype = NativeDTF.prototype
  Intl.DateTimeFormat.supportedLocalesOf = NativeDTF.supportedLocalesOf.bind(NativeDTF)

  const tzOffset = (() => {
    try {
      const now = new Date()
      const utc = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }))
      const peer = new Date(now.toLocaleString('en-US', { timeZone: profile.tz }))
      return (utc - peer) / 60000
    } catch {
      return 0
    }
  })()
  Date.prototype.getTimezoneOffset = function getTimezoneOffset() { return tzOffset }

  // ── Intl / Currency / Locale ─────────────────────────────────────────────────
  // Spoof Intl.NumberFormat so currency and locale resolve from spoofed lang,
  // not the real browser locale. This fixes RWF / calling-code leaks from
  // Intl.NumberFormat().resolvedOptions().
  const NativeNF = Intl.NumberFormat
  Intl.NumberFormat = function NumberFormat(locales, options) {
    const loc = locales || profile.lang
    return new NativeNF(loc, options)
  }
  Intl.NumberFormat.prototype = NativeNF.prototype
  Intl.NumberFormat.supportedLocalesOf = NativeNF.supportedLocalesOf.bind(NativeNF)
  Intl.NumberFormat.prototype.resolvedOptions = (function (orig) {
    return function resolvedOptions() {
      const opts = orig.call(this)
      opts.locale = profile.lang
      return opts
    }
  })(Intl.NumberFormat.prototype.resolvedOptions)

  const NativePR = Intl.PluralRules
  if (NativePR) {
    Intl.PluralRules = function PluralRules(locales, options) {
      return new NativePR(locales || profile.lang, options)
    }
    Intl.PluralRules.prototype = NativePR.prototype
  }

  const NativeRTF = Intl.RelativeTimeFormat
  if (NativeRTF) {
    Intl.RelativeTimeFormat = function RelativeTimeFormat(locales, options) {
      return new NativeRTF(locales || profile.lang, options)
    }
    Intl.RelativeTimeFormat.prototype = NativeRTF.prototype
  }

  // ── Navigator identity ───────────────────────────────────────────────────────
  defineGetter(Navigator.prototype, 'language', () => profile.lang)
  defineGetter(Navigator.prototype, 'languages', () => [profile.lang, profile.lang.split('-')[0]])
  defineGetter(Navigator.prototype, 'userAgent', () => profile.userAgent)
  defineGetter(Navigator.prototype, 'appVersion', () => profile.userAgent.replace(/^Mozilla\//, '5.0 '))
  defineGetter(Navigator.prototype, 'platform', () => profile.platform)
  defineGetter(Navigator.prototype, 'vendor', () => 'Google Inc.')
  defineGetter(Navigator.prototype, 'hardwareConcurrency', () => profile.hardwareConcurrency)
  defineGetter(Navigator.prototype, 'deviceMemory', () => profile.deviceMemory)
  defineGetter(Navigator.prototype, 'maxTouchPoints', () => profile.maxTouchPoints)
  defineGetter(Navigator.prototype, 'plugins', () => pluginData.plugins)
  defineGetter(Navigator.prototype, 'mimeTypes', () => pluginData.mimeTypes)

  const chromeVersion = String(profile.uaVersion || '124')
  const chromeFullVersion = profile.uaFullVersion || `${chromeVersion}.0.0.0`
  const brands = [
    { brand: 'Google Chrome', version: chromeVersion },
    { brand: 'Chromium', version: chromeVersion },
    { brand: 'Not-A.Brand', version: '99' },
  ]
  defineGetter(Navigator.prototype, 'userAgentData', () => ({
    brands,
    mobile: profile.mobile,
    platform: profile.platformLabel,
    getHighEntropyValues: async () => ({
      architecture: profile.architecture || (profile.mobile ? 'arm' : 'x86'),
      bitness: profile.bitness || '64',
      brands,
      fullVersionList: [{ brand: 'Google Chrome', version: chromeFullVersion }],
      mobile: profile.mobile,
      model: profile.deviceModel || '',
      platform: profile.platformLabel,
      platformVersion: profile.platformVersion || (profile.mobile ? '14.0.0' : '10.0.0'),
      uaFullVersion: chromeFullVersion,
    }),
  }))

  // ── Connection ───────────────────────────────────────────────────────────────
  const connection = {
    effectiveType: profile.connection.effectiveType,
    downlink: profile.connection.downlink,
    rtt: profile.connection.rtt,
    saveData: profile.connection.saveData,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return false },
  }
  defineGetter(Navigator.prototype, 'connection', () => connection)

  // ── Screen and viewport ──────────────────────────────────────────────────────
  defineGetter(Screen.prototype, 'width', () => profile.screen.width)
  defineGetter(Screen.prototype, 'height', () => profile.screen.height)
  defineGetter(Screen.prototype, 'availWidth', () => profile.screen.availWidth)
  defineGetter(Screen.prototype, 'availHeight', () => profile.screen.availHeight)
  defineGetter(Screen.prototype, 'colorDepth', () => profile.colorDepth)
  defineGetter(Screen.prototype, 'pixelDepth', () => profile.pixelDepth)
  defineGetter(window, 'innerWidth', () => profile.screen.innerWidth)
  defineGetter(window, 'innerHeight', () => profile.screen.innerHeight)
  defineGetter(window, 'outerWidth', () => profile.screen.width)
  defineGetter(window, 'outerHeight', () => profile.screen.height)

  // devicePixelRatio — match persona. Mobile Android flagships: 2.625–3.5;
  // budget Androids: 1.5–2.0; Windows desktop: 1.0–1.5; macOS retina: 2.0.
  const dprByPersona = {
    desktop: 1.0,
    mac: 2.0,
    linux: 1.0,
    mobile: 2.625,
    mixed: profile.mobile ? 2.0 : 1.0,
  }
  const targetDPR = dprByPersona[profile.persona] ?? (profile.mobile ? 2.0 : 1.0)
  defineGetter(window, 'devicePixelRatio', () => targetDPR)

  // visualViewport — keep integer on desktop, fractional DPR handled by ratio above.
  // Fractional visualViewport.height leaks DPR when innerHeight is integer, so we
  // clamp to a whole number consistent with spoofed DPR.
  if (window.visualViewport) {
    defineGetter(window.visualViewport, 'width', () => profile.screen.innerWidth)
    defineGetter(window.visualViewport, 'height', () => profile.screen.innerHeight)
    defineGetter(window.visualViewport, 'scale', () => 1)
    defineGetter(window.visualViewport, 'offsetTop', () => 0)
    defineGetter(window.visualViewport, 'offsetLeft', () => 0)
    defineGetter(window.visualViewport, 'pageTop', () => 0)
    defineGetter(window.visualViewport, 'pageLeft', () => 0)
  }

  // ── Scrollbar width ──────────────────────────────────────────────────────────
  // Windows: ~15px, Android: 0px (overlay scrollbars). We inject a style rule.
  // Detection reads scrollWidth delta of a hidden div, so we need the UA-level
  // scrollbar width to match. Override via CSS only affects layout, not the JS
  // measurement — but the JS measurement reads offsetWidth vs scrollWidth of a
  // temp element, which IS affected by ::-webkit-scrollbar CSS overrides.
  try {
    const scrollbarCSS = document.createElement('style')
    const sbWidth = profile.mobile ? '0px' : '15px'
    scrollbarCSS.textContent = profile.mobile
      ? '::-webkit-scrollbar { display: none !important; width: 0 !important; }'
      : '::-webkit-scrollbar { width: 15px !important; }'
    scrollbarCSS.setAttribute('data-peermesh', '1')
    ;(document.head || document.documentElement).appendChild(scrollbarCSS)
  } catch {}

  // ── WebRTC - relay only, no IP leak ─────────────────────────────────────────
  const NativeRTCPeerConnection = window.RTCPeerConnection
  if (NativeRTCPeerConnection) {
    window.RTCPeerConnection = function RTCPeerConnection(config = {}) {
      const safeConfig = { ...config }
      safeConfig.iceTransportPolicy = 'relay'
      safeConfig.iceServers = (safeConfig.iceServers || []).filter(server =>
        [].concat(server.urls).some(url => String(url).startsWith('turn:') || String(url).startsWith('turns:'))
      )
      return new NativeRTCPeerConnection(safeConfig)
    }
    window.RTCPeerConnection.prototype = NativeRTCPeerConnection.prototype
  }

  // ── Canvas + font metrics ────────────────────────────────────────────────────
  // FIX #1: Replace Proxy-based measureText with a plain object that copies all
  // TextMetrics properties directly. Proxy construction is detectable via
  // toString / instanceof checks and via the Proxy trap reflection API.
  const nativeGetImageData = CanvasRenderingContext2D.prototype.getImageData
  const nativeToDataURL = HTMLCanvasElement.prototype.toDataURL
  const nativeToBlob = HTMLCanvasElement.prototype.toBlob
  const nativeMeasureText = CanvasRenderingContext2D.prototype.measureText

  // All TextMetrics properties as of Chrome 120+
  const TEXT_METRICS_KEYS = [
    'width',
    'actualBoundingBoxLeft', 'actualBoundingBoxRight',
    'actualBoundingBoxAscent', 'actualBoundingBoxDescent',
    'fontBoundingBoxAscent', 'fontBoundingBoxDescent',
    'emHeightAscent', 'emHeightDescent',
    'hangingBaseline', 'alphabeticBaseline', 'ideographicBaseline',
  ]

  function applyCanvasNoise(data) {
    for (let i = 0; i < data.length; i += 4) {
      const delta = ((seed + i) % 3) - 1
      data[i] = Math.max(0, Math.min(255, data[i] + delta))
      data[i + 1] = Math.max(0, Math.min(255, data[i + 1] - delta))
    }
  }

  function mutateCanvas(canvas, callback, args) {
    const ctx = canvas.getContext && canvas.getContext('2d')
    if (ctx && canvas.width && canvas.height) {
      try {
        const image = nativeGetImageData.call(ctx, 0, 0, canvas.width, canvas.height)
        applyCanvasNoise(image.data)
        ctx.putImageData(image, 0, 0)
      } catch {}
    }
    return callback.apply(canvas, args)
  }

  HTMLCanvasElement.prototype.toDataURL = function toDataURL(...args) {
    return mutateCanvas(this, nativeToDataURL, args)
  }

  HTMLCanvasElement.prototype.toBlob = function toBlob(callback, ...args) {
    return mutateCanvas(this, nativeToBlob, [callback, ...args])
  }

  CanvasRenderingContext2D.prototype.measureText = function measureText(text) {
    const real = nativeMeasureText.call(this, text)
    const offset = seededOffset(String(text).length, 3)
    // Build a plain object — no Proxy, no class wrapper, just enumerable own
    // properties that shadow the prototype chain. toString() is unchanged,
    // instanceof TextMetrics still returns false (same as before), but
    // crucially window.Proxy is never invoked so proxy-detection scripts
    // that hook Proxy construction or check handler traps find nothing.
    const out = Object.create(null)
    for (const key of TEXT_METRICS_KEYS) {
      const val = real[key]
      if (typeof val === 'number') {
        out[key] = key === 'width' ? val + offset : val
      }
    }
    return out
  }

  // ── Geolocation ──────────────────────────────────────────────────────────────
  if (navigator.geolocation) {
    function fakePosition(success) {
      const accuracy = 20 + ((seed % 80))
      const latJitter = (((seed * 7) % 100) - 50) / 10000
      const lonJitter = (((seed * 13) % 100) - 50) / 10000
      success({
        coords: {
          latitude: profile.lat + latJitter,
          longitude: profile.lon + lonJitter,
          accuracy,
          altitude: null,
          altitudeAccuracy: null,
          heading: null,
          speed: null,
        },
        timestamp: Date.now(),
      })
    }
    Object.defineProperty(navigator, 'geolocation', {
      get: () => ({
        getCurrentPosition: (success, error, opts) => fakePosition(success),
        watchPosition: (success, error, opts) => { fakePosition(success); return 0 },
        clearWatch: () => {},
      }),
      configurable: true,
    })
  }

  // ── Screen orientation ───────────────────────────────────────────────────────
  if (window.screen?.orientation) {
    const orientationType = profile.mobile ? 'portrait-primary' : 'landscape-primary'
    try {
      Object.defineProperty(window.screen, 'orientation', {
        get: () => ({
          type: orientationType,
          angle: 0,
          onchange: null,
          addEventListener() {},
          removeEventListener() {},
          dispatchEvent() { return false },
          lock: () => Promise.reject(new DOMException('Not supported')),
          unlock: () => {},
        }),
        configurable: true,
      })
    } catch {}
  }

  // ── Audio fingerprinting ─────────────────────────────────────────────────────
  const NativeAudioContext = window.AudioContext || window.webkitAudioContext
  const NativeOfflineAudioContext = window.OfflineAudioContext || window.webkitOfflineAudioContext
  const NativeGetChannelData = AudioBuffer.prototype.getChannelData

  // maxChannelCount — real hardware value leaks (e.g. 1 for extension sandbox).
  // Spoof destination.maxChannelCount on every new context.
  const spoofedMaxChannelCount = profile.mobile ? 2 : 8

  function patchAudioContext(ContextCtor) {
    if (!ContextCtor) return ContextCtor
    function WrappedAudioContext(...args) {
      const ctx = new ContextCtor(...args)
      try {
        defineGetter(ctx, 'sampleRate', () => profile.sampleRate)
      } catch {}
      try {
        if (ctx.destination) {
          defineGetter(ctx.destination, 'maxChannelCount', () => spoofedMaxChannelCount)
          defineGetter(ctx.destination, 'channelCount', () => Math.min(2, spoofedMaxChannelCount))
        }
      } catch {}
      return ctx
    }
    WrappedAudioContext.prototype = ContextCtor.prototype
    return WrappedAudioContext
  }

  if (NativeAudioContext) {
    window.AudioContext = patchAudioContext(NativeAudioContext)
    if (window.webkitAudioContext) window.webkitAudioContext = window.AudioContext
  }
  if (NativeOfflineAudioContext) {
    window.OfflineAudioContext = patchAudioContext(NativeOfflineAudioContext)
    if (window.webkitOfflineAudioContext) window.webkitOfflineAudioContext = window.OfflineAudioContext
  }

  AudioBuffer.prototype.getChannelData = function getChannelData(channel) {
    const data = NativeGetChannelData.call(this, channel)
    const copy = new Float32Array(data.length)
    copy.set(data)
    for (let i = 0; i < copy.length; i += 128) {
      copy[i] = copy[i] + deterministicNoise(i + channel, 0.00002)
    }
    return copy
  }

  // ── Speech synthesis voice count ─────────────────────────────────────────────
  // Mobile Africa: 0 voices (TTS engine not loaded). Desktop: keep real voices.
  // getVoices() is async-ish — it returns [] until the voiceschanged event fires,
  // so we spoof both the synchronous return and suppress the event on mobile.
  if (window.speechSynthesis && profile.mobile) {
    defineGetter(window, 'speechSynthesis', () => ({
      speak() {},
      cancel() {},
      pause() {},
      resume() {},
      pending: false,
      speaking: false,
      paused: false,
      getVoices: () => [],
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() { return false },
      onvoiceschanged: null,
    }))
  }

  // ── WebGL vendor / renderer ──────────────────────────────────────────────────
  // Spoof UNMASKED_VENDOR_WEBGL and UNMASKED_RENDERER_WEBGL so the real GPU
  // (e.g. Intel HD 620) doesn't show through.
  const GL_VENDOR_SPOOF   = profile.mobile ? 'ARM'            : 'Google Inc. (Intel)'
  const GL_RENDERER_SPOOF = profile.mobile
    ? 'Mali-G57 MC2'
    : 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)'

  function patchGetParameter(ctx) {
    if (!ctx) return
    const native = ctx.getParameter.bind(ctx)
    ctx.getParameter = function getParameter(pname) {
      const ext = ctx.getExtension('WEBGL_debug_renderer_info')
      if (ext) {
        if (pname === ext.UNMASKED_VENDOR_WEBGL)   return GL_VENDOR_SPOOF
        if (pname === ext.UNMASKED_RENDERER_WEBGL) return GL_RENDERER_SPOOF
      }
      return native(pname)
    }
  }

  const nativeGetContext = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function getContext(type, ...args) {
    const ctx = nativeGetContext.call(this, type, ...args)
    if (ctx && (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl')) {
      patchGetParameter(ctx)
    }
    return ctx
  }

  // ── performance.now() clamping ───────────────────────────────────────────────
  // Reduce timer resolution to ~1ms to prevent cross-origin timing attacks and
  // to match the precision of a typical mid-range Android (which has unclamped
  // timers but fingerprinters detect sub-100µs precision as a non-mobile flag).
  const nativePerfNow = Performance.prototype.now
  Performance.prototype.now = function now() {
    return Math.floor(nativePerfNow.call(this) * 1) / 1
  }

  // ── prefers-color-scheme ─────────────────────────────────────────────────────
  // Spoof matchMedia so colour-scheme queries reflect the spoofed persona.
  // Most mid-range Android users run light mode; desktop users are mixed —
  // we pick light for mobile personas, pass through for desktop.
  if (profile.mobile) {
    const nativeMatchMedia = window.matchMedia.bind(window)
    window.matchMedia = function matchMedia(query) {
      const mql = nativeMatchMedia(query)
      // Override only the prefers-color-scheme: dark check
      if (/prefers-color-scheme\s*:\s*dark/.test(query)) {
        return Object.assign(Object.create(MediaQueryList.prototype), {
          matches: false,
          media: query,
          onchange: null,
          addListener() {},
          removeListener() {},
          addEventListener() {},
          removeEventListener() {},
          dispatchEvent() { return false },
        })
      }
      return mql
    }
  }

  // ── Battery API ──────────────────────────────────────────────────────────────
  // Return a stable non-"loading" battery state consistent with a plugged-in
  // desktop or a mobile that's > 50% charged.
  if (navigator.getBattery) {
    const fakeBattery = {
      charging: !profile.mobile,       // desktop: always charging; mobile: on battery
      chargingTime: profile.mobile ? Infinity : 0,
      dischargingTime: profile.mobile ? 18000 : Infinity, // ~5 hours remaining on mobile
      level: profile.mobile ? 0.72 : 1.0,
      onchargingchange: null,
      onchargingtimechange: null,
      ondischargingtimechange: null,
      onlevelchange: null,
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() { return false },
    }
    navigator.getBattery = () => Promise.resolve(fakeBattery)
  }

  // ── mediaDevices.enumerateDevices ────────────────────────────────────────────
  // Real desktop: camera + mic + speaker show real device labels after permission.
  // Spoof to match typical persona: mobile = front+rear camera, 1 mic, 1 speaker;
  // desktop = 1 webcam, 1 mic, 1 speaker. Labels are empty until permission granted
  // (standard browser behaviour) so we only spoof the count/kind list.
  if (navigator.mediaDevices?.enumerateDevices) {
    const nativeEnumerate = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices)
    navigator.mediaDevices.enumerateDevices = function enumerateDevices() {
      return nativeEnumerate().then(realDevices => {
        // Build a realistic device list for the persona
        const devices = []
        if (profile.mobile) {
          devices.push(
            { kind: 'videoinput',  label: '', deviceId: 'front', groupId: 'g1' },
            { kind: 'videoinput',  label: '', deviceId: 'rear',  groupId: 'g2' },
            { kind: 'audioinput',  label: '', deviceId: 'mic0',  groupId: 'g1' },
            { kind: 'audiooutput', label: '', deviceId: 'spk0',  groupId: 'g1' },
          )
        } else {
          devices.push(
            { kind: 'videoinput',  label: '', deviceId: 'cam0',  groupId: 'g1' },
            { kind: 'audioinput',  label: '', deviceId: 'mic0',  groupId: 'g1' },
            { kind: 'audiooutput', label: '', deviceId: 'spk0',  groupId: 'g1' },
            { kind: 'audiooutput', label: '', deviceId: 'spk1',  groupId: 'g2' }, // headset
          )
        }
        return devices
      })
    }
  }

  // ── window.location bar visibility ──────────────────────────────────────────
  // Extensions run in a context where window.locationbar.visible can be false.
  // Spoof to true to match a normal browser window.
  try {
    const bars = ['locationbar', 'menubar', 'personalbar', 'scrollbars', 'statusbar', 'toolbar']
    for (const bar of bars) {
      if (window[bar] && typeof window[bar] === 'object') {
        defineGetter(window[bar], 'visible', () => true)
      }
    }
  } catch {}

  // ── WebAssembly capability flags ─────────────────────────────────────────────
  // SIMD/Threads/BulkMemory presence is detected by probing WebAssembly.validate().
  // We cannot undefine WebAssembly (too many sites use it), but we can stub
  // validate() to return false for feature-probe modules for desktop-only features
  // when spoofing a mobile persona that wouldn't have them. This is only applied
  // when the persona is mobile, where SIMD support is less consistent.
  // NOTE: This is a best-effort spoof; determined fingerprinters can work around it.
  if (profile.mobile && WebAssembly?.validate) {
    const nativeValidate = WebAssembly.validate.bind(WebAssembly)
    WebAssembly.validate = function validate(buffer) {
      try {
        const bytes = new Uint8Array(buffer)
        // SIMD feature probe starts with wasm magic + simd opcode marker 0xFD
        // Threads probe uses shared memory (atomics) 0x00 0x62 in the type section
        // We detect small probe modules (< 64 bytes) and return false for them
        // to simulate missing SIMD/Threads/BulkMemory.
        if (bytes.length < 64) return false
        return nativeValidate(buffer)
      } catch {
        return false
      }
    }
  }

})()