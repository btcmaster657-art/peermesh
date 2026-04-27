import test from 'node:test'
import assert from 'node:assert/strict'
import { buildOccupiedProviderDeviceSet, filterAvailableProviderDevices } from '../lib/provider-capacity.ts'

test('buildOccupiedProviderDeviceSet ignores null provider slots', () => {
  const occupied = buildOccupiedProviderDeviceSet([
    { provider_device_id: 'slot_a' },
    { provider_device_id: null },
    { provider_device_id: 'slot_b' },
  ])

  assert.deepEqual([...occupied].sort(), ['slot_a', 'slot_b'])
})

test('filterAvailableProviderDevices removes occupied devices from counts', () => {
  const devices = [
    { user_id: 'u1', device_id: 'slot_a', country_code: 'US', relay_url: 'wss://relay-a' },
    { user_id: 'u2', device_id: 'slot_b', country_code: 'US', relay_url: 'wss://relay-b' },
    { user_id: 'u3', device_id: 'slot_c', country_code: 'NG', relay_url: null },
  ]
  const occupied = new Set(['slot_b'])

  const available = filterAvailableProviderDevices(devices, occupied)

  assert.deepEqual(available.map((device) => device.device_id), ['slot_a', 'slot_c'])
})
