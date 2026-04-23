// identity.js - runs in the page's main world.

const PROFILE_ATTR = 'data-peermesh-profile'
const PROFILE_EVENT = 'peermesh:profile'
const APPLIED_FLAG = '__PEERMESH_IDENTITY_APPLIED__'
const TEXT_METRIC_KEYS = [
  'width',
  'actualBoundingBoxLeft',
  'actualBoundingBoxRight',
  'actualBoundingBoxAscent',
  'actualBoundingBoxDescent',
  'fontBoundingBoxAscent',
  'fontBoundingBoxDescent',
  'emHeightAscent',
  'emHeightDescent',
  'hangingBaseline',
  'alphabeticBaseline',
  'ideographicBaseline',
]
const LOCATION_BAR_KEYS = ['locationbar', 'menubar', 'personalbar', 'scrollbars', 'statusbar', 'toolbar']
const DPR_BY_PERSONA = { desktop: 1, mac: 2, linux: 1, mobile: 2.625, mixed: 1 }

;(function bootstrapIdentity() {
  const initialProfile = readInitialProfile()
  if (initialProfile) {
    applyIdentity(initialProfile)
    return
  }

  document.addEventListener(PROFILE_EVENT, (event) => {
    const profile = parseProfile(event?.detail) || readProfileFromDom()
    if (profile) applyIdentity(profile)
  }, { once: true })
})()

function readInitialProfile() {
  return parseProfile(document.currentScript?.dataset?.profile) || readProfileFromDom()
}

function readProfileFromDom() {
  return parseProfile(document.documentElement?.getAttribute(PROFILE_ATTR))
}

function parseProfile(rawValue) {
  if (!rawValue) return null
  if (typeof rawValue === 'object') return rawValue

  try {
    const parsed = JSON.parse(String(rawValue))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function resolveViewportDimension(value, fallback) {
  const parsed = Math.round(Number(value))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function buildViewportProfile(screenProfile) {
  return {
    innerWidth: resolveViewportDimension(window.innerWidth, screenProfile.innerWidth),
    innerHeight: resolveViewportDimension(window.innerHeight, screenProfile.innerHeight),
    outerWidth: resolveViewportDimension(window.outerWidth, screenProfile.width),
    outerHeight: resolveViewportDimension(window.outerHeight, screenProfile.height),
  }
}

function applyIdentity(profile) {
  if (globalThis[APPLIED_FLAG]) return

  try {
    Object.defineProperty(globalThis, APPLIED_FLAG, {
      value: true,
      configurable: false,
      enumerable: false,
      writable: false,
    })
  } catch {
    globalThis[APPLIED_FLAG] = true
  }

  const seedSource = `${profile.userId || ''}:${profile.country}:${profile.tz}:${profile.platform}:${profile.userAgent}`
  const seed = Array.from(seedSource).reduce((sum, char, index) => sum + (char.charCodeAt(0) * (index + 1)), 0)
  const screenProfile = {
    width: profile.screen?.width ?? 1366,
    height: profile.screen?.height ?? 768,
    availWidth: profile.screen?.availWidth ?? profile.screen?.width ?? 1366,
    availHeight: profile.screen?.availHeight ?? profile.screen?.height ?? 768,
    innerWidth: profile.screen?.innerWidth ?? profile.screen?.width ?? 1366,
    innerHeight: profile.screen?.innerHeight ?? profile.screen?.height ?? 768,
  }
  const viewportProfile = buildViewportProfile(screenProfile)
  const connectionProfile = {
    type: profile.mobile ? 'cellular' : 'wifi',
    effectiveType: profile.connection?.effectiveType || '4g',
    downlink: profile.connection?.downlink ?? 10,
    downlinkMax: profile.mobile ? 42 : 1000,
    rtt: profile.connection?.rtt ?? 50,
    saveData: !!profile.connection?.saveData,
  }
  const chromeVersion = String(profile.uaVersion || '124')
  const chromeFullVersion = profile.uaFullVersion || `${chromeVersion}.0.0.0`
  const brands = [
    { brand: 'Google Chrome', version: chromeVersion },
    { brand: 'Chromium', version: chromeVersion },
    { brand: 'Not-A.Brand', version: '99' },
  ]
  const userAgentData = {
    brands,
    mobile: !!profile.mobile,
    platform: profile.platformLabel,
    getHighEntropyValues: async () => ({
      architecture: profile.architecture || (profile.mobile ? 'arm' : 'x86'),
      bitness: profile.bitness || '64',
      brands,
      formFactors: [profile.mobile ? 'Mobile' : 'Desktop'],
      fullVersionList: [{ brand: 'Google Chrome', version: chromeFullVersion }],
      mobile: !!profile.mobile,
      model: profile.deviceModel || '',
      platform: profile.platformLabel,
      platformVersion: profile.platformVersion || (profile.mobile ? '14.0.0' : '10.0.0'),
      uaFullVersion: chromeFullVersion,
      wow64: false,
    }),
  }
  const connectionObject = {
    ...connectionProfile,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return false },
  }
  const fakeBattery = {
    charging: !profile.mobile,
    chargingTime: profile.mobile ? Infinity : 0,
    dischargingTime: profile.mobile ? 18000 : Infinity,
    level: profile.mobile ? 0.72 : 1,
    onchargingchange: null,
    onchargingtimechange: null,
    ondischargingtimechange: null,
    onlevelchange: null,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return false },
  }
  const permissionStatus = {
    state: 'granted',
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return false },
  }
  const pluginData = makePluginArray()

  function defineGetter(target, property, getter) {
    if (!target) return

    try {
      Object.defineProperty(target, property, {
        get: getter,
        configurable: true,
      })
    } catch {}
  }

  function seededOffset(value, spread) {
    return ((((seed * (value + 3)) % (spread * 2 + 1)) - spread) || 0) / 1000
  }

  function deterministicNoise(index, scale) {
    return ((((seed + index * 17) % 11) - 5) / 5) * scale
  }

  function fakeGeolocationPosition(success) {
    success({
      coords: {
        latitude: profile.lat + ((((seed * 7) % 100) - 50) / 10000),
        longitude: profile.lon + ((((seed * 13) % 100) - 50) / 10000),
        accuracy: 20 + (seed % 80),
        altitude: null,
        altitudeAccuracy: null,
        heading: null,
        speed: null,
      },
      timestamp: Date.now(),
    })
  }

  patchTimezone(profile)
  patchIntl(profile)
  patchNavigator(profile, defineGetter, pluginData, userAgentData, connectionObject)
  patchScreen(profile, screenProfile, viewportProfile, defineGetter)
  patchServiceWorker(defineGetter)
  patchWorkers(profile)
  patchWebRTC()
  patchCanvas(seed, seededOffset)
  patchGeolocation(defineGetter, fakeGeolocationPosition)
  patchPermissions(permissionStatus)
  patchOrientation(profile)
  patchAudio(profile, defineGetter, deterministicNoise)
  patchSpeech(profile, defineGetter)
  patchWebGL(profile)
  patchPerformance()
  patchMatchMedia(profile, screenProfile, viewportProfile)
  patchBattery(fakeBattery)
  patchEnumerateDevices(profile)
  patchLocationBars(defineGetter)
  patchWebAssembly(profile)
  injectScrollbarHint(profile)
}

