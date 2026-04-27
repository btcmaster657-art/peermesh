import type { User } from '@supabase/supabase-js'
import { extractApiKeyFromRequest, isPeerMeshApiKey, resolveApiKey, type ResolvedApiKey } from '@/lib/api-keys'
import { resolveBearerUser } from '@/lib/device-sessions'
import { adminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'

export type RequesterAuthKind = 'supabase' | 'desktop' | 'api_key'

export type RequesterAuthContext = {
  kind: RequesterAuthKind
  userId: string
  emailConfirmed: boolean
  user: User | null
  apiKey: ResolvedApiKey | null
}

export async function resolveAuthTokenUser(token: string): Promise<RequesterAuthContext | null> {
  const normalized = token.trim()
  if (!normalized) return null

  if (isPeerMeshApiKey(normalized)) {
    const apiKey = await resolveApiKey(normalized)
    if (!apiKey) return null
    return {
      kind: 'api_key',
      userId: apiKey.userId,
      emailConfirmed: true,
      user: null,
      apiKey,
    }
  }

  const desktop = await resolveBearerUser(normalized)
  if (desktop.authKind === 'desktop' && desktop.userId) {
    return {
      kind: 'desktop',
      userId: desktop.userId,
      emailConfirmed: true,
      user: null,
      apiKey: null,
    }
  }

  try {
    const { data } = await adminClient.auth.getUser(normalized)
    if (!data.user?.id) return null
    return {
      kind: 'supabase',
      userId: data.user.id,
      emailConfirmed: !!data.user.email_confirmed_at,
      user: data.user,
      apiKey: null,
    }
  } catch {
    return null
  }
}

export async function resolveRequesterAuth(req: Request): Promise<RequesterAuthContext | null> {
  const rawApiKey = extractApiKeyFromRequest(req)
  if (rawApiKey) {
    return resolveAuthTokenUser(rawApiKey)
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (user?.id) {
    return {
      kind: 'supabase',
      userId: user.id,
      emailConfirmed: !!user.email_confirmed_at,
      user,
      apiKey: null,
    }
  }

  const authHeader = req.headers.get('authorization') ?? ''
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  if (!bearer) return null

  return resolveAuthTokenUser(bearer)
}
