import test from 'node:test'
import assert from 'node:assert/strict'
import { checkRateLimit, clearRateLimit } from '../lib/traffic-filter.ts'

test('checkRateLimit allows up to 100 requests per minute', () => {
  const sessionId = 'session-rate-limit-test'
  clearRateLimit(sessionId)

  for (let index = 0; index < 100; index++) {
    assert.equal(checkRateLimit(sessionId), true)
  }

  assert.equal(checkRateLimit(sessionId), false)
  clearRateLimit(sessionId)
})
