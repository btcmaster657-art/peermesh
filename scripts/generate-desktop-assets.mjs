#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = dirname(__dirname)
const assetsDir = join(repoRoot, 'desktop', 'assets')

const iconSvg = `
<svg width="512" height="512" viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="48" y1="32" x2="460" y2="476" gradientUnits="userSpaceOnUse">
      <stop stop-color="#081922"/>
      <stop offset="1" stop-color="#0B2C34"/>
    </linearGradient>
    <linearGradient id="line" x1="96" y1="88" x2="430" y2="432" gradientUnits="userSpaceOnUse">
      <stop stop-color="#5AF7C5"/>
      <stop offset="1" stop-color="#10BCE5"/>
    </linearGradient>
    <radialGradient id="glow" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(256 164) rotate(90) scale(220)">
      <stop stop-color="#8CFFF1" stop-opacity="0.28"/>
      <stop offset="1" stop-color="#8CFFF1" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect x="32" y="32" width="448" height="448" rx="112" fill="url(#bg)"/>
  <rect x="32" y="32" width="448" height="448" rx="112" fill="url(#glow)"/>
  <rect x="58" y="58" width="396" height="396" rx="96" stroke="rgba(255,255,255,0.08)" stroke-width="2"/>

  <path d="M144 130C186 106 230 94 276 94C361 94 421 141 421 210C421 258 389 297 331 323" stroke="url(#line)" stroke-width="22" stroke-linecap="round"/>
  <path d="M106 296C106 374 165 420 251 420C305 420 348 406 382 377" stroke="url(#line)" stroke-width="22" stroke-linecap="round"/>
  <path d="M162 170L230 230" stroke="url(#line)" stroke-width="20" stroke-linecap="round"/>
  <path d="M352 170L282 236" stroke="url(#line)" stroke-width="20" stroke-linecap="round"/>
  <path d="M166 346L234 282" stroke="url(#line)" stroke-width="20" stroke-linecap="round"/>
  <path d="M350 346L280 286" stroke="url(#line)" stroke-width="20" stroke-linecap="round"/>

  <circle cx="256" cy="256" r="68" fill="#081922" stroke="url(#line)" stroke-width="20"/>
  <path d="M230 230H282C304 230 322 248 322 270C322 292 304 310 282 310H230V202H278" stroke="#E9FFF7" stroke-width="24" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M230 256H278" stroke="#E9FFF7" stroke-width="24" stroke-linecap="round"/>

  <circle cx="142" cy="132" r="28" fill="#0F3943" stroke="url(#line)" stroke-width="14"/>
  <circle cx="370" cy="132" r="28" fill="#0F3943" stroke="url(#line)" stroke-width="14"/>
  <circle cx="142" cy="352" r="28" fill="#0F3943" stroke="url(#line)" stroke-width="14"/>
  <circle cx="370" cy="352" r="28" fill="#0F3943" stroke="url(#line)" stroke-width="14"/>
</svg>
`

const sidebarSvg = `
<svg width="164" height="314" viewBox="0 0 164 314" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="panel" x1="18" y1="0" x2="158" y2="314" gradientUnits="userSpaceOnUse">
      <stop stop-color="#06131A"/>
      <stop offset="1" stop-color="#0D2A33"/>
    </linearGradient>
    <linearGradient id="accent" x1="22" y1="52" x2="134" y2="174" gradientUnits="userSpaceOnUse">
      <stop stop-color="#5AF7C5"/>
      <stop offset="1" stop-color="#10BCE5"/>
    </linearGradient>
  </defs>

  <rect width="164" height="314" fill="url(#panel)"/>
  <circle cx="82" cy="102" r="54" fill="rgba(90,247,197,0.12)"/>
  <circle cx="82" cy="102" r="36" fill="#081922" stroke="url(#accent)" stroke-width="10"/>
  <path d="M68 88H95C106 88 114 96 114 107C114 118 106 126 95 126H68V74H93" stroke="#E9FFF7" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M68 101H94" stroke="#E9FFF7" stroke-width="12" stroke-linecap="round"/>
  <circle cx="44" cy="66" r="12" fill="#0F3943" stroke="url(#accent)" stroke-width="6"/>
  <circle cx="120" cy="66" r="12" fill="#0F3943" stroke="url(#accent)" stroke-width="6"/>
  <circle cx="44" cy="138" r="12" fill="#0F3943" stroke="url(#accent)" stroke-width="6"/>
  <circle cx="120" cy="138" r="12" fill="#0F3943" stroke="url(#accent)" stroke-width="6"/>
  <path d="M52 74L67 88" stroke="url(#accent)" stroke-width="8" stroke-linecap="round"/>
  <path d="M112 88L126 74" stroke="url(#accent)" stroke-width="8" stroke-linecap="round"/>
  <path d="M52 130L66 117" stroke="url(#accent)" stroke-width="8" stroke-linecap="round"/>
  <path d="M112 117L126 130" stroke="url(#accent)" stroke-width="8" stroke-linecap="round"/>

  <text x="24" y="214" fill="#E9FFF7" font-family="Segoe UI, Arial, sans-serif" font-size="24" font-weight="700">PeerMesh</text>
  <text x="24" y="240" fill="#95B8C0" font-family="Segoe UI, Arial, sans-serif" font-size="11" letter-spacing="1.4">PRIVATE RESIDENTIAL ACCESS</text>
  <text x="24" y="270" fill="#5AF7C5" font-family="Segoe UI, Arial, sans-serif" font-size="11" font-weight="700">DEVICE-LEVEL SHARING</text>
  <text x="24" y="289" fill="#95B8C0" font-family="Segoe UI, Arial, sans-serif" font-size="10">Public pool + private code routing</text>
</svg>
`

