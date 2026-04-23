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
  try { profile = JSON.parse(rawProfile) } catch { return }

  // ── Seed ────────────────────────────────────────────────────────────────────
  const seedSource = `${profile.userId || ''}:${profile.country}:${profile.tz}:${profile.platform}:${profile.userAgent}`
  const seed = Array.from(seedSource).reduce((sum, char, i) => sum + char.charCodeAt(0) * (i + 1), 0)

  // ── Helpers ─────────────────────────────────────────────────────────────────
  function defineGetter(target, prop, getter) {
    try { Object.defineProperty(target, prop, { get: getter, configurable: true }) } catch {}
  }
  function seededOffset(value, spread) {
    return ((((seed * (value + 3)) % (spread * 2 + 1)) - spread) || 0) / 1000
  }
  function deterministicNoise(index, scale) {
    return ((((seed + index * 17) % 11) - 5) / 5) * scale
  }

  // ── Plugins ─────────────────────────────────────────────────────────────────
  function makePluginArray() {
    const pdf0 = { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' }
    const pdfPlugin = {
      name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer',
      description: 'Portable Document Format', length: 1, 0: pdf0,
      item(i) { return this[i] ?? null }, namedItem(n) { return n === 'application/pdf' ? this[0] : null },
    }
    const plugins = {
      0: pdfPlugin, length: 1,
      item(i) { return this[i] ?? null }, namedItem(n) { return n === 'Chrome PDF Viewer' ? this[0] : null },
      refresh() {}, [Symbol.iterator]: function* () { yield this[0] },
    }
    const mimeTypes = {
      0: pdf0, length: 1,
      item(i) { return this[i] ?? null }, namedItem(n) { return n === 'application/pdf' ? this[0] : null },
      [Symbol.iterator]: function* () { yield this[0] },
    }
    return { plugins, mimeTypes }
  }
  const pluginData = makePluginArray()

  // ── Timezone ─────────────────────────────────────────────────────────────────
  const NativeDTF = Intl.DateTimeFormat
  Intl.DateTimeFormat = function DateTimeFormat(locales, options = {}) {
    return new NativeDTF(locales, { ...options, timeZone: options.timeZone || profile.tz })
  }
  Intl.DateTimeFormat.prototype = NativeDTF.prototype
  Intl.DateTimeFormat.supportedLocalesOf = NativeDTF.supportedLocalesOf.bind(NativeDTF)

  const tzOffset = (() => {
    try {
      const now = new Date()
      const utc  = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }))
      const peer = new Date(now.toLocaleString('en-US', { timeZone: profile.tz }))
      return (utc - peer) / 60000
    } catch { return 0 }
  })()
  Date.prototype.getTimezoneOffset = function () { return tzOffset }

  // ── Navigator extras ─────────────────────────────────────────────────────────
  defineGetter(Navigator.prototype, 'pdfViewerEnabled', () => true)
  defineGetter(Navigator.prototype, 'cookieEnabled',    () => true)
  defineGetter(Navigator.prototype, 'onLine',           () => true)
  defineGetter(Navigator.prototype, 'webdriver',        () => false)
  defineGetter(Navigator.prototype, 'javaEnabled',      () => () => false)

  // ── Intl / Locale ────────────────────────────────────────────────────────────
  const NativeNF = Intl.NumberFormat
  Intl.NumberFormat = function NumberFormat(locales, options) {
    return new NativeNF(locales || profile.lang, options)
  }
  Intl.NumberFormat.prototype = NativeNF.prototype
  Intl.NumberFormat.supportedLocalesOf = NativeNF.supportedLocalesOf.bind(NativeNF)
  const _nfRO = Intl.NumberFormat.prototype.resolvedOptions
  Intl.NumberFormat.prototype.resolvedOptions = function () {
    const o = _nfRO.call(this); o.locale = profile.lang; return o
  }
  ;['PluralRules','RelativeTimeFormat','Collator','ListFormat','Segmenter'].forEach(name => {
    const N = Intl[name]; if (!N) return
    Intl[name] = function (l, o) { return new N(l || profile.lang, o) }
    Intl[name].prototype = N.prototype
  })

  // ── Navigator ────────────────────────────────────────────────────────────────
  defineGetter(Navigator.prototype, 'language',            () => profile.lang)
  defineGetter(Navigator.prototype, 'languages',           () => [profile.lang, profile.lang.split('-')[0]])
  defineGetter(Navigator.prototype, 'userAgent',           () => profile.userAgent)
  defineGetter(Navigator.prototype, 'appVersion',          () => profile.userAgent.replace(/^Mozilla\/\S+\s/, ''))
  defineGetter(Navigator.prototype, 'platform',            () => profile.platform)
  defineGetter(Navigator.prototype, 'vendor',              () => 'Google Inc.')
  defineGetter(Navigator.prototype, 'hardwareConcurrency', () => profile.hardwareConcurrency)
  defineGetter(Navigator.prototype, 'deviceMemory',        () => profile.deviceMemory)
  defineGetter(Navigator.prototype, 'maxTouchPoints',      () => profile.maxTouchPoints)
  defineGetter(Navigator.prototype, 'plugins',             () => pluginData.plugins)
  defineGetter(Navigator.prototype, 'mimeTypes',           () => pluginData.mimeTypes)
  defineGetter(Navigator.prototype, 'doNotTrack',          () => null)

  const chromeVersion = String(profile.uaVersion || '124')
  const chromeFullVersion = profile.uaFullVersion || `${chromeVersion}.0.0.0`
  const brands = [
    { brand: 'Google Chrome', version: chromeVersion },
    { brand: 'Chromium',      version: chromeVersion },
    { brand: 'Not-A.Brand',   version: '99' },
  ]
  defineGetter(Navigator.prototype, 'userAgentData', () => ({
    brands, mobile: profile.mobile, platform: profile.platformLabel,
    getHighEntropyValues: async () => ({
      architecture: profile.architecture || (profile.mobile ? 'arm' : 'x86'),
      bitness: profile.bitness || '64', brands,
      fullVersionList: [{ brand: 'Google Chrome', version: chromeFullVersion }],
      mobile: profile.mobile, model: profile.deviceModel || '',
      platform: profile.platformLabel,
      platformVersion: profile.platformVersion || (profile.mobile ? '14.0.0' : '10.0.0'),
      uaFullVersion: chromeFullVersion,
    }),
  }))

  const connObj = {
    effectiveType: profile.connection.effectiveType, downlink: profile.connection.downlink,
    rtt: profile.connection.rtt, saveData: profile.connection.saveData,
    onchange: null, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false },
  }
  defineGetter(Navigator.prototype, 'connection', () => connObj)

  // ── Screen & Viewport ────────────────────────────────────────────────────────
  defineGetter(Screen.prototype, 'width',       () => profile.screen.width)
  defineGetter(Screen.prototype, 'height',      () => profile.screen.height)
  defineGetter(Screen.prototype, 'availWidth',  () => profile.screen.availWidth)
  defineGetter(Screen.prototype, 'availHeight', () => profile.screen.availHeight)
  defineGetter(Screen.prototype, 'colorDepth',  () => profile.colorDepth)
  defineGetter(Screen.prototype, 'pixelDepth',  () => profile.pixelDepth)
  defineGetter(window, 'innerWidth',  () => profile.screen.innerWidth)
  defineGetter(window, 'innerHeight', () => profile.screen.innerHeight)
  defineGetter(window, 'outerWidth',  () => profile.screen.width)
  defineGetter(window, 'outerHeight', () => profile.screen.height)

  const dprMap = { desktop: 1.0, mac: 2.0, linux: 1.0, mobile: 2.625, mixed: profile.mobile ? 2.0 : 1.0 }
  defineGetter(window, 'devicePixelRatio', () => dprMap[profile.persona] ?? (profile.mobile ? 2.0 : 1.0))

  if (window.visualViewport) {
    const vvp = window.visualViewport
    defineGetter(vvp, 'width',  () => profile.screen.innerWidth)
    defineGetter(vvp, 'height', () => profile.screen.innerHeight)
    defineGetter(vvp, 'scale',  () => 1)
    defineGetter(vvp, 'offsetTop', () => 0); defineGetter(vvp, 'offsetLeft', () => 0)
    defineGetter(vvp, 'pageTop',   () => 0); defineGetter(vvp, 'pageLeft',   () => 0)
  }

  try {
    const s = document.createElement('style')
    s.setAttribute('data-peermesh', '1')
    s.textContent = profile.mobile
      ? '::-webkit-scrollbar{display:none!important;width:0!important}'
      : '::-webkit-scrollbar{width:15px!important}'
    ;(document.head || document.documentElement).appendChild(s)
  } catch {}

  // ── WebRTC ────────────────────────────────────────────────────────────────────
  const NativeRTC = window.RTCPeerConnection
  if (NativeRTC) {
    window.RTCPeerConnection = function RTCPeerConnection(config = {}) {
      const c = { ...config, iceTransportPolicy: 'relay' }
      c.iceServers = (c.iceServers || []).filter(s => [].concat(s.urls).some(u => /^turns?:/.test(String(u))))
      return new NativeRTC(c)
    }
    window.RTCPeerConnection.prototype = NativeRTC.prototype
  }

  // ── Canvas ────────────────────────────────────────────────────────────────────
  const _getImageData = CanvasRenderingContext2D.prototype.getImageData
  const _toDataURL    = HTMLCanvasElement.prototype.toDataURL
  const _toBlob       = HTMLCanvasElement.prototype.toBlob
  const _measureText  = CanvasRenderingContext2D.prototype.measureText

  const TM_KEYS = [
    'width','actualBoundingBoxLeft','actualBoundingBoxRight',
    'actualBoundingBoxAscent','actualBoundingBoxDescent',
    'fontBoundingBoxAscent','fontBoundingBoxDescent',
    'emHeightAscent','emHeightDescent',
    'hangingBaseline','alphabeticBaseline','ideographicBaseline',
  ]

  function noiseCanvas(canvas, fn, args) {
    const ctx = canvas.getContext && canvas.getContext('2d')
    if (ctx && canvas.width > 0 && canvas.height > 0) {
      try {
        const img = _getImageData.call(ctx, 0, 0, canvas.width, canvas.height)
        for (let i = 0; i < img.data.length; i += 4) {
          const d = ((seed + i) % 3) - 1
          img.data[i]   = Math.max(0, Math.min(255, img.data[i]   + d))
          img.data[i+1] = Math.max(0, Math.min(255, img.data[i+1] - d))
        }
        ctx.putImageData(img, 0, 0)
      } catch {}
    }
    return fn.apply(canvas, args)
  }

  HTMLCanvasElement.prototype.toDataURL = function (...a)     { return noiseCanvas(this, _toDataURL, a) }
  HTMLCanvasElement.prototype.toBlob    = function (cb, ...a) { return noiseCanvas(this, _toBlob, [cb, ...a]) }
  CanvasRenderingContext2D.prototype.measureText = function (text) {
    const real = _measureText.call(this, text), offset = seededOffset(String(text).length, 3)
    const out  = Object.create(null)
    for (const key of TM_KEYS) {
      const v = real[key]
      if (typeof v === 'number') out[key] = key === 'width' ? v + offset : v
    }
    return out
  }

  // ── Geolocation ───────────────────────────────────────────────────────────────
  if (navigator.geolocation) {
    function fakePos(ok) {
      ok({ coords: {
        latitude:  profile.lat + (((seed * 7)  % 100) - 50) / 10000,
        longitude: profile.lon + (((seed * 13) % 100) - 50) / 10000,
        accuracy:  20 + (seed % 80),
        altitude: null, altitudeAccuracy: null, heading: null, speed: null,
      }, timestamp: Date.now() })
    }
    Object.defineProperty(navigator, 'geolocation', {
      get: () => ({ getCurrentPosition: ok => fakePos(ok), watchPosition: ok => { fakePos(ok); return 0 }, clearWatch: () => {} }),
      configurable: true,
    })
  }

  // ── Orientation ──────────────────────────────────────────────────────────────
  if (window.screen?.orientation) {
    try {
      Object.defineProperty(window.screen, 'orientation', {
        get: () => ({
          type: profile.mobile ? 'portrait-primary' : 'landscape-primary', angle: 0, onchange: null,
          addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false },
          lock: () => Promise.reject(new DOMException('Not supported')), unlock: () => {},
        }),
        configurable: true,
      })
    } catch {}
  }

  // ── Audio ─────────────────────────────────────────────────────────────────────
  const _AudioCtx   = window.AudioContext        || window.webkitAudioContext
  const _OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext
  const _getChanData = AudioBuffer.prototype.getChannelData
  const spoofedMaxCh = profile.mobile ? 2 : 8

  function wrapAudioCtx(Ctor) {
    if (!Ctor) return Ctor
    function W(...args) {
      const ctx = new Ctor(...args)
      try { defineGetter(ctx, 'sampleRate', () => profile.sampleRate) } catch {}
      try {
        if (ctx.destination) {
          defineGetter(ctx.destination, 'maxChannelCount', () => spoofedMaxCh)
          defineGetter(ctx.destination, 'channelCount',    () => Math.min(2, spoofedMaxCh))
        }
      } catch {}
      return ctx
    }
    W.prototype = Ctor.prototype; return W
  }
  if (_AudioCtx)   { window.AudioContext = wrapAudioCtx(_AudioCtx); if (window.webkitAudioContext) window.webkitAudioContext = window.AudioContext }
  if (_OfflineCtx) { window.OfflineAudioContext = wrapAudioCtx(_OfflineCtx); if (window.webkitOfflineAudioContext) window.webkitOfflineAudioContext = window.OfflineAudioContext }

  AudioBuffer.prototype.getChannelData = function (ch) {
    const data = _getChanData.call(this, ch), copy = new Float32Array(data.length)
    copy.set(data)
    for (let i = 0; i < copy.length; i += 128) copy[i] += deterministicNoise(i + ch, 0.00002)
    return copy
  }

  // ── Speech synthesis ──────────────────────────────────────────────────────────
  if (window.speechSynthesis && profile.mobile) {
    defineGetter(window, 'speechSynthesis', () => ({
      speak() {}, cancel() {}, pause() {}, resume() {},
      pending: false, speaking: false, paused: false, getVoices: () => [],
      onvoiceschanged: null, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false },
    }))
  }

  // ── WebGL ─────────────────────────────────────────────────────────────────────
  const GL_VENDOR   = profile.mobile ? 'ARM' : 'Google Inc. (Intel)'
  const GL_RENDERER = profile.mobile ? 'Mali-G57 MC2'
    : 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)'
  const _getCtx = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function (type, ...args) {
    const ctx = _getCtx.call(this, type, ...args)
    if (ctx && /^webgl/.test(type)) {
      const _gp = ctx.getParameter.bind(ctx)
      ctx.getParameter = function (p) {
        const ext = ctx.getExtension('WEBGL_debug_renderer_info')
        if (ext) {
          if (p === ext.UNMASKED_VENDOR_WEBGL)   return GL_VENDOR
          if (p === ext.UNMASKED_RENDERER_WEBGL) return GL_RENDERER
        }
        return _gp(p)
      }
    }
    return ctx
  }

  // ── Performance ───────────────────────────────────────────────────────────────
  const _perfNow = Performance.prototype.now
  Performance.prototype.now = function () { return Math.floor(_perfNow.call(this)) }

  // ── prefers-color-scheme ──────────────────────────────────────────────────────
  // FIX: Return the REAL MediaQueryList from native matchMedia, then shadow the
  // `matches` getter on THAT INSTANCE via Object.defineProperty.
  // This preserves the full MQL prototype chain (EventTarget, addEventListener,
  // etc.) so Polymer / YouTube custom-elements bootstrap never crashes.
  // The old Object.create(null) approach broke YouTube because Polymer tried to
  // assign to `.matches` and EventTarget checks failed on a null-prototype object.
  if (profile.mobile) {
    const _matchMedia = window.matchMedia.bind(window)
    window.matchMedia = function matchMedia(query) {
      const mql = _matchMedia(query)
      if (/prefers-color-scheme\s*:\s*dark/i.test(query)) {
        try {
          // Shadow on the instance only — prototype and all other MQL objects untouched.
          Object.defineProperty(mql, 'matches', { get: () => false, set() {}, configurable: true })
        } catch {}
      }
      return mql
    }
  }

  // ── Battery ───────────────────────────────────────────────────────────────────
  if (navigator.getBattery) {
    const fakeBattery = {
      charging: !profile.mobile, chargingTime: profile.mobile ? Infinity : 0,
      dischargingTime: profile.mobile ? 18000 : Infinity, level: profile.mobile ? 0.72 : 1.0,
      onchargingchange: null, onchargingtimechange: null,
      ondischargingtimechange: null, onlevelchange: null,
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false },
    }
    navigator.getBattery = () => Promise.resolve(fakeBattery)
  }

  // ── enumerateDevices ─────────────────────────────────────────────────────────
  if (navigator.mediaDevices?.enumerateDevices) {
    const _enum = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices)
    navigator.mediaDevices.enumerateDevices = function () {
      return _enum().then(() => profile.mobile
        ? [
            { kind: 'videoinput',  label: '', deviceId: 'front', groupId: 'g1' },
            { kind: 'videoinput',  label: '', deviceId: 'rear',  groupId: 'g2' },
            { kind: 'audioinput',  label: '', deviceId: 'mic0',  groupId: 'g1' },
            { kind: 'audiooutput', label: '', deviceId: 'spk0',  groupId: 'g1' },
          ]
        : [
            { kind: 'videoinput',  label: '', deviceId: 'cam0', groupId: 'g1' },
            { kind: 'audioinput',  label: '', deviceId: 'mic0', groupId: 'g1' },
            { kind: 'audiooutput', label: '', deviceId: 'spk0', groupId: 'g1' },
            { kind: 'audiooutput', label: '', deviceId: 'spk1', groupId: 'g2' },
          ]
      )
    }
  }

  // ── Location bars ─────────────────────────────────────────────────────────────
  try {
    for (const bar of ['locationbar','menubar','personalbar','scrollbars','statusbar','toolbar']) {
      if (window[bar] && typeof window[bar] === 'object') defineGetter(window[bar], 'visible', () => true)
    }
  } catch {}

  // ── WebAssembly probe blocking ────────────────────────────────────────────────
  if (profile.mobile && WebAssembly?.validate) {
    const _validate = WebAssembly.validate.bind(WebAssembly)
    WebAssembly.validate = function (buf) {
      try { if (new Uint8Array(buf).length < 64) return false } catch {}
      return _validate(buf)
    }
  }

})()