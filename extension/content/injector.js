// injector.js - runs in ISOLATED world, injects identity.js into MAIN world
// Only active when a PeerMesh session is connected.

const COUNTRY_DATA_MAP = globalThis.__PEERMESH_COUNTRY_DATA__ || {
  XX: { tz: 'UTC', lang: 'en-US', lat: 51.5074, lon: -0.1278, persona: 'desktop' },
}

const PERSONA_POOL_MAP = globalThis.__PEERMESH_PERSONA_POOLS__ || {
  desktop: [
    {
      mobile: false,
      platform: 'Win32',
      platformLabel: 'Windows',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      uaVersion: '124',
      screen: { w: 1920, h: 1080, aw: 1920, ah: 1040, iw: 1920, ih: 947 },
      hardwareConcurrency: 8,
      deviceMemory: 8,
      maxTouchPoints: 0,
      connection: { effectiveType: '4g', downlink: 25, rtt: 25, saveData: false },
      sampleRate: 48000,
      colorDepth: 24,
    },
  ],
}

const DEFAULT_COUNTRY = COUNTRY_DATA_MAP.XX || {
  tz: 'UTC',
  lang: 'en-US',
  lat: 51.5074,
  lon: -0.1278,
  persona: 'desktop',
}

function hashString(value) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function defaultFontForPlatform(platformLabel) {
  if (platformLabel === 'Android') return 'Roboto'
  if (platformLabel === 'macOS') return 'Helvetica'
  if (platformLabel === 'Linux') return 'Noto Sans'
  return 'Arial'
}

function normalizeCountry(country) {
  const requested = String(country || '').trim().toUpperCase()
  if (requested && COUNTRY_DATA_MAP[requested]) {
    return { code: requested, meta: COUNTRY_DATA_MAP[requested] }
  }

  const shortCode = requested.slice(0, 2)
  if (shortCode && COUNTRY_DATA_MAP[shortCode]) {
    return { code: shortCode, meta: COUNTRY_DATA_MAP[shortCode] }
  }

  return { code: requested || 'XX', meta: DEFAULT_COUNTRY }
}

function getChromeFullVersion(userAgent, fallbackVersion) {
  const match = /Chrome\/([\d.]+)/.exec(userAgent || '')
  return match?.[1] || (fallbackVersion ? `${fallbackVersion}.0.0.0` : '124.0.0.0')
}

function getDeviceModel(variant) {
  if (!variant.mobile) return ''
  const match = /Android [^;]+; ([^)]+)\)/.exec(variant.userAgent || '')
  return match?.[1] || 'Android'
}

function getPlatformVersion(variant) {
  const userAgent = variant.userAgent || ''

  if (variant.platformLabel === 'Android') {
    const match = /Android ([\d.]+)/.exec(userAgent)
    return match?.[1]
      ? match[1].split('.').concat(['0', '0']).slice(0, 3).join('.')
      : '14.0.0'
  }

  if (variant.platformLabel === 'Windows') {
    const match = /Windows NT ([\d.]+)/.exec(userAgent)
    return match?.[1] ? `${match[1]}.0` : '10.0.0'
  }

  if (variant.platformLabel === 'macOS') {
    const match = /Mac OS X ([\d_]+)/.exec(userAgent)
    return match?.[1]?.replace(/_/g, '.') || '10.15.7'
  }

  return '0.0.0'
}

function normalizeScreen(screen = {}) {
  return {
    width: screen.w ?? screen.width ?? 1366,
    height: screen.h ?? screen.height ?? 768,
    availWidth: screen.aw ?? screen.availWidth ?? screen.w ?? screen.width ?? 1366,
    availHeight: screen.ah ?? screen.availHeight ?? screen.h ?? screen.height ?? 768,
    innerWidth: screen.iw ?? screen.innerWidth ?? screen.w ?? screen.width ?? 1366,
    innerHeight: screen.ih ?? screen.innerHeight ?? screen.h ?? screen.height ?? 768,
  }
}

