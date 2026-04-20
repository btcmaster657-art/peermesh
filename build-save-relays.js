#!/usr/bin/env node
/**
 * build-save-relays.js
 * Reads RELAY_ENDPOINTS from .env.local and updates lib/relay-endpoints.ts.
 *
 * Clients (desktop, CLI, extension) no longer have hardcoded relay lists —
 * they fetch /api/relay/config at runtime. This script only needs to keep
 * the server-side lib/relay-endpoints.ts in sync with .env.local.
 *
 * Usage:
 *   node build-save-relays.js
 */

import { readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const ENV_PATH       = join(__dirname, '.env.local')
const RELAY_LIB_PATH = join(__dirname, 'lib', 'relay-endpoints.ts')

function parseEnv(filePath) {
  const env = {}
  for (const line of readFileSync(filePath, 'utf-8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = trimmed.match(/^([^=]+)=(.*)$/)
    if (match) env[match[1].trim()] = match[2].trim()
  }
  return env
}

const env = parseEnv(ENV_PATH)
const relayEndpoints = env.RELAY_ENDPOINTS || ''

if (!relayEndpoints) {
  console.error('\n  ERROR: RELAY_ENDPOINTS not found in .env.local\n')
  process.exit(1)
}

const relays = relayEndpoints.split(',').map(s => s.trim()).filter(Boolean)

if (relays.length === 0) {
  console.error('\n  ERROR: RELAY_ENDPOINTS is empty in .env.local\n')
  process.exit(1)
}

console.log(`\n  Found ${relays.length} relay(s) in .env.local:`)
relays.forEach((r, i) => console.log(`    ${i + 1}. ${r}`))

// ── Update lib/relay-endpoints.ts (server-side source of truth) ──────────────

writeFileSync(RELAY_LIB_PATH, `// ── Relay pool ────────────────────────────────────────────────────────────────
// Managed by build-save-relays.js — edit RELAY_ENDPOINTS in .env.local instead.

export const RELAY_ENDPOINTS: string[] = (
  process.env.RELAY_ENDPOINTS ?? '${relays[0]}'
)
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

// ── Health cache ──────────────────────────────────────────────────────────────

interface RelayHealth {
  url: string
  alive: boolean
  peers: number
  sessions: number
  latencyMs: number
  checkedAt: number
}

const HEALTH_TTL = 15_000
const HEALTH_TIMEOUT = 4_000

const healthCache = new Map<string, RelayHealth>()

async function checkRelay(wsUrl: string): Promise<RelayHealth> {
  const httpUrl = wsUrl.replace(/^wss:\\/\\//, 'https://').replace(/^ws:\\/\\//, 'http://')
  const start = Date.now()
  try {
    const res = await fetch(\`\${httpUrl}/health\`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT) })
    const latencyMs = Date.now() - start
    if (!res.ok) throw new Error(\`status=\${res.status}\`)
    const data = await res.json()
    return { url: wsUrl, alive: true, peers: data.peers ?? 0, sessions: data.sessions ?? 0, latencyMs, checkedAt: Date.now() }
  } catch {
    return { url: wsUrl, alive: false, peers: 0, sessions: 0, latencyMs: 9999, checkedAt: Date.now() }
  }
}

async function getHealth(wsUrl: string): Promise<RelayHealth> {
  const cached = healthCache.get(wsUrl)
  if (cached && Date.now() - cached.checkedAt < HEALTH_TTL) return cached
  const health = await checkRelay(wsUrl)
  healthCache.set(wsUrl, health)
  return health
}

function score(h: RelayHealth): number {
  return h.sessions * 10 + h.peers * 1 + h.latencyMs * 0.01
}

export async function pickRelay(): Promise<string> {
  const results = await Promise.all(RELAY_ENDPOINTS.map(getHealth))
  const alive = results.filter(h => h.alive)
  const pool = alive.length > 0 ? alive : results
  pool.sort((a, b) => score(a) - score(b))
  return pool[0].url
}

export async function getRelayFallbackList(): Promise<string[]> {
  const results = await Promise.all(RELAY_ENDPOINTS.map(getHealth))
  const alive = results.filter(h => h.alive)
  const pool = alive.length > 0 ? alive : results
  pool.sort((a, b) => score(a) - score(b))
  return pool.map(h => h.url)
}

export function relayHttpUrl(wsUrl: string): string {
  return wsUrl.replace(/^wss:\\/\\//, 'https://').replace(/^ws:\\/\\//, 'http://')
}
`)
console.log('  ✓ Updated lib/relay-endpoints.ts')

console.log(`
  ✓ Done

  Next steps:
  1. Commit lib/relay-endpoints.ts
  2. Update Vercel env var (Settings → Environment Variables):

       RELAY_ENDPOINTS=${relayEndpoints}

  3. Deploy: npx vercel --prod

  Clients (desktop, CLI, extension) will pick up the new relays
  automatically on their next startup — no reinstall needed.
`)
