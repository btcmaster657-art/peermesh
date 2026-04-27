import { createHash, randomBytes } from 'crypto'
import type { ApiKeyTier, ApiSessionMode } from '@/lib/billing'
import { adminClient } from '@/lib/supabase/admin'

const API_KEY_PREFIX = 'pmk_live_'
const API_KEY_RANDOM_BYTES = 24

type ApiKeyRow = {
  id: string
  user_id: string
  name: string
  key_prefix: string
  tier: ApiKeyTier
  rpm_limit: number
  session_mode: ApiSessionMode
  requires_verification: boolean
  is_active: boolean
  last_used_at: string | null
  created_at: string
}

export type ResolvedApiKey = {
  id: string
  userId: string
  name: string
  keyPrefix: string
  tier: ApiKeyTier
  rpmLimit: number
  sessionMode: ApiSessionMode
  requiresVerification: boolean
  isActive: boolean
  lastUsedAt: string | null
  createdAt: string
}

function normalizeRawApiKey(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function toResolvedApiKey(row: ApiKeyRow): ResolvedApiKey {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    keyPrefix: row.key_prefix,
    tier: row.tier,
    rpmLimit: Number(row.rpm_limit ?? 0),
    sessionMode: row.session_mode,
    requiresVerification: row.requires_verification === true,
    isActive: row.is_active === true,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
  }
}

export function isPeerMeshApiKey(value: unknown): boolean {
  return normalizeRawApiKey(value).startsWith(API_KEY_PREFIX)
}

export function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex')
}

export function extractApiKeyFromRequest(req: Request): string {
  const headerKey = normalizeRawApiKey(req.headers.get('x-api-key'))
  if (headerKey) return headerKey

  const authHeader = req.headers.get('authorization') ?? ''
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  return isPeerMeshApiKey(bearer) ? bearer : ''
}

export async function resolveApiKey(rawKey: string): Promise<ResolvedApiKey | null> {
  const normalized = normalizeRawApiKey(rawKey)
  if (!isPeerMeshApiKey(normalized)) return null

  const { data, error } = await adminClient
    .from('api_keys')
    .select('id, user_id, name, key_prefix, tier, rpm_limit, session_mode, requires_verification, is_active, last_used_at, created_at')
    .eq('key_hash', hashApiKey(normalized))
    .maybeSingle<ApiKeyRow>()

  if (error || !data || data.is_active !== true) return null
  return toResolvedApiKey(data)
}

export async function touchApiKeyLastUsed(apiKeyId: string): Promise<void> {
  if (!apiKeyId) return
  await adminClient
    .from('api_keys')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', apiKeyId)
}

export async function createApiKey(input: {
  userId: string
  name: string
  tier: ApiKeyTier
  rpmLimit: number
  sessionMode: ApiSessionMode
  requiresVerification: boolean
}): Promise<{ key: string; record: ResolvedApiKey }> {
  const rawKey = `${API_KEY_PREFIX}${randomBytes(API_KEY_RANDOM_BYTES).toString('base64url')}`
  const keyPrefix = rawKey.slice(0, 18)

  const { data, error } = await adminClient
    .from('api_keys')
    .insert({
      user_id: input.userId,
      name: input.name,
      key_hash: hashApiKey(rawKey),
      key_prefix: keyPrefix,
      tier: input.tier,
      rpm_limit: input.rpmLimit,
      session_mode: input.sessionMode,
      requires_verification: input.requiresVerification,
      is_active: true,
    })
    .select('id, user_id, name, key_prefix, tier, rpm_limit, session_mode, requires_verification, is_active, last_used_at, created_at')
    .single<ApiKeyRow>()

  if (error || !data) {
    throw new Error(error?.message ?? 'Could not create API key')
  }

  return {
    key: rawKey,
    record: toResolvedApiKey(data),
  }
}
