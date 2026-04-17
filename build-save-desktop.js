#!/usr/bin/env node
/**
 * build-save-desktop.js
 * Usage:
 *   node build-save-desktop.js                  — build current platform, patch bump
 *   node build-save-desktop.js win              — Windows only
 *   node build-save-desktop.js mac              — macOS only
 *   node build-save-desktop.js linux            — Linux only
 *   node build-save-desktop.js win mac linux    — all platforms
 *   node build-save-desktop.js minor            — minor version bump
 *   node build-save-desktop.js major            — major version bump
 *   node build-save-desktop.js --no-bump        — build without version change
 */

import { execSync } from 'child_process'
import { readFileSync, writeFileSync, copyFileSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const DESKTOP_DIR = join(__dirname, 'desktop')
const PUBLIC_DIR = join(__dirname, 'public')
const PKG_PATH = join(DESKTOP_DIR, 'package.json')

// ── Parse args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const bumpType = args.find(a => ['major', 'minor', 'patch'].includes(a)) ?? 'patch'
const noBump = args.includes('--no-bump')

const PLATFORM_ARGS = ['win', 'mac', 'linux']
const requestedPlatforms = args.filter(a => PLATFORM_ARGS.includes(a))

// Default: detect current platform
const defaultPlatform = process.platform === 'darwin' ? 'mac'
  : process.platform === 'linux' ? 'linux'
  : 'win'

const platforms = requestedPlatforms.length > 0 ? requestedPlatforms : [defaultPlatform]

// ── Version bump ──────────────────────────────────────────────────────────────

const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf-8'))
const currentVersion = pkg.version
const [major, minor, patch] = currentVersion.split('.').map(Number)

let newVersion = currentVersion
if (!noBump) {
  if (bumpType === 'major') newVersion = `${major + 1}.0.0`
  else if (bumpType === 'minor') newVersion = `${major}.${minor + 1}.0`
  else newVersion = `${major}.${minor}.${patch + 1}`

  pkg.version = newVersion
  writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2))
  console.log(`\n  Version: ${currentVersion} → ${newVersion}`)
} else {
  console.log(`\n  Version: ${currentVersion} (no bump)`)
}

// ── Platform build config ─────────────────────────────────────────────────────

const PLATFORM_CONFIG = {
  win: {
    script: 'build-win',
    find: f => f.endsWith('.exe') && !f.endsWith('.blockmap'),
    dest: 'PeerMesh-Setup.exe',
  },
  mac: {
    script: 'build-mac',
    find: f => f.endsWith('.dmg'),
    dest: 'PeerMesh-Setup.dmg',
  },
  linux: {
    script: 'build-linux',
    find: f => f.endsWith('.AppImage'),
    dest: 'PeerMesh-Setup.AppImage',
  },
}

// ── Build each platform ───────────────────────────────────────────────────────

const distDir = join(DESKTOP_DIR, 'dist')

for (const platform of platforms) {
  const { script, find, dest } = PLATFORM_CONFIG[platform]
  console.log(`\n  Building ${platform} (v${newVersion})...`)

  try {
    execSync(`npm run ${script}`, { cwd: DESKTOP_DIR, stdio: 'inherit' })
  } catch {
    console.error(`\n  Build failed for ${platform}!`)
    process.exit(1)
  }

  const files = readdirSync(distDir)
  const artifact = files.find(find)

  if (!artifact) {
    console.error(`\n  ERROR: No ${platform} artifact found in desktop/dist/`)
    process.exit(1)
  }

  copyFileSync(join(distDir, artifact), join(PUBLIC_DIR, dest))
  console.log(`  ✓ ${artifact} → public/${dest}`)
}

console.log(`\n  ✓ Version: ${newVersion}`)
console.log(`  Deploy with: npx vercel --prod\n`)
