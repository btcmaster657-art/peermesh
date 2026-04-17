import { NextResponse } from 'next/server'
import { readdirSync } from 'fs'
import { join } from 'path'

function getLatestDesktopVersion(): string | null {
  try {
    const files = readdirSync(join(process.cwd(), 'public'))
    const exes = files.filter(f => f.startsWith('PeerMesh-Setup_') && f.endsWith('.exe'))
    if (!exes.length) return null
    exes.sort().reverse()
    const match = exes[0].match(/PeerMesh-Setup_(.+)\.exe/)
    return match?.[1] ?? null
  } catch { return null }
}

export async function GET() {
  return NextResponse.json({
    desktop: getLatestDesktopVersion(),
    extension: '1.0.0',
  })
}
