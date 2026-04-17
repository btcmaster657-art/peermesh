#!/usr/bin/env node
/**
 * build-save-desktop.js
 * Usage:
 *   node build-save-desktop.js          — patch bump (1.0.0 → 1.0.1)
 *   node build-save-desktop.js minor    — minor bump (1.0.0 → 1.1.0)
 *   node build-save-desktop.js major    — major bump (1.0.0 → 2.0.0)
 *   node build-save-desktop.js --no-bump — build without version change
 */

import { execSync } from 'child_process'
import { readFileSync, writeFileSync, copyFileSync, readdirSync, existsSync } from 'fs'
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

// ── Read current version ──────────────────────────────────────────────────────

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

// ── Build ─────────────────────────────────────────────────────────────────────

console.log(`  Building desktop app v${newVersion}...\n`)

try {
  execSync('npm run build-win', {
    cwd: DESKTOP_DIR,
    stdio: 'inherit',
  })
} catch (e) {
  console.error('\n  Build failed!')
  process.exit(1)
}

// ── Find the built exe ────────────────────────────────────────────────────────

const distDir = join(DESKTOP_DIR, 'dist')
const files = readdirSync(distDir)
const exe = files.find(f => f.endsWith('.exe') && !f.endsWith('.blockmap'))

if (!exe) {
  console.error('\n  ERROR: No .exe found in desktop/dist/')
  process.exit(1)
}

const exePath = join(distDir, exe)
const destPath = join(PUBLIC_DIR, 'PeerMesh-Setup.exe')

// ── Copy to public/ ───────────────────────────────────────────────────────────

copyFileSync(exePath, destPath)

console.log(`\n  ✓ Built: desktop/dist/${exe}`)
console.log(`  ✓ Copied to: public/PeerMesh-Setup.exe`)
console.log(`  ✓ Version: ${newVersion}`)
console.log(`\n  Deploy with: npx vercel --prod\n`)
