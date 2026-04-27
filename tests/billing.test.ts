import test from 'node:test'
import assert from 'node:assert/strict'
import { quoteApiUsage } from '../lib/billing.ts'

test('quoteApiUsage returns a positive estimate for standard rotating usage', () => {
  const quote = quoteApiUsage({
    tier: 'standard',
    bandwidthGb: 2,
    rpm: 60,
    periodHours: 1,
    sessionMode: 'rotating',
  })

  assert.equal(quote.ok, true)
  assert.equal(quote.tier, 'standard')
  assert.ok(quote.estimatedUsd > 0)
  assert.equal(quote.constraints.length, 0)
})

test('quoteApiUsage blocks sticky standard keys', () => {
  const quote = quoteApiUsage({
    tier: 'standard',
    bandwidthGb: 1,
    rpm: 120,
    periodHours: 6,
    sessionMode: 'sticky',
  })

  assert.equal(quote.ok, false)
  assert.ok(quote.constraints.some((constraint) => constraint.code === 'sticky_rpm_cap'))
})

test('quoteApiUsage marks advanced sticky usage as requiring verification', () => {
  const quote = quoteApiUsage({
    tier: 'advanced',
    bandwidthGb: 3,
    rpm: 180,
    periodHours: 12,
    sessionMode: 'sticky',
  })

  assert.ok(quote.constraints.some((constraint) => constraint.code === 'tier_sticky_required_verification'))
  assert.ok(quote.estimatedUsd > 0)
})
