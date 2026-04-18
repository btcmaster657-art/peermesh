#!/usr/bin/env node
/**
 * build-save-cli.js
 * Usage:
 *   node build-save-cli.js                  — patch bump + publish
 *   node build-save-cli.js minor            — minor bump + publish
 *   node build-save-cli.js major            — major bump + publish
 *   node build-save-cli.js --no-bump        — publish without version change
 *   node build-save-cli.js --dry-run        — bump only, don't publish
 */

import { execSync } from 'child_process'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI_DIR  = join(__dirname, 'cli')
const PKG_PATH = join(CLI_DIR, 'package.json')
const IDX_PATH = join(CLI_DIR, 'index.js')

// ── Args ──────────────────────────────────────────────────────────────────────

const args     = process.argv.slice(2)
const bumpType = args.find(a => ['major', 'minor', 'patch'].includes(a)) ?? 'patch'
const noBump   = args.includes('--no-bump')
const dryRun   = args.includes('--dry-run')

// ── Version bump ──────────────────────────────────────────────────────────────

const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf-8'))
const currentVersion = pkg.version
const [major, minor, patch] = currentVersion.split('.').map(Number)

let newVersion = currentVersion
if (!noBump) {
  if (bumpType === 'major')      newVersion = `${major + 1}.0.0`
  else if (bumpType === 'minor') newVersion = `${major}.${minor + 1}.0`
  else                           newVersion = `${major}.${minor}.${patch + 1}`

  // Bump cli/package.json
  pkg.version = newVersion
  writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n')

  // Bump VERSION constant in cli/index.js
  let src = readFileSync(IDX_PATH, 'utf-8')
  src = src.replace(/^const VERSION\s*=\s*'[^']+'/m, `const VERSION     = '${newVersion}'`)
  writeFileSync(IDX_PATH, src)

  console.log(`\n  Version: ${currentVersion} → ${newVersion}`)
} else {
  console.log(`\n  Version: ${currentVersion} (no bump)`)
}

if (dryRun) {
  console.log('  ✓ Dry run — skipping publish')
  console.log(`  Run without --dry-run to publish v${newVersion} to npm\n`)
  process.exit(0)
}

// ── Publish to npm ────────────────────────────────────────────────────────────
// Token is read from cli/.npmrc automatically by npm
// To update: edit cli/.npmrc with a new Automation token from
// https://www.npmjs.com/settings/btcmaster1000/tokens

console.log(`\n  Publishing peermesh-provider@${newVersion} to npm...`)

try {
  execSync('npm publish --access public', {
    cwd: CLI_DIR,
    stdio: 'inherit',
  })
} catch {
  process.exit(1)
}

console.log(`\n  ✓ peermesh-provider@${newVersion} published`)
console.log(`  https://www.npmjs.com/package/peermesh-provider`)
console.log(`\n  Users can now run: npx peermesh-provider\n`)
