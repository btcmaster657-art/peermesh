import { NextResponse } from 'next/server'
import { readdirSync, readFileSync } from 'fs'
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

function getExtensionVersion(): string {
  try {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'extension', 'manifest.json'), 'utf-8'))
    return manifest.version ?? '1.0.0'
  } catch { return '1.0.0' }
}

function getCliVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'cli', 'package.json'), 'utf-8'))
    return pkg.version ?? '1.0.0'
  } catch { return '1.0.0' }
}

export async function GET() {
  return NextResponse.json({
    api: {
      version: 'v1',
      prefix: '/api',
      docs: '/developers/api-docs',
    },
    desktop: getLatestDesktopVersion(),
    extension: getExtensionVersion(),
    cli: getCliVersion(),
  })
}