function makePluginArray() {
  const mimeType = {
    type: 'application/pdf',
    suffixes: 'pdf',
    description: 'Portable Document Format',
  }
  const pdfPlugin = {
    name: 'Chrome PDF Viewer',
    filename: 'internal-pdf-viewer',
    description: 'Portable Document Format',
    length: 1,
    0: mimeType,
    item(index) { return this[index] ?? null },
    namedItem(name) { return name === 'application/pdf' ? this[0] : null },
  }
  const plugins = {
    0: pdfPlugin,
    length: 1,
    item(index) { return this[index] ?? null },
    namedItem(name) { return name === 'Chrome PDF Viewer' ? this[0] : null },
    refresh() {},
    [Symbol.iterator]: function* iterator() { yield this[0] },
  }
  const mimeTypes = {
    0: mimeType,
    length: 1,
    item(index) { return this[index] ?? null },
    namedItem(name) { return name === 'application/pdf' ? this[0] : null },
    [Symbol.iterator]: function* iterator() { yield this[0] },
  }
  return { plugins, mimeTypes }
}

function patchTimezone(profile) {
  const NativeDateTimeFormat = Intl.DateTimeFormat
  Intl.DateTimeFormat = function DateTimeFormat(locales, options = {}) {
    return new NativeDateTimeFormat(locales, { ...options, timeZone: options.timeZone || profile.tz })
  }
  Intl.DateTimeFormat.prototype = NativeDateTimeFormat.prototype
  Intl.DateTimeFormat.supportedLocalesOf = NativeDateTimeFormat.supportedLocalesOf.bind(NativeDateTimeFormat)

  const timezoneOffset = (() => {
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
    return timezoneOffset
  }
}

function patchIntl(profile) {
  const NativeNumberFormat = Intl.NumberFormat
  Intl.NumberFormat = function NumberFormat(locales, options) {
    return new NativeNumberFormat(locales || profile.lang, options)
  }
  Intl.NumberFormat.prototype = NativeNumberFormat.prototype
  Intl.NumberFormat.supportedLocalesOf = NativeNumberFormat.supportedLocalesOf.bind(NativeNumberFormat)

  const nativeResolvedOptions = NativeNumberFormat.prototype.resolvedOptions
  NativeNumberFormat.prototype.resolvedOptions = function resolvedOptions() {
    const options = nativeResolvedOptions.call(this)
    options.locale = profile.lang
    return options
  }

  for (const name of ['PluralRules', 'RelativeTimeFormat', 'Collator', 'ListFormat', 'Segmenter']) {
    const NativeCtor = Intl[name]
    if (!NativeCtor) continue

    Intl[name] = function IntlCtor(locales, options) {
      return new NativeCtor(locales || profile.lang, options)
    }
    Intl[name].prototype = NativeCtor.prototype
  }
}

function patchNavigator(profile, defineGetter, pluginData, userAgentData, connectionObject) {
  if (typeof Navigator === 'undefined') return

  defineGetter(Navigator.prototype, 'pdfViewerEnabled', () => true)
  defineGetter(Navigator.prototype, 'cookieEnabled', () => true)
  defineGetter(Navigator.prototype, 'onLine', () => true)
  defineGetter(Navigator.prototype, 'webdriver', () => false)
  defineGetter(Navigator.prototype, 'javaEnabled', () => () => false)
  defineGetter(Navigator.prototype, 'language', () => profile.lang)
  defineGetter(Navigator.prototype, 'languages', () => [profile.lang, profile.lang.split('-')[0]])
  defineGetter(Navigator.prototype, 'userAgent', () => profile.userAgent)
  defineGetter(Navigator.prototype, 'appVersion', () => profile.userAgent.replace(/^Mozilla\//, ''))
  defineGetter(Navigator.prototype, 'appCodeName', () => 'Mozilla')
  defineGetter(Navigator.prototype, 'appName', () => 'Netscape')
  defineGetter(Navigator.prototype, 'product', () => 'Gecko')
  defineGetter(Navigator.prototype, 'productSub', () => '20030107')
  defineGetter(Navigator.prototype, 'vendor', () => 'Google Inc.')
  defineGetter(Navigator.prototype, 'vendorSub', () => '')
  defineGetter(Navigator.prototype, 'platform', () => profile.platform)
  defineGetter(Navigator.prototype, 'hardwareConcurrency', () => profile.hardwareConcurrency)
  defineGetter(Navigator.prototype, 'deviceMemory', () => profile.deviceMemory)
  defineGetter(Navigator.prototype, 'maxTouchPoints', () => profile.maxTouchPoints)
  defineGetter(Navigator.prototype, 'plugins', () => pluginData.plugins)
  defineGetter(Navigator.prototype, 'mimeTypes', () => pluginData.mimeTypes)
  defineGetter(Navigator.prototype, 'doNotTrack', () => null)
  defineGetter(Navigator.prototype, 'userAgentData', () => userAgentData)
  defineGetter(Navigator.prototype, 'connection', () => connectionObject)
}

function patchScreen(profile, screenProfile, viewportProfile, defineGetter) {
  if (typeof Screen !== 'undefined') {
    defineGetter(Screen.prototype, 'width', () => screenProfile.width)
    defineGetter(Screen.prototype, 'height', () => screenProfile.height)
    defineGetter(Screen.prototype, 'availWidth', () => screenProfile.availWidth)
    defineGetter(Screen.prototype, 'availHeight', () => screenProfile.availHeight)
    defineGetter(Screen.prototype, 'availLeft', () => 0)
    defineGetter(Screen.prototype, 'availTop', () => 0)
    defineGetter(Screen.prototype, 'isExtended', () => false)
    defineGetter(Screen.prototype, 'colorDepth', () => profile.colorDepth)
    defineGetter(Screen.prototype, 'pixelDepth', () => profile.pixelDepth)
  }

  defineGetter(window, 'innerWidth', () => viewportProfile.innerWidth)
  defineGetter(window, 'innerHeight', () => viewportProfile.innerHeight)
  defineGetter(window, 'outerWidth', () => viewportProfile.outerWidth)
  defineGetter(window, 'outerHeight', () => viewportProfile.outerHeight)
  defineGetter(window, 'devicePixelRatio', () => DPR_BY_PERSONA[profile.persona] ?? (profile.mobile ? 2 : 1))

  if (window.visualViewport) {
    defineGetter(window.visualViewport, 'width', () => viewportProfile.innerWidth)
    defineGetter(window.visualViewport, 'height', () => viewportProfile.innerHeight)
    defineGetter(window.visualViewport, 'scale', () => 1)
    defineGetter(window.visualViewport, 'offsetTop', () => 0)
    defineGetter(window.visualViewport, 'offsetLeft', () => 0)
    defineGetter(window.visualViewport, 'pageTop', () => 0)
    defineGetter(window.visualViewport, 'pageLeft', () => 0)
  }
}

function patchWorkers(profile) {
  for (const key of ['Worker', 'SharedWorker']) {
    const NativeWorker = window[key]
    if (typeof NativeWorker !== 'function') continue

    const WrappedWorker = function WrappedWorker(scriptURL, options = {}) {
      const type = options?.type === 'module' ? 'module' : 'classic'
      const resolvedScriptURL = new URL(String(scriptURL), window.location.href).href
      const blobURL = URL.createObjectURL(new Blob([buildWorkerBootstrap(profile, resolvedScriptURL, type)], {
        type: 'text/javascript',
      }))

      try {
        return new NativeWorker(blobURL, { ...options, type })
      } catch {
        return new NativeWorker(scriptURL, options)
      } finally {
        setTimeout(() => URL.revokeObjectURL(blobURL), 0)
      }
    }

    WrappedWorker.prototype = NativeWorker.prototype

    try {
      Object.defineProperty(window, key, {
        value: WrappedWorker,
        configurable: false,
        writable: false,
      })
    } catch {
      window[key] = WrappedWorker
    }
  }
}

function patchServiceWorker(defineGetter) {
  const nativeServiceWorker = navigator.serviceWorker
  if (!nativeServiceWorker) return

  const containerProto = Object.getPrototypeOf(nativeServiceWorker) || Object.prototype
  const registrationProto = window.ServiceWorkerRegistration?.prototype || Object.prototype
  const serviceWorkerProto = window.ServiceWorker?.prototype || Object.prototype
  const registrations = new Map()

  function createFakeWorker(scriptURL) {
    const worker = Object.create(null)
    defineGetter(worker, 'scriptURL', () => scriptURL)
    defineGetter(worker, 'state', () => 'activated')
    worker.postMessage = function postMessage() {}
    worker.addEventListener = function addEventListener() {}
    worker.removeEventListener = function removeEventListener() {}
    worker.dispatchEvent = function dispatchEvent() { return false }
    worker.onstatechange = null
    return worker
  }

  function resolveScope(scriptURL, scope) {
    try {
      return new URL(scope || '.', scriptURL).href
    } catch {
      return window.location.origin + '/'
    }
  }

  function createFakeRegistration(scriptURL, options = {}) {
    const resolvedScriptURL = new URL(String(scriptURL), window.location.href).href
    const scope = resolveScope(resolvedScriptURL, options?.scope)
    const existingRegistration = registrations.get(scope)
    if (existingRegistration) return existingRegistration

    const activeWorker = createFakeWorker(resolvedScriptURL)
    const registration = Object.create(null)
    defineGetter(registration, 'active', () => activeWorker)
    defineGetter(registration, 'installing', () => null)
    defineGetter(registration, 'waiting', () => null)
    defineGetter(registration, 'scope', () => scope)
    defineGetter(registration, 'navigationPreload', () => ({
      enable: async () => undefined,
      disable: async () => undefined,
      getState: async () => ({ enabled: false, headerValue: null }),
      setHeaderValue: async () => undefined,
    }))
    registration.update = async function update() { return registration }
    registration.unregister = async function unregister() {
      registrations.delete(scope)
      return true
    }
    registration.getNotifications = async function getNotifications() { return [] }
    registration.showNotification = async function showNotification() {}
    registration.addEventListener = function addEventListener() {}
    registration.removeEventListener = function removeEventListener() {}
    registration.dispatchEvent = function dispatchEvent() { return false }
    registration.updateViaCache = 'imports'
    registration.onupdatefound = null
    registrations.set(scope, registration)
    return registration
  }

  const serviceWorkerContainer = Object.create(null)
  defineGetter(serviceWorkerContainer, 'controller', () => null)
  defineGetter(serviceWorkerContainer, 'ready', () => Promise.resolve(
    Array.from(registrations.values())[0] || createFakeRegistration(window.location.href, { scope: '/' })
  ))
  serviceWorkerContainer.register = function register(scriptURL, options) {
    return Promise.resolve(createFakeRegistration(scriptURL, options))
  }
  serviceWorkerContainer.getRegistration = function getRegistration(clientURL) {
    if (!clientURL) return Promise.resolve(Array.from(registrations.values())[0] || null)
    const resolvedURL = new URL(String(clientURL), window.location.href).href
    return Promise.resolve(
      Array.from(registrations.entries()).find(([scope]) => resolvedURL.startsWith(scope))?.[1] || null
    )
  }
  serviceWorkerContainer.getRegistrations = function getRegistrations() {
    return Promise.resolve(Array.from(registrations.values()))
  }
  serviceWorkerContainer.startMessages = function startMessages() {}
  serviceWorkerContainer.addEventListener = function addEventListener() {}
  serviceWorkerContainer.removeEventListener = function removeEventListener() {}
  serviceWorkerContainer.dispatchEvent = function dispatchEvent() { return false }
  serviceWorkerContainer.oncontrollerchange = null
  serviceWorkerContainer.onmessage = null
  serviceWorkerContainer.onmessageerror = null

  try {
    Object.defineProperty(navigator, 'serviceWorker', {
      get: () => serviceWorkerContainer,
      configurable: false,
    })
  } catch {}
  try {
    Object.defineProperty(Navigator.prototype, 'serviceWorker', {
      get: () => serviceWorkerContainer,
      configurable: false,
    })
  } catch {
    defineGetter(Navigator.prototype, 'serviceWorker', () => serviceWorkerContainer)
  }
}

function buildWorkerBootstrap(profile, scriptURL, type) {
  const rawProfile = JSON.stringify(profile)
  const rawScriptURL = JSON.stringify(scriptURL)
  const isModuleWorker = type === 'module'

  return `(() => {
    const profile = ${rawProfile}
    const originalScriptURL = ${rawScriptURL}
    const defineGetter = (target, property, getter) => {
      if (!target) return
      try {
        Object.defineProperty(target, property, { get: getter, configurable: true })
      } catch {}
    }
    const patchTimezone = () => {
      const NativeDateTimeFormat = Intl.DateTimeFormat
      Intl.DateTimeFormat = function DateTimeFormat(locales, options = {}) {
        return new NativeDateTimeFormat(locales, { ...options, timeZone: options.timeZone || profile.tz })
      }
      Intl.DateTimeFormat.prototype = NativeDateTimeFormat.prototype
      Intl.DateTimeFormat.supportedLocalesOf = NativeDateTimeFormat.supportedLocalesOf.bind(NativeDateTimeFormat)
      const timezoneOffset = (() => {
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
        return timezoneOffset
      }
    }
    const patchIntl = () => {
      const NativeNumberFormat = Intl.NumberFormat
      Intl.NumberFormat = function NumberFormat(locales, options) {
        return new NativeNumberFormat(locales || profile.lang, options)
      }
      Intl.NumberFormat.prototype = NativeNumberFormat.prototype
      Intl.NumberFormat.supportedLocalesOf = NativeNumberFormat.supportedLocalesOf.bind(NativeNumberFormat)
      const nativeResolvedOptions = NativeNumberFormat.prototype.resolvedOptions
      NativeNumberFormat.prototype.resolvedOptions = function resolvedOptions() {
        const options = nativeResolvedOptions.call(this)
        options.locale = profile.lang
        return options
      }
    }
    const patchNavigator = () => {
      const navigatorProto = Object.getPrototypeOf(self.navigator)
      defineGetter(navigatorProto, 'language', () => profile.lang)
      defineGetter(navigatorProto, 'languages', () => [profile.lang, profile.lang.split('-')[0]])
      defineGetter(navigatorProto, 'userAgent', () => profile.userAgent)
      defineGetter(navigatorProto, 'platform', () => profile.platform)
      defineGetter(navigatorProto, 'hardwareConcurrency', () => profile.hardwareConcurrency)
      defineGetter(navigatorProto, 'deviceMemory', () => profile.deviceMemory)
      defineGetter(navigatorProto, 'maxTouchPoints', () => profile.maxTouchPoints)
      defineGetter(navigatorProto, 'userAgentData', () => ({
        brands: [
          { brand: 'Google Chrome', version: String(profile.uaVersion || '124') },
          { brand: 'Chromium', version: String(profile.uaVersion || '124') },
          { brand: 'Not-A.Brand', version: '99' },
        ],
        mobile: !!profile.mobile,
        platform: profile.platformLabel,
        getHighEntropyValues: async () => ({
          architecture: profile.architecture || (profile.mobile ? 'arm' : 'x86'),
          bitness: profile.bitness || '64',
          formFactors: [profile.mobile ? 'Mobile' : 'Desktop'],
          fullVersionList: [{ brand: 'Google Chrome', version: profile.uaFullVersion || String(profile.uaVersion || '124') + '.0.0.0' }],
          mobile: !!profile.mobile,
          model: profile.deviceModel || '',
          platform: profile.platformLabel,
          platformVersion: profile.platformVersion || (profile.mobile ? '14.0.0' : '10.0.0'),
          uaFullVersion: profile.uaFullVersion || String(profile.uaVersion || '124') + '.0.0.0',
          wow64: false,
        }),
      }))
    }
    const patchPerformance = () => {
      const nativeNow = globalThis.Performance?.prototype?.now
      if (!nativeNow) return
      Performance.prototype.now = function now() {
        return Math.floor(nativeNow.call(this))
      }
    }
    const patchLocation = () => {
      try {
        const realLocation = new URL(originalScriptURL, self.location.origin)
        const locationProto = Object.getPrototypeOf(self.location) || self.location
        for (const key of ['href', 'origin', 'protocol', 'host', 'hostname', 'pathname', 'search', 'hash']) {
          defineGetter(locationProto, key, () => realLocation[key])
        }
      } catch {}
    }
    const patchWebRTC = () => {
      const NativePeerConnection = self.RTCPeerConnection || self.webkitRTCPeerConnection
      if (!NativePeerConnection) return
      const sanitizeIceServers = (iceServers) => (Array.isArray(iceServers) ? iceServers : [])
        .map((server) => {
          const urls = []
            .concat(server?.urls || [])
            .map((url) => String(url))
            .filter((url) => /^turns?:/i.test(url))
          if (urls.length === 0) return null
          return { ...server, urls: Array.isArray(server?.urls) ? urls : urls[0] }
        })
        .filter(Boolean)
      const sanitizeSessionDescription = (description) => {
        if (!description?.sdp) return description
        const safeSdp = String(description.sdp)
          .split(/\\r?\\n/)
          .filter((line) => !/^a=candidate:/i.test(line) || /\\styp relay\\b/i.test(line))
          .join('\\r\\n')
        if (safeSdp === description.sdp) return description
        if (typeof self.RTCSessionDescription === 'function') {
          try {
            return new self.RTCSessionDescription({ type: description.type, sdp: safeSdp })
          } catch {}
        }
        return { ...description, sdp: safeSdp }
      }
      const WrappedPeerConnection = function RTCPeerConnection(config = {}) {
        const safeConfig = {
          ...config,
          iceTransportPolicy: 'relay',
          iceCandidatePoolSize: 0,
          iceServers: sanitizeIceServers(config.iceServers),
        }
        const peerConnection = new NativePeerConnection(safeConfig)
        const nativeCreateOffer = peerConnection.createOffer?.bind(peerConnection)
        const nativeCreateAnswer = peerConnection.createAnswer?.bind(peerConnection)
        const nativeSetLocalDescription = peerConnection.setLocalDescription?.bind(peerConnection)
        if (nativeCreateOffer) {
          peerConnection.createOffer = (...args) => nativeCreateOffer(...args).then(sanitizeSessionDescription)
        }
        if (nativeCreateAnswer) {
          peerConnection.createAnswer = (...args) => nativeCreateAnswer(...args).then(sanitizeSessionDescription)
        }
        if (nativeSetLocalDescription) {
          peerConnection.setLocalDescription = (description) => nativeSetLocalDescription(sanitizeSessionDescription(description))
        }
        return peerConnection
      }
      WrappedPeerConnection.prototype = NativePeerConnection.prototype
      self.RTCPeerConnection = WrappedPeerConnection
      if (self.webkitRTCPeerConnection) self.webkitRTCPeerConnection = WrappedPeerConnection
    }
    patchTimezone()
    patchIntl()
    patchNavigator()
    patchPerformance()
    patchLocation()
    patchWebRTC()
    ${isModuleWorker
      ? `return import(originalScriptURL)`
      : `importScripts(originalScriptURL)`}
  })();`
}

function patchWebRTC() {
  const NativePeerConnection = window.RTCPeerConnection
  if (!NativePeerConnection) return

  const nativeOnIceCandidateDescriptor = Object.getOwnPropertyDescriptor(NativePeerConnection.prototype, 'onicecandidate')

  function sanitizeIceServers(iceServers) {
    return (Array.isArray(iceServers) ? iceServers : [])
      .map((server) => {
        const urls = []
          .concat(server?.urls || [])
          .map((url) => String(url))
          .filter((url) => /^turns?:/i.test(url))
        if (urls.length === 0) return null
        return { ...server, urls: Array.isArray(server?.urls) ? urls : urls[0] }
      })
      .filter(Boolean)
  }

  function sanitizeCandidateString(candidate) {
    if (!candidate || !/\styp relay\b/i.test(String(candidate))) return ''
    return String(candidate).replace(/\sraddr\s+\S+\s+rport\s+\d+/ig, '')
  }

  function sanitizeIceCandidate(candidate) {
    if (!candidate) return null
    const safeCandidate = sanitizeCandidateString(candidate.candidate ?? candidate)
    if (!safeCandidate) return null

    const payload = {
      candidate: safeCandidate,
      sdpMid: candidate.sdpMid ?? null,
      sdpMLineIndex: candidate.sdpMLineIndex ?? null,
      usernameFragment: candidate.usernameFragment ?? null,
    }

    if (typeof window.RTCIceCandidate === 'function') {
      try {
        return new window.RTCIceCandidate(payload)
      } catch {}
    }

    return payload
  }

  function sanitizeSessionDescription(description) {
    if (!description?.sdp) return description

    const safeSdp = String(description.sdp)
      .split(/\r?\n/)
      .filter((line) => !/^a=candidate:/i.test(line) || /\styp relay\b/i.test(line))
      .join('\r\n')

    if (safeSdp === description.sdp) return description

    if (typeof window.RTCSessionDescription === 'function') {
      try {
        return new window.RTCSessionDescription({ type: description.type, sdp: safeSdp })
      } catch {}
    }

    return { ...description, sdp: safeSdp }
  }

  function sanitizeStatsReport(report) {
    if (!report || typeof report.forEach !== 'function') return report

    const safeEntries = []
    report.forEach((value, key) => {
      if (
        (value?.type === 'local-candidate' || value?.type === 'remote-candidate') &&
        value.candidateType &&
        value.candidateType !== 'relay'
      ) {
        return
      }
      safeEntries.push([key, value])
    })
    return new Map(safeEntries)
  }

  function wrapIceEvent(event) {
    const safeCandidate = sanitizeIceCandidate(event?.candidate)
    if (!safeCandidate) return null

    return new Proxy(event, {
      get(target, property, receiver) {
        if (property === 'candidate') return safeCandidate
        const value = Reflect.get(target, property, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }

  function patchPeerConnection(peerConnection) {
    const listenerMap = new WeakMap()
    const nativeAddEventListener = peerConnection.addEventListener?.bind(peerConnection)
    const nativeRemoveEventListener = peerConnection.removeEventListener?.bind(peerConnection)
    const nativeCreateOffer = peerConnection.createOffer?.bind(peerConnection)
    const nativeCreateAnswer = peerConnection.createAnswer?.bind(peerConnection)
    const nativeSetLocalDescription = peerConnection.setLocalDescription?.bind(peerConnection)
    const nativeAddIceCandidate = peerConnection.addIceCandidate?.bind(peerConnection)
    const nativeGetStats = peerConnection.getStats?.bind(peerConnection)

    if (nativeAddEventListener && nativeRemoveEventListener) {
      peerConnection.addEventListener = function addEventListener(type, listener, options) {
        if (type !== 'icecandidate' || typeof listener !== 'function') {
          return nativeAddEventListener(type, listener, options)
        }

        let wrapped = listenerMap.get(listener)
        if (!wrapped) {
          wrapped = function wrappedIceCandidateListener(event) {
            const safeEvent = wrapIceEvent(event)
            if (!safeEvent) return undefined
            return listener.call(this, safeEvent)
          }
          listenerMap.set(listener, wrapped)
        }

        return nativeAddEventListener(type, wrapped, options)
      }

      peerConnection.removeEventListener = function removeEventListener(type, listener, options) {
        const wrapped = type === 'icecandidate' && typeof listener === 'function'
          ? listenerMap.get(listener) || listener
          : listener
        return nativeRemoveEventListener(type, wrapped, options)
      }
    }

    if (nativeOnIceCandidateDescriptor?.get && nativeOnIceCandidateDescriptor?.set) {
      let originalHandler = null
      Object.defineProperty(peerConnection, 'onicecandidate', {
        configurable: true,
        get() {
          return originalHandler
        },
        set(handler) {
          originalHandler = typeof handler === 'function' ? handler : null
          nativeOnIceCandidateDescriptor.set.call(peerConnection, typeof handler === 'function'
            ? function wrappedOnIceCandidate(event) {
                const safeEvent = wrapIceEvent(event)
                if (!safeEvent) return undefined
                return handler.call(this, safeEvent)
              }
            : handler)
        },
      })
    }

    if (nativeCreateOffer) {
      peerConnection.createOffer = function createOffer(...args) {
        return nativeCreateOffer(...args).then(sanitizeSessionDescription)
      }
    }

    if (nativeCreateAnswer) {
      peerConnection.createAnswer = function createAnswer(...args) {
        return nativeCreateAnswer(...args).then(sanitizeSessionDescription)
      }
    }

    if (nativeSetLocalDescription) {
      peerConnection.setLocalDescription = function setLocalDescription(description) {
        return nativeSetLocalDescription(sanitizeSessionDescription(description))
      }
    }

    if (nativeAddIceCandidate) {
      peerConnection.addIceCandidate = function addIceCandidate(candidate) {
        const safeCandidate = sanitizeIceCandidate(candidate)
        if (!safeCandidate) return Promise.resolve()
        return nativeAddIceCandidate(safeCandidate)
      }
    }

    if (nativeGetStats) {
      peerConnection.getStats = function getStats(...args) {
        return nativeGetStats(...args).then(sanitizeStatsReport)
      }
    }

    return peerConnection
  }

  window.RTCPeerConnection = function RTCPeerConnection(config = {}) {
    const safeConfig = {
      ...config,
      iceTransportPolicy: 'relay',
      iceCandidatePoolSize: 0,
      iceServers: sanitizeIceServers(config.iceServers),
    }
    return patchPeerConnection(new NativePeerConnection(safeConfig))
  }
  window.RTCPeerConnection.prototype = NativePeerConnection.prototype
}

function patchCanvas(seed, seededOffset) {
  const NativeCanvasContext = globalThis.CanvasRenderingContext2D?.prototype
  const NativeCanvasElement = globalThis.HTMLCanvasElement?.prototype
  if (!NativeCanvasContext || !NativeCanvasElement) return

  const nativeGetImageData = NativeCanvasContext.getImageData
  const nativeToDataURL = NativeCanvasElement.toDataURL
  const nativeToBlob = NativeCanvasElement.toBlob
  const nativeMeasureText = NativeCanvasContext.measureText
  if (!nativeGetImageData || !nativeToDataURL || !nativeToBlob || !nativeMeasureText) return

  function applyCanvasNoise(data) {
    for (let index = 0; index < data.length; index += 4) {
      const delta = ((seed + index) % 3) - 1
      data[index] = Math.max(0, Math.min(255, data[index] + delta))
      data[index + 1] = Math.max(0, Math.min(255, data[index + 1] - delta))
    }
  }

  function cloneWithNoise(canvas) {
    const ctx = canvas.getContext && canvas.getContext('2d')
    if (!ctx || canvas.width <= 0 || canvas.height <= 0) return null

    try {
      const clone = document.createElement('canvas')
      clone.width = canvas.width
      clone.height = canvas.height
      const cloneCtx = clone.getContext('2d')
      if (!cloneCtx) return null

      cloneCtx.drawImage(canvas, 0, 0)
      const imageData = nativeGetImageData.call(cloneCtx, 0, 0, clone.width, clone.height)
      applyCanvasNoise(imageData.data)
      cloneCtx.putImageData(imageData, 0, 0)
      return clone
    } catch {
      return null
    }
  }

  NativeCanvasElement.toDataURL = function toDataURL(...args) {
    const noisyCanvas = cloneWithNoise(this)
    return nativeToDataURL.apply(noisyCanvas || this, args)
  }

  NativeCanvasElement.toBlob = function toBlob(callback, ...args) {
    const noisyCanvas = cloneWithNoise(this)
    return nativeToBlob.call(noisyCanvas || this, callback, ...args)
  }

  NativeCanvasContext.measureText = function measureText(text) {
    const realMetrics = nativeMeasureText.call(this, text)
    const widthOffset = seededOffset(String(text).length, 3)
    const patchedMetrics = Object.create(Object.getPrototypeOf(realMetrics) || Object.prototype)

    for (const key of TEXT_METRIC_KEYS) {
      const value = realMetrics[key]
      if (typeof value !== 'number') continue
      patchedMetrics[key] = key === 'width' ? value + widthOffset : value
    }

    return patchedMetrics
  }
}

function patchGeolocation(defineGetter, fakeGeolocationPosition) {
  if (!navigator.geolocation) return

  const geolocation = {
    getCurrentPosition(success) {
      if (typeof success === 'function') fakeGeolocationPosition(success)
    },
    watchPosition(success) {
      if (typeof success === 'function') fakeGeolocationPosition(success)
      return 0
    },
    clearWatch() {},
  }

  defineGetter(navigator, 'geolocation', () => geolocation)
}

function patchPermissions(permissionStatus) {
  const nativeQuery = navigator.permissions?.query?.bind(navigator.permissions)
  if (!nativeQuery) return

  try {
    navigator.permissions.query = function query(descriptor) {
      if (descriptor?.name === 'geolocation') {
        return Promise.resolve(permissionStatus)
      }
      return nativeQuery(descriptor)
    }
  } catch {}
}

function patchOrientation(profile) {
  if (!window.screen?.orientation) return

  try {
    Object.defineProperty(window.screen, 'orientation', {
      get: () => ({
        type: profile.mobile ? 'portrait-primary' : 'landscape-primary',
        angle: 0,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() { return false },
        lock: () => Promise.reject(new DOMException('Not supported')),
        unlock() {},
      }),
      configurable: true,
    })
  } catch {}
}

function patchAudio(profile, defineGetter, deterministicNoise) {
  const NativeAudioContext = window.AudioContext || window.webkitAudioContext
  const NativeOfflineAudioContext = window.OfflineAudioContext || window.webkitOfflineAudioContext
  const nativeGetChannelData = globalThis.AudioBuffer?.prototype?.getChannelData
  const spoofedMaxChannels = profile.mobile ? 2 : 8

  function wrapAudioContext(NativeCtor) {
    if (!NativeCtor) return NativeCtor

    function WrappedAudioContext(...args) {
      const context = new NativeCtor(...args)

      defineGetter(context, 'sampleRate', () => profile.sampleRate)
      if (context.destination) {
        defineGetter(context.destination, 'maxChannelCount', () => spoofedMaxChannels)
        defineGetter(context.destination, 'channelCount', () => Math.min(2, spoofedMaxChannels))
      }

      return context
    }

    WrappedAudioContext.prototype = NativeCtor.prototype
    return WrappedAudioContext
  }

  if (NativeAudioContext) {
    window.AudioContext = wrapAudioContext(NativeAudioContext)
    if (window.webkitAudioContext) window.webkitAudioContext = window.AudioContext
  }

  if (NativeOfflineAudioContext) {
    window.OfflineAudioContext = wrapAudioContext(NativeOfflineAudioContext)
    if (window.webkitOfflineAudioContext) window.webkitOfflineAudioContext = window.OfflineAudioContext
  }

  if (!nativeGetChannelData) return

  AudioBuffer.prototype.getChannelData = function getChannelData(channel) {
    const data = nativeGetChannelData.call(this, channel)
    const clone = new Float32Array(data.length)
    clone.set(data)
    for (let index = 0; index < clone.length; index += 128) {
      clone[index] += deterministicNoise(index + channel, 0.00002)
    }
    return clone
  }
}

function patchSpeech(profile, defineGetter) {
  if (!window.speechSynthesis || !profile.mobile) return

  defineGetter(window, 'speechSynthesis', () => ({
    speak() {},
    cancel() {},
    pause() {},
    resume() {},
    pending: false,
    speaking: false,
    paused: false,
    getVoices: () => [],
    onvoiceschanged: null,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return false },
  }))
}

function patchWebGL(profile) {
  const NativeCanvasElement = globalThis.HTMLCanvasElement?.prototype
  const nativeGetContext = NativeCanvasElement?.getContext
  if (!nativeGetContext) return

  const glVendor = profile.mobile ? 'ARM' : 'Google Inc. (Intel)'
  const glRenderer = profile.mobile
    ? 'Mali-G57 MC2'
    : 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)'

  NativeCanvasElement.getContext = function getContext(type, ...args) {
    const context = nativeGetContext.call(this, type, ...args)
    if (!context || !/^webgl/i.test(String(type))) return context

    const nativeGetParameter = context.getParameter.bind(context)
    context.getParameter = function getParameter(parameter) {
      const rendererInfo = context.getExtension('WEBGL_debug_renderer_info')
      if (rendererInfo) {
        if (parameter === rendererInfo.UNMASKED_VENDOR_WEBGL) return glVendor
        if (parameter === rendererInfo.UNMASKED_RENDERER_WEBGL) return glRenderer
      }
      return nativeGetParameter(parameter)
    }
    return context
  }
}

function patchPerformance() {
  const nativeNow = globalThis.Performance?.prototype?.now
  if (!nativeNow) return

  Performance.prototype.now = function now() {
    return Math.floor(nativeNow.call(this))
  }
}

function patchMatchMedia(profile, screenProfile, viewportProfile) {
  if (typeof window.matchMedia !== 'function') return

  const dpr = DPR_BY_PERSONA[profile.persona] ?? (profile.mobile ? 2 : 1)
  const nativeMatchMedia = window.matchMedia.bind(window)

  function parseLength(value) {
    const parsed = Number.parseFloat(String(value))
    return Number.isFinite(parsed) ? parsed : null
  }

  function evaluateFeature(feature) {
    const normalized = feature.trim().toLowerCase()
    if (!normalized) return null

    const parts = normalized.split(':')
    const rawName = parts[0]?.trim() || ''
    const rawValue = parts[1]?.trim() || ''
    const prefixMatch = /^(min|max)-(.+)$/.exec(rawName)
    const comparison = prefixMatch?.[1] || 'eq'
    const name = prefixMatch?.[2] || rawName

    const compare = (actual, expected) => {
      if (expected == null) return null
      if (comparison === 'min') return actual >= expected
      if (comparison === 'max') return actual <= expected
      return actual === expected
    }

    if (name === 'width') return compare(viewportProfile.innerWidth, parseLength(rawValue))
    if (name === 'height') return compare(viewportProfile.innerHeight, parseLength(rawValue))
    if (name === 'device-width') return compare(screenProfile.width, parseLength(rawValue))
    if (name === 'device-height') return compare(screenProfile.height, parseLength(rawValue))
    if (name === 'resolution') {
      const numericValue = parseLength(rawValue)
      if (rawValue.endsWith('dppx')) return compare(dpr, numericValue)
      if (rawValue.endsWith('dpi')) return compare(Math.round(dpr * 96), numericValue)
      return null
    }
    if (name === 'device-pixel-ratio') return compare(dpr, parseLength(rawValue))
    if (name === 'orientation') return rawValue === (viewportProfile.innerHeight >= viewportProfile.innerWidth ? 'portrait' : 'landscape')
    if (name === 'prefers-color-scheme') return rawValue === 'dark' ? false : rawValue === 'light'
    if (name === 'hover' || name === 'any-hover') return rawValue === (profile.mobile ? 'none' : 'hover')
    if (name === 'pointer' || name === 'any-pointer') return rawValue === (profile.mobile ? 'coarse' : 'fine')
    if (name === 'color') return compare(profile.colorDepth, parseLength(rawValue))

    return null
  }

  function evaluateQuery(query) {
    const clauses = String(query)
      .split(',')
      .map((clause) => clause.trim())
      .filter(Boolean)

    if (clauses.length === 0) return null

    return clauses.some((clause) => {
      const loweredClause = clause.toLowerCase()
      if (/\bprint\b/.test(loweredClause)) return false

      const features = clause.match(/\(([^)]+)\)/g) || []
      return features.every((feature) => {
        const result = evaluateFeature(feature.slice(1, -1))
        return result == null ? true : result
      })
    })
  }

  window.matchMedia = function matchMedia(query) {
    const mediaQueryList = nativeMatchMedia(query)
    const spoofedMatch = evaluateQuery(query)
    if (typeof spoofedMatch === 'boolean') {
      try {
        Object.defineProperty(mediaQueryList, 'matches', {
          get: () => spoofedMatch,
          set() {},
          configurable: true,
        })
      } catch {}
    }
    return mediaQueryList
  }
}

function patchBattery(fakeBattery) {
  if (!navigator.getBattery) return

  try {
    navigator.getBattery = () => Promise.resolve(fakeBattery)
  } catch {}
}

function patchEnumerateDevices(profile) {
  const nativeEnumerateDevices = navigator.mediaDevices?.enumerateDevices?.bind(navigator.mediaDevices)
  if (!nativeEnumerateDevices) return

  try {
    navigator.mediaDevices.enumerateDevices = function enumerateDevices() {
      return nativeEnumerateDevices().then(() => profile.mobile
        ? [
            { kind: 'videoinput', label: '', deviceId: 'front', groupId: 'g1' },
            { kind: 'videoinput', label: '', deviceId: 'rear', groupId: 'g2' },
            { kind: 'audioinput', label: '', deviceId: 'mic0', groupId: 'g1' },
            { kind: 'audiooutput', label: '', deviceId: 'spk0', groupId: 'g1' },
          ]
        : [
            { kind: 'videoinput', label: '', deviceId: 'cam0', groupId: 'g1' },
            { kind: 'audioinput', label: '', deviceId: 'mic0', groupId: 'g1' },
            { kind: 'audiooutput', label: '', deviceId: 'spk0', groupId: 'g1' },
            { kind: 'audiooutput', label: '', deviceId: 'spk1', groupId: 'g2' },
          ]
      )
    }
  } catch {}
}

function patchLocationBars(defineGetter) {
  for (const key of LOCATION_BAR_KEYS) {
    if (window[key] && typeof window[key] === 'object') {
      defineGetter(window[key], 'visible', () => true)
    }
  }
}

function patchWebAssembly(profile) {
  if (!profile.mobile || !WebAssembly?.validate) return

  const nativeValidate = WebAssembly.validate.bind(WebAssembly)
  WebAssembly.validate = function validate(bufferSource) {
    try {
      if (new Uint8Array(bufferSource).length < 64) return false
    } catch {}
    return nativeValidate(bufferSource)
  }
}

function injectScrollbarHint(profile) {
  try {
    const style = document.createElement('style')
    style.setAttribute('data-peermesh', '1')
    style.textContent = profile.mobile
      ? '::-webkit-scrollbar{display:none!important;width:0!important}'
      : '::-webkit-scrollbar{width:15px!important}'
    ;(document.head || document.documentElement).appendChild(style)
  } catch {}
}
