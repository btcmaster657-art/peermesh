import { NextResponse } from 'next/server'
import { refreshDeviceSession } from '@/lib/device-sessions'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS })
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const deviceSessionId = typeof body.deviceSessionId === 'string' ? body.deviceSessionId.trim() : ''
  const refreshToken = typeof body.refreshToken === 'string' ? body.refreshToken.trim() : ''

  if (!deviceSessionId || !refreshToken) {
    return NextResponse.json({ error: 'deviceSessionId and refreshToken are required' }, { status: 400, headers: CORS })
  }

  const refreshed = await refreshDeviceSession({ deviceSessionId, refreshToken })
  if (!refreshed.ok) {
    return NextResponse.json({ revoked: true, reason: refreshed.reason }, { status: 403, headers: CORS })
  }

  return NextResponse.json({
    userId: refreshed.userId,
    token: refreshed.token,
    refreshToken: refreshed.refreshToken,
    deviceSessionId: refreshed.deviceSessionId,
    refreshExpiresAt: refreshed.refreshExpiresAt,
  }, { headers: CORS })
}
