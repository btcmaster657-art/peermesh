// injector.js — runs in ISOLATED world, injects identity.js into MAIN world
// Only active when a PeerMesh session is connected

const COUNTRY_TZ = {
  NG: { tz: 'Africa/Lagos',    lang: 'en-NG' },
  RW: { tz: 'Africa/Kigali',   lang: 'rw-RW' },
  KE: { tz: 'Africa/Nairobi',  lang: 'sw-KE' },
  ZA: { tz: 'Africa/Johannesburg', lang: 'en-ZA' },
  GH: { tz: 'Africa/Accra',    lang: 'en-GH' },
  GB: { tz: 'Europe/London',   lang: 'en-GB' },
  DE: { tz: 'Europe/Berlin',   lang: 'de-DE' },
  US: { tz: 'America/New_York', lang: 'en-US' },
  CA: { tz: 'America/Toronto', lang: 'en-CA' },
  AU: { tz: 'Australia/Sydney', lang: 'en-AU' },
  BR: { tz: 'America/Sao_Paulo', lang: 'pt-BR' },
  JP: { tz: 'Asia/Tokyo',      lang: 'ja-JP' },
}

chrome.storage.local.get(['session'], ({ session }) => {
  if (!session?.country) return

  const meta = COUNTRY_TZ[session.country] || { tz: 'UTC', lang: 'en-US' }

  const script = document.createElement('script')
  script.src = chrome.runtime.getURL('content/identity.js')
  script.dataset.tz = meta.tz
  script.dataset.lang = meta.lang
  script.dataset.country = session.country
  ;(document.head || document.documentElement).appendChild(script)
  script.remove()
})
