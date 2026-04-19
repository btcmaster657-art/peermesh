// injector.js - runs in ISOLATED world, injects identity.js into MAIN world
// Only active when a PeerMesh session is connected.

const COUNTRY_META = {
  NG: { tz: 'Africa/Lagos', lang: 'en-NG' },
  RW: { tz: 'Africa/Kigali', lang: 'rw-RW' },
  KE: { tz: 'Africa/Nairobi', lang: 'sw-KE' },
  ZA: { tz: 'Africa/Johannesburg', lang: 'en-ZA' },
  GH: { tz: 'Africa/Accra', lang: 'en-GH' },
  GB: { tz: 'Europe/London', lang: 'en-GB' },
  DE: { tz: 'Europe/Berlin', lang: 'de-DE' },
  US: { tz: 'America/New_York', lang: 'en-US' },
  CA: { tz: 'America/Toronto', lang: 'en-CA' },
  AU: { tz: 'Australia/Sydney', lang: 'en-AU' },
  BR: { tz: 'America/Sao_Paulo', lang: 'pt-BR' },
  JP: { tz: 'Asia/Tokyo', lang: 'ja-JP' },
}

const PERSONAS = {
  mobile: {
    name: 'mobile',
    mobile: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
    platform: 'Linux armv8l',
    platformLabel: 'Android',
    screen: { width: 390, height: 844, availWidth: 390, availHeight: 844, innerWidth: 390, innerHeight: 763 },
    hardwareConcurrency: 4,
    deviceMemory: 4,
    connection: { effectiveType: '4g', downlink: 10, rtt: 80, saveData: false },
    sampleRate: 48000,
    colorDepth: 24,
    pixelDepth: 24,
    maxTouchPoints: 5,
    fontFamily: 'Roboto',
  },
  desktop: {
    name: 'desktop',
    mobile: false,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    platform: 'Win32',
    platformLabel: 'Windows',
    screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, innerWidth: 1920, innerHeight: 947 },
    hardwareConcurrency: 8,
    deviceMemory: 8,
    connection: { effectiveType: '4g', downlink: 20, rtt: 50, saveData: false },
    sampleRate: 48000,
    colorDepth: 24,
    pixelDepth: 24,
    maxTouchPoints: 0,
    fontFamily: 'Arial',
  },
  mixed: {
    name: 'mixed',
    mobile: false,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    platform: 'Win32',
    platformLabel: 'Windows',
    screen: { width: 1366, height: 768, availWidth: 1366, availHeight: 728, innerWidth: 1366, innerHeight: 657 },
    hardwareConcurrency: 4,
    deviceMemory: 4,
    connection: { effectiveType: '4g', downlink: 12, rtt: 60, saveData: false },
    sampleRate: 44100,
    colorDepth: 24,
    pixelDepth: 24,
    maxTouchPoints: 0,
    fontFamily: 'Arial',
  },
}

const COUNTRY_PERSONAS = {
  NG: 'mobile',
  KE: 'mobile',
  GH: 'mobile',
  RW: 'mobile',
  GB: 'desktop',
  DE: 'desktop',
  US: 'desktop',
  CA: 'desktop',
  AU: 'desktop',
  JP: 'desktop',
  BR: 'mixed',
  ZA: 'mixed',
}

function buildProfile(country) {
  const meta = COUNTRY_META[country] || { tz: 'UTC', lang: 'en-US' }
  const persona = PERSONAS[COUNTRY_PERSONAS[country] || 'desktop']
  return {
    country,
    tz: meta.tz,
    lang: meta.lang,
    ...persona,
  }
}

if (document.documentElement) {
  document.documentElement.setAttribute('data-peermesh-extension', '1')
  document.documentElement.setAttribute('data-ext-version', chrome.runtime.getManifest().version)
}

chrome.storage.local.get(['session'], ({ session }) => {
  if (!session?.country) return

  const profile = buildProfile(session.country)
  const script = document.createElement('script')
  script.src = chrome.runtime.getURL('content/identity.js')
  script.dataset.profile = JSON.stringify(profile)
  ;(document.head || document.documentElement).appendChild(script)
  script.remove()
})