function buildIco(pngBuffers) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(pngBuffers.length, 4)

  const directory = Buffer.alloc(16 * pngBuffers.length)
  let offset = header.length + directory.length

  pngBuffers.forEach(({ size, data }, index) => {
    const entryOffset = index * 16
    directory.writeUInt8(size >= 256 ? 0 : size, entryOffset)
    directory.writeUInt8(size >= 256 ? 0 : size, entryOffset + 1)
    directory.writeUInt8(0, entryOffset + 2)
    directory.writeUInt8(0, entryOffset + 3)
    directory.writeUInt16LE(1, entryOffset + 4)
    directory.writeUInt16LE(32, entryOffset + 6)
    directory.writeUInt32LE(data.length, entryOffset + 8)
    directory.writeUInt32LE(offset, entryOffset + 12)
    offset += data.length
  })

  return Buffer.concat([header, directory, ...pngBuffers.map((entry) => entry.data)])
}

function buildBmp(raw, width, height) {
  const stride = width * 4
  const pixels = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y += 1) {
    const srcRow = (height - 1 - y) * stride
    const dstRow = y * stride
    for (let x = 0; x < width; x += 1) {
      const src = srcRow + (x * 4)
      const dst = dstRow + (x * 4)
      pixels[dst] = raw[src + 2]
      pixels[dst + 1] = raw[src + 1]
      pixels[dst + 2] = raw[src]
      pixels[dst + 3] = raw[src + 3]
    }
  }

  const fileHeader = Buffer.alloc(14)
  const dibHeader = Buffer.alloc(40)
  const pixelOffset = 54
  const fileSize = pixelOffset + pixels.length

  fileHeader.writeUInt16LE(0x4d42, 0)
  fileHeader.writeUInt32LE(fileSize, 2)
  fileHeader.writeUInt32LE(pixelOffset, 10)

  dibHeader.writeUInt32LE(40, 0)
  dibHeader.writeInt32LE(width, 4)
  dibHeader.writeInt32LE(height, 8)
  dibHeader.writeUInt16LE(1, 12)
  dibHeader.writeUInt16LE(32, 14)
  dibHeader.writeUInt32LE(0, 16)
  dibHeader.writeUInt32LE(pixels.length, 20)
  dibHeader.writeInt32LE(2835, 24)
  dibHeader.writeInt32LE(2835, 28)

  return Buffer.concat([fileHeader, dibHeader, pixels])
}

async function renderPng(svg, width, height = width) {
  return sharp(Buffer.from(svg))
    .resize(width, height)
    .png()
    .toBuffer()
}

async function renderRaw(svg, width, height = width) {
  return sharp(Buffer.from(svg))
    .resize(width, height)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
}

async function main() {
  await mkdir(assetsDir, { recursive: true })

  const iconSizes = [16, 24, 32, 48, 64, 128, 256]
  const icoEntries = []
  for (const size of iconSizes) {
    const data = await renderPng(iconSvg, size)
    icoEntries.push({ size, data })
  }

  const iconPng = await renderPng(iconSvg, 512)
  const trayPng = await renderPng(iconSvg, 64)
  const sidebarRaw = await renderRaw(sidebarSvg, 164, 314)
  const sidebarBmp = buildBmp(sidebarRaw.data, sidebarRaw.info.width, sidebarRaw.info.height)
  const iconIco = buildIco(icoEntries)

  await Promise.all([
    writeFile(join(assetsDir, 'icon.svg'), iconSvg),
    writeFile(join(assetsDir, 'icon.png'), iconPng),
    writeFile(join(assetsDir, 'tray-icon.png'), trayPng),
    writeFile(join(assetsDir, 'icon.ico'), iconIco),
    writeFile(join(assetsDir, 'installerIcon.ico'), iconIco),
    writeFile(join(assetsDir, 'uninstallerIcon.ico'), iconIco),
    writeFile(join(assetsDir, 'installerHeaderIcon.ico'), iconIco),
    writeFile(join(assetsDir, 'installerSidebar.bmp'), sidebarBmp),
    writeFile(join(assetsDir, 'uninstallerSidebar.bmp'), sidebarBmp),
  ])

  console.log('Generated desktop assets in', assetsDir)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
