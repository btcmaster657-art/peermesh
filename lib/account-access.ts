export type ConnectionAccessProfile = {
  is_verified?: boolean | null
  is_sharing?: boolean | null
  is_premium?: boolean | null
  wallet_balance_usd?: number | string | null
  contribution_credits_bytes?: number | string | null
}

export type ConnectionAccessRequirement = {
  ok: boolean
  code: 'phone_verification_required' | 'usage_access_required' | null
  error: string | null
  nextStep: '/verify/phone' | '/verify/payment' | null
}

export function hasPaidAccess(profile: ConnectionAccessProfile | null | undefined): boolean {
  return Number(profile?.wallet_balance_usd ?? 0) > 0
    || Number(profile?.contribution_credits_bytes ?? 0) > 0
    || !!profile?.is_premium
}

export function hasUsageAccess(profile: ConnectionAccessProfile | null | undefined): boolean {
  return hasPaidAccess(profile) || !!profile?.is_sharing
}

export function getConnectionAccessRequirement(
  profile: ConnectionAccessProfile | null | undefined,
): ConnectionAccessRequirement {
  if (!profile?.is_verified) {
    return {
      ok: false,
      code: 'phone_verification_required',
      error: 'Verify your phone to connect to providers.',
      nextStep: '/verify/phone',
    }
  }

  if (!hasUsageAccess(profile)) {
    return {
      ok: false,
      code: 'usage_access_required',
      error: 'FREE LAYER - Enable sharing to connect, or fund your USD wallet to browse without sharing.',
      nextStep: '/verify/payment',
    }
  }

  return {
    ok: true,
    code: null,
    error: null,
    nextStep: null,
  }
}