function normalizePersona(personaName, variant, variantIndex) {
  const uaVersion = String(variant.uaVersion || (getChromeFullVersion(variant.userAgent).split('.')[0] || '124'))
  const uaFullVersion = getChromeFullVersion(variant.userAgent, uaVersion)
  const platformLabel = variant.platformLabel || (variant.mobile ? 'Android' : 'Windows')

  return {
    name: personaName,
    persona: personaName,
    variant: variantIndex,
    mobile: !!variant.mobile,
    userAgent: variant.userAgent,
    uaVersion,
    uaFullVersion,
    deviceModel: getDeviceModel(variant),
    platform: variant.platform || (variant.mobile ? 'Linux armv8l' : 'Win32'),
    platformLabel,
    platformVersion: getPlatformVersion(variant),
    architecture: variant.mobile || String(variant.platform || '').toLowerCase().includes('arm') ? 'arm' : 'x86',
    bitness: variant.mobile || /(?:x64|win64|x86_64|armv8|aarch64)/i.test(`${variant.userAgent || ''} ${variant.platform || ''}`) ? '64' : '32',
    screen: normalizeScreen(variant.screen),
    hardwareConcurrency: variant.hardwareConcurrency ?? (variant.mobile ? 6 : 8),
    deviceMemory: variant.deviceMemory ?? (variant.mobile ? 4 : 8),
    connection: {
      effectiveType: variant.connection?.effectiveType || '4g',
      downlink: variant.connection?.downlink ?? 10,
      rtt: variant.connection?.rtt ?? 50,
      saveData: !!variant.connection?.saveData,
    },
    sampleRate: variant.sampleRate ?? 48000,
    colorDepth: variant.colorDepth ?? 24,
    pixelDepth: variant.pixelDepth ?? variant.colorDepth ?? 24,
    maxTouchPoints: variant.maxTouchPoints ?? (variant.mobile ? 5 : 0),
    fontFamily: variant.fontFamily || defaultFontForPlatform(platformLabel),
  }
}

function selectPersonaVariant(country, personaName, pool, session) {
  if (!Array.isArray(pool) || pool.length === 0) {
    return { variant: PERSONA_POOL_MAP.desktop[0], variantIndex: 0 }
  }

  const seed = [
    country,
    personaName,
    session?.id,
    session?.sessionId,
    session?.relayEndpoint,
  ].filter(Boolean).join('|') || `${country}|${personaName}`
  const variantIndex = hashString(seed) % pool.length
  return { variant: pool[variantIndex], variantIndex }
}

function buildProfile(session) {
  const { code: country, meta } = normalizeCountry(session?.country)
  const personaName = PERSONA_POOL_MAP[meta.persona] ? meta.persona : DEFAULT_COUNTRY.persona || 'desktop'
  const pool = PERSONA_POOL_MAP[personaName] || PERSONA_POOL_MAP.desktop
  const { variant, variantIndex } = selectPersonaVariant(country, personaName, pool, session)
  const persona = normalizePersona(personaName, variant, variantIndex)

  return {
    country,
    tz: meta.tz,
    lang: meta.lang,
    lat: meta.lat,
    lon: meta.lon,
    ...persona,
  }
}

function markExtensionPresence() {
  const root = document.documentElement
  if (!root) return false

  root.setAttribute('data-peermesh-extension', '1')
  root.setAttribute('data-ext-version', chrome.runtime.getManifest().version)
  return true
}

if (!markExtensionPresence()) {
  const ensureMarked = () => {
    if (!markExtensionPresence()) return
    document.removeEventListener('readystatechange', ensureMarked)
    document.removeEventListener('DOMContentLoaded', ensureMarked)
  }

  document.addEventListener('readystatechange', ensureMarked)
  document.addEventListener('DOMContentLoaded', ensureMarked)
}

chrome.storage.local.get(['session'], ({ session }) => {
  if (!session?.country) return

  const profile = buildProfile(session)
  const script = document.createElement('script')
  script.src = chrome.runtime.getURL('content/identity.js')
  script.dataset.profile = JSON.stringify(profile)
  script.onload = () => script.remove()
  script.onerror = () => script.remove()
  ;(document.head || document.documentElement).appendChild(script)
})
