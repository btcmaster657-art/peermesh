import { NextResponse } from 'next/server'
import { readFile, access } from 'fs/promises'
import { join } from 'path'

type Platform = 'win' | 'mac' | 'linux'

const PLATFORM_MAP: Record<Platform, { file: string; name: string; mime: string }> = {
  win:   { file: 'PeerMesh-Setup.exe',      name: 'PeerMesh-Setup.exe',      mime: 'application/octet-stream' },
  mac:   { file: 'PeerMesh-Setup.dmg',      name: 'PeerMesh-Setup.dmg',      mime: 'application/x-apple-diskimage' },
  linux: { file: 'PeerMesh-Setup.AppImage', name: 'PeerMesh-Setup.AppImage', mime: 'application/octet-stream' },
}

function detectPlatform(ua: string): Platform {
  if (/linux/i.test(ua) && !/android/i.test(ua)) return 'linux'
  if (/mac os x|macintosh/i.test(ua)) return 'mac'
  return 'win' // default to Windows
}

export async function GET(req: Request) {
  const ua = req.headers.get('user-agent') ?? ''

  // Allow override via ?platform=win|mac|linux
  const { searchParams } = new URL(req.url)
  const override = searchParams.get('platform') as Platform | null
  const platform: Platform = (override && override in PLATFORM_MAP) ? override : detectPlatform(ua)

  const { file, name, mime } = PLATFORM_MAP[platform]

  // Try public/ first (Vercel)
  const publicPath = join(process.cwd(), 'public', file)
  try {
    await access(publicPath)
    const content = await readFile(publicPath)
    return new NextResponse(content.buffer as ArrayBuffer, {
      headers: {
        'Content-Type': mime,
        'Content-Disposition': `attachment; filename="${name}"`,
        'Cache-Control': 'public, max-age=86400',
        'X-Platform': platform,
      },
    })
  } catch {}

  // Try desktop/dist/ (local dev)
  try {
    const { readdirSync } = await import('fs')
    const distDir = join(process.cwd(), 'desktop', 'dist')
    const finders: Record<Platform, (f: string) => boolean> = {
      win:   f => f.endsWith('.exe') && !f.endsWith('.blockmap'),
      mac:   f => f.endsWith('.dmg'),
      linux: f => f.endsWith('.AppImage'),
    }
    const found = readdirSync(distDir).find(finders[platform])
    if (found) {
      const content = await readFile(join(distDir, found))
      return new NextResponse(content.buffer as ArrayBuffer, {
        headers: {
          'Content-Type': mime,
          'Content-Disposition': `attachment; filename="${name}"`,
          'X-Platform': platform,
        },
      })
    }
  } catch {}

  return NextResponse.json(
    { error: `Installer not available for ${platform}`, platform },
    { status: 404 }
  )
}
