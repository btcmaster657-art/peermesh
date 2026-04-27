export type PeerMeshRole = 'peer' | 'host' | 'client'
export type ApiSessionMode = 'rotating' | 'sticky'
export type ApiKeyTier = 'standard' | 'advanced' | 'enterprise' | 'contributor'

export type PricingQuoteInput = {
  bandwidthGb: number
  rpm: number
  periodHours: number
  sessionMode: ApiSessionMode
  tier?: ApiKeyTier
}

export type PricingConstraint = {
  code:
    | 'rpm_out_of_range'
    | 'period_out_of_range'
    | 'sticky_rpm_cap'
    | 'tier_rpm_cap'
    | 'tier_sticky_required_verification'
  message: string
}

export type PricingQuote = {
  ok: boolean
  tier: ApiKeyTier
  bandwidthGb: number
  rpm: number
  periodHours: number
  sessionMode: ApiSessionMode
  basePerGbUsd: number
  factors: {
    rpm: number
    session: number
    period: number
    tier: number
    pressure: number
  }
  estimatedUsd: number
  constraints: PricingConstraint[]
}

export type ApiKeyTierConfig = {
  tier: ApiKeyTier
  label: string
  maxRpm: number
  maxStickyRpm: number
  supportsSticky: boolean
  requiresVerification: boolean
  tierFactor: number
}

const BASE_PER_GB_USD = 1

const TIER_CONFIG: Record<ApiKeyTier, ApiKeyTierConfig> = {
  standard: {
    tier: 'standard',
    label: 'Standard',
    maxRpm: 120,
    maxStickyRpm: 0,
    supportsSticky: false,
    requiresVerification: false,
    tierFactor: 1,
  },
  advanced: {
    tier: 'advanced',
    label: 'Advanced',
    maxRpm: 600,
    maxStickyRpm: 240,
    supportsSticky: true,
    requiresVerification: true,
    tierFactor: 1.18,
  },
  enterprise: {
    tier: 'enterprise',
    label: 'Enterprise',
    maxRpm: 2400,
    maxStickyRpm: 1200,
    supportsSticky: true,
    requiresVerification: true,
    tierFactor: 1.45,
  },
  contributor: {
    tier: 'contributor',
    label: 'Contributor',
    maxRpm: 900,
    maxStickyRpm: 300,
    supportsSticky: true,
    requiresVerification: false,
    tierFactor: 0.9,
  },
}

function clampNumber(value: number, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100
}

function rpmFactor(rpm: number): number {
  if (rpm <= 60) return 1
  if (rpm <= 120) return 1.22
  if (rpm <= 240) return 1.58
  if (rpm <= 600) return 2.35
  if (rpm <= 1200) return 3.6
  return 5
}

function sessionFactor(mode: ApiSessionMode): number {
  return mode === 'sticky' ? 1.32 : 1
}

function periodFactor(periodHours: number): number {
  if (periodHours <= 1) return 1
  if (periodHours <= 6) return 1.06
  if (periodHours <= 24) return 1.18
  if (periodHours <= 72) return 1.32
  if (periodHours <= 168) return 1.48
  return 1.72
}

function pressureFactor(rpm: number, periodHours: number, sessionMode: ApiSessionMode): number {
  let factor = 1
  if (rpm >= 600 && periodHours > 24) factor += 0.18
  if (rpm >= 1200 && periodHours > 6) factor += 0.2
  if (sessionMode === 'sticky' && periodHours > 24) factor += 0.12
  return factor
}

export function getApiKeyTierConfig(tier: ApiKeyTier = 'standard'): ApiKeyTierConfig {
  return TIER_CONFIG[tier]
}

export function sharedBytesToCreditBytes(bytesShared: number): number {
  return Math.max(0, Math.floor(Number.isFinite(bytesShared) ? bytesShared : 0))
}

export function bytesToGb(bytes: number): number {
  return bytes / (1024 ** 3)
}

export function quoteApiUsage(input: PricingQuoteInput): PricingQuote {
  const tier = input.tier ?? 'standard'
  const config = getApiKeyTierConfig(tier)
  const bandwidthGb = clampNumber(input.bandwidthGb, 1, 0.05, 1000)
  const rpm = clampNumber(input.rpm, 60, 1, 10000)
  const periodHours = clampNumber(input.periodHours, 1, 1, 24 * 30)
  const sessionMode = input.sessionMode === 'sticky' ? 'sticky' : 'rotating'
  const constraints: PricingConstraint[] = []

  if (rpm > config.maxRpm) {
    constraints.push({
      code: 'tier_rpm_cap',
      message: `${config.label} keys are capped at ${config.maxRpm} RPM.`,
    })
  }

  if (sessionMode === 'sticky' && !config.supportsSticky) {
    constraints.push({
      code: 'sticky_rpm_cap',
      message: `${config.label} keys only support rotating sessions.`,
    })
  }

  if (sessionMode === 'sticky' && rpm > config.maxStickyRpm && config.maxStickyRpm > 0) {
    constraints.push({
      code: 'sticky_rpm_cap',
      message: `Sticky sessions are capped at ${config.maxStickyRpm} RPM for ${config.label} keys.`,
    })
  }

  if (sessionMode === 'sticky' && config.requiresVerification) {
    constraints.push({
      code: 'tier_sticky_required_verification',
      message: `${config.label} sticky sessions require account verification before activation.`,
    })
  }

  const quoteOk = constraints.every((constraint) => constraint.code === 'tier_sticky_required_verification')
  const factors = {
    rpm: rpmFactor(rpm),
    session: sessionFactor(sessionMode),
    period: periodFactor(periodHours),
    tier: config.tierFactor,
    pressure: pressureFactor(rpm, periodHours, sessionMode),
  }
  const estimatedUsd = roundCurrency(
    BASE_PER_GB_USD *
      bandwidthGb *
      factors.rpm *
      factors.session *
      factors.period *
      factors.tier *
      factors.pressure,
  )

  return {
    ok: quoteOk,
    tier,
    bandwidthGb,
    rpm,
    periodHours,
    sessionMode,
    basePerGbUsd: BASE_PER_GB_USD,
    factors,
    estimatedUsd,
    constraints,
  }
}
