import type { PeerMeshRole } from './billing.ts'

const ROLE_CAPABILITIES: Record<PeerMeshRole, { canUse: boolean; canProvide: boolean }> = {
  peer: {
    canUse: true,
    canProvide: true,
  },
  host: {
    canUse: false,
    canProvide: true,
  },
  client: {
    canUse: true,
    canProvide: false,
  },
}

export function normalizePeerMeshRole(value: unknown): PeerMeshRole {
  return value === 'peer' || value === 'host' || value === 'client' ? value : 'client'
}

export function canRoleUseNetwork(role: unknown): boolean {
  return ROLE_CAPABILITIES[normalizePeerMeshRole(role)].canUse
}

export function canRoleProvideNetwork(role: unknown): boolean {
  return ROLE_CAPABILITIES[normalizePeerMeshRole(role)].canProvide
}

export function getUsageRoleError(role: unknown): string {
  const normalized = normalizePeerMeshRole(role)
  if (normalized === 'host') {
    return 'Host accounts can only share. Switch to Peer or Client to connect.'
  }
  return 'This account role cannot connect to providers.'
}

export function getProviderRoleError(role: unknown): string {
  const normalized = normalizePeerMeshRole(role)
  if (normalized === 'client') {
    return 'Client accounts cannot share bandwidth. Switch to Peer or Host first.'
  }
  return 'This account role cannot share bandwidth.'
}
