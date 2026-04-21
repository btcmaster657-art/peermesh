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

  const seedSource = `${profile.country}:${profile.tz}:${profile.platform}:${profile.userAgent}`
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

  // Timezone
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
  Date.prototype.getTimezoneOffset = function getTimezoneOffset() {
    return tzOffset
  }

  // Navigator identity
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

  // Connection
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

  // Screen and viewport
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

  // WebRTC - relay only
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

  // Canvas + font metrics
  const nativeGetImageData = CanvasRenderingContext2D.prototype.getImageData
  const nativeToDataURL = HTMLCanvasElement.prototype.toDataURL
  const nativeToBlob = HTMLCanvasElement.prototype.toBlob
  const nativeMeasureText = CanvasRenderingContext2D.prototype.measureText

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
    const metrics = nativeMeasureText.call(this, text)
    const width = metrics.width + seededOffset(String(text).length, 3)
    return new Proxy(metrics, {
      get(target, property) {
        if (property === 'width') return width
        return Reflect.get(target, property)
      },
    })
  }

  // Geolocation — return coords near provider's country capital
  if (navigator.geolocation) {
    const nativeGetCurrentPosition = navigator.geolocation.getCurrentPosition.bind(navigator.geolocation)
    const nativeWatchPosition = navigator.geolocation.watchPosition.bind(navigator.geolocation)
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

  // Screen orientation — mobile personas report portrait
  if (window.screen?.orientation) {
    const orientationType = profile.mobile ? 'portrait-primary' : 'landscape-primary'
    const orientationAngle = profile.mobile ? 0 : 0
    try {
      Object.defineProperty(window.screen, 'orientation', {
        get: () => ({
          type: orientationType,
          angle: orientationAngle,
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

  // Audio fingerprinting
  const NativeAudioContext = window.AudioContext || window.webkitAudioContext
  const NativeOfflineAudioContext = window.OfflineAudioContext || window.webkitOfflineAudioContext
  const NativeGetChannelData = AudioBuffer.prototype.getChannelData

  function patchAudioContext(ContextCtor) {
    if (!ContextCtor) return ContextCtor
    function WrappedAudioContext(...args) {
      const ctx = new ContextCtor(...args)
      try {
        defineGetter(ctx, 'sampleRate', () => profile.sampleRate)
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
})()
