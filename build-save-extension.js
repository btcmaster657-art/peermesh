#!/usr/bin/env node
/**
 * build-save-extension.js
 * Usage:
 *   node build-save-extension.js           — patch bump
 *   node build-save-extension.js minor     — minor bump
 *   node build-save-extension.js major     — major bump
 *   node build-save-extension.js --no-bump — no version change
 */

import { readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MANIFEST_PATH = join(__dirname, 'extension', 'manifest.json')

const args = process.argv.slice(2)
const bumpType = args.find(a => ['major', 'minor', 'patch'].includes(a)) ?? 'patch'
const noBump = args.includes('--no-bump')

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'))
const currentVersion = manifest.version
const [major, minor, patch] = currentVersion.split('.').map(Number)

let newVersion = currentVersion
if (!noBump) {
  if (bumpType === 'major') newVersion = `${major + 1}.0.0`
  else if (bumpType === 'minor') newVersion = `${major}.${minor + 1}.0`
  else newVersion = `${major}.${minor}.${patch + 1}`

  manifest.version = newVersion
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n')
  console.log(`\n  Version: ${currentVersion} → ${newVersion}`)
} else {
  console.log(`\n  Version: ${currentVersion} (no bump)`)
}

console.log(`  ✓ manifest.json updated`)
console.log(`  Reload the extension at chrome://extensions then deploy with: npx vercel --prod\n`)
