import test from 'node:test'
import assert from 'node:assert/strict'
import { getConnectionAccessRequirement, hasPaidAccess, hasUsageAccess } from '../lib/account-access.ts'

test('hasPaidAccess recognizes wallet, credits, or premium access', () => {
  assert.equal(hasPaidAccess({ wallet_balance_usd: 0, contribution_credits_bytes: 0, is_premium: false }), false)
  assert.equal(hasPaidAccess({ wallet_balance_usd: 5 }), true)
  assert.equal(hasPaidAccess({ contribution_credits_bytes: 1024 }), true)
  assert.equal(hasPaidAccess({ is_premium: true }), true)
})

test('hasUsageAccess allows sharing even without paid balance', () => {
  assert.equal(hasUsageAccess({ is_sharing: false, wallet_balance_usd: 0, contribution_credits_bytes: 0, is_premium: false }), false)
  assert.equal(hasUsageAccess({ is_sharing: true, wallet_balance_usd: 0, contribution_credits_bytes: 0, is_premium: false }), true)
})

test('getConnectionAccessRequirement requires phone verification before usage access', () => {
  const requirement = getConnectionAccessRequirement({
    is_verified: false,
    is_sharing: false,
    wallet_balance_usd: 0,
    contribution_credits_bytes: 0,
    is_premium: false,
  })

  assert.equal(requirement.ok, false)
  assert.equal(requirement.code, 'phone_verification_required')
  assert.equal(requirement.nextStep, '/verify/phone')
})

test('getConnectionAccessRequirement requires usage access after phone verification', () => {
  const requirement = getConnectionAccessRequirement({
    is_verified: true,
    is_sharing: false,
    wallet_balance_usd: 0,
    contribution_credits_bytes: 0,
    is_premium: false,
  })

  assert.equal(requirement.ok, false)
  assert.equal(requirement.code, 'usage_access_required')
  assert.equal(requirement.nextStep, '/verify/payment')
})

test('getConnectionAccessRequirement allows verified users with sharing or paid access', () => {
  assert.equal(getConnectionAccessRequirement({ is_verified: true, is_sharing: true }).ok, true)
  assert.equal(getConnectionAccessRequirement({ is_verified: true, wallet_balance_usd: 2 }).ok, true)
})
