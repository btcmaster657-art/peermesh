// lib/env.mjs — central env resolution for all build scripts and Node.js clients
// Loads .env.local (then .env as fallback) from repo root.
// Resolves the correct API_BASE, RELAY_ENDPOINTS, RELAY_SECRET
// based on PEERMESH_ENV (production | dev | local).
// Import this at the top of every build script instead of reading process.env directly.

import { readFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ── Load .env.local / .env into process.env ───────────────────────────────────
for (const name of ['.env.local', '.env']) {
  const file = resolve(ROOT, name)
  if (!existsSync(file)) continue
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 1) continue
    const key = line.slice(0, eq).trim()
    const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
    if (!(key in process.env)) process.env[key] = val
  }
  break
}

// ── Resolve per-environment values ────────────────────────────────────────────
export const ENV = (process.env.PEERMESH_ENV ?? 'production').toLowerCase()

export const IS_PROD  = ENV === 'production'
export const IS_DEV   = ENV === 'dev'
export const IS_LOCAL = ENV === 'local'

function get(name, required = true) {
  const value = process.env[name]
  if (!value && required) {
    console.error(`  ✗ ${name} is not set (PEERMESH_ENV=${ENV})`)
    process.exit(1)
  }
  return value ?? null
}

export const API_BASE = IS_LOCAL
  ? get('API_BASE_LOCAL')
  : IS_DEV
    ? get('API_BASE_DEV')
    : get('API_BASE')

export const RELAY_SECRET = get('RELAY_SECRET')

const rawRelays = IS_LOCAL
  ? get('RELAY_ENDPOINTS_LOCAL')
  : IS_DEV
    ? get('RELAY_ENDPOINTS_DEV')
    : get('RELAY_ENDPOINTS')

export const RELAY_ENDPOINTS = rawRelays.split(',').map(r => r.trim()).filter(Boolean)

export const NEXT_PUBLIC_APP_URL = IS_LOCAL
  ? (process.env.API_BASE_LOCAL ?? API_BASE)
  : IS_DEV
    ? (process.env.API_BASE_DEV ?? API_BASE)
    : (process.env.API_BASE ?? API_BASE)
