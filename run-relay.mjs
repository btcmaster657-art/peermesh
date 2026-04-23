#!/usr/bin/env node
/**
 * run-relay.mjs — start the PeerMesh relay with the correct environment
 *
 * Usage:
 *   node run-relay.mjs              — uses PEERMESH_ENV from .env.local
 *   node run-relay.mjs --local      — force local  (API_BASE_LOCAL, port 8080)
 *   node run-relay.mjs --dev        — force dev    (API_BASE_DEV,   port 8080)
 *   node run-relay.mjs --prod       — force prod   (API_BASE,       port from env)
 *   node run-relay.mjs --port 9090  — override port
 *   node run-relay.mjs --watch      — restart on relay.js changes (dev only)
 *
 * The relay process inherits all resolved env vars so relay.js reads them
 * via process.env without any changes to relay.js itself.
 */

import { spawn } from 'child_process'
import { networkInterfaces } from 'os'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { API_BASE, RELAY_SECRET, ENV, IS_LOCAL, IS_DEV } from './lib/env.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── CLI overrides ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const forceLocal = args.includes('--local')
const forceDev   = args.includes('--dev')
const forceProd  = args.includes('--prod')
const watchMode  = args.includes('--watch')
const portIdx    = args.indexOf('--port')
const portOverride = portIdx !== -1 ? parseInt(args[portIdx + 1], 10) : null

// Apply force flags by overriding PEERMESH_ENV before env.mjs already ran —
// we just re-resolve API_BASE here directly from process.env since env.mjs
// already loaded .env.local into process.env.
let resolvedApiBase = API_BASE
let resolvedEnv = ENV

if (forceLocal) {
  resolvedApiBase = process.env.API_BASE_LOCAL
  resolvedEnv = 'local'
  if (!resolvedApiBase) { console.error('  ✗ API_BASE_LOCAL is not set'); process.exit(1) }
} else if (forceDev) {
  resolvedApiBase = process.env.API_BASE_DEV
  resolvedEnv = 'dev'
  if (!resolvedApiBase) { console.error('  ✗ API_BASE_DEV is not set'); process.exit(1) }
} else if (forceProd) {
  resolvedApiBase = process.env.API_BASE
  resolvedEnv = 'production'
  if (!resolvedApiBase) { console.error('  ✗ API_BASE is not set'); process.exit(1) }
}

const PORT = portOverride ?? parseInt(process.env.PORT ?? '8080', 10)

// ── Print startup info ────────────────────────────────────────────────────────
const G = '\x1b[32m', C = '\x1b[36m', Y = '\x1b[33m', R = '\x1b[0m', B = '\x1b[1m', D = '\x1b[90m'

console.log(`\n${B}  PeerMesh Relay${R}`)
console.log(`  ${D}env${R}        ${C}${resolvedEnv}${R}`)
console.log(`  ${D}API_BASE${R}   ${G}${resolvedApiBase}${R}`)
console.log(`  ${D}port${R}       ${G}${PORT}${R}`)
console.log(`  ${D}watch${R}      ${watchMode ? G + 'yes' : D + 'no'}${R}`)

// Print all LAN addresses so you can point mobile/other devices at this relay
const nets = networkInterfaces()
const lanAddrs = []
for (const iface of Object.values(nets)) {
  for (const addr of iface ?? []) {
    if (addr.family === 'IPv4' && !addr.internal) lanAddrs.push(addr.address)
  }
}

console.log(`\n  ${B}Relay endpoints:${R}`)
console.log(`    ${G}ws://localhost:${PORT}${R}          ${D}← localhost${R}`)
for (const ip of lanAddrs) {
  console.log(`    ${G}ws://${ip}:${PORT}${R}  ${D}← LAN / other devices${R}`)
}

if (resolvedEnv === 'local') {
  console.log(`\n  ${Y}Tip:${R} set RELAY_ENDPOINTS_LOCAL=ws://<your-LAN-ip>:${PORT} in .env.local`)
  console.log(`       so the CLI and desktop app on other machines find this relay.`)
}

console.log('')

// ── Spawn relay.js with resolved env ─────────────────────────────────────────
const relayPath = resolve(__dirname, 'relay', 'relay.js')

const nodeArgs = watchMode ? ['--watch', relayPath] : [relayPath]

const child = spawn('node', nodeArgs, {
  env: {
    ...process.env,
    PORT:         String(PORT),
    API_BASE:     resolvedApiBase,
    RELAY_SECRET: RELAY_SECRET ?? '',
    PEERMESH_ENV: resolvedEnv,
  },
  stdio: 'inherit',
  cwd: resolve(__dirname, 'relay'),
})

child.on('exit', (code, signal) => {
  if (signal) console.log(`\n  Relay stopped (signal: ${signal})`)
  else if (code !== 0) console.log(`\n  Relay exited with code ${code}`)
  process.exit(code ?? 0)
})

process.on('SIGINT',  () => child.kill('SIGINT'))
process.on('SIGTERM', () => child.kill('SIGTERM'))
