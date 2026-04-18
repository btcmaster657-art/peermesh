export type Profile = {
  id: string
  username: string | null
  country_code: string
  trust_score: number
  is_verified: boolean
  verified_at: string | null
  phone_number: string | null
  gov_id_verified: boolean
  is_premium: boolean
  subscription_status: string
  stripe_customer_id: string | null
  is_sharing: boolean
  total_bytes_shared: number
  total_bytes_used: number
  bandwidth_used_month: number
  bandwidth_limit: number
  preferred_providers: Record<string, string>
  has_accepted_provider_terms: boolean
  daily_share_limit_mb: number | null
  created_at: string
  updated_at: string
}

export type Session = {
  id: string
  user_id: string
  provider_id: string | null
  target_country: string
  relay_endpoint: string | null
  status: 'pending' | 'active' | 'ended' | 'flagged'
  bytes_used: number
  signed_receipt: string | null
  started_at: string
  ended_at: string | null
}

export type PeerAvailability = {
  country: string
  count: number
}
