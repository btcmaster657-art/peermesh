export type ProviderDeviceRow = {
  user_id: string
  device_id: string
  country_code: string
  relay_url: string | null
}

export type SessionOccupancyRow = {
  provider_device_id: string | null
}

export function buildOccupiedProviderDeviceSet(rows: SessionOccupancyRow[] | null | undefined): Set<string> {
  const occupied = new Set<string>()
  for (const row of rows ?? []) {
    if (!row?.provider_device_id) continue
    occupied.add(row.provider_device_id)
  }
  return occupied
}

export function filterAvailableProviderDevices(
  devices: ProviderDeviceRow[] | null | undefined,
  occupied: Set<string>,
): ProviderDeviceRow[] {
  return (devices ?? []).filter((device) => !occupied.has(device.device_id))
}
