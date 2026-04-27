import { NextResponse } from 'next/server'
import { readFile, readdir } from 'fs/promises'
import { join } from 'path'

type Platform = 'win' | 'mac' | 'linux'

const PLATFORM_MIME: Record<Platform, string> = {
  win:   'application/octet-stream',
  mac:   'application/x-apple-diskimage',
  linux: 'application/octet-stream',
}

const PLATFORM_EXT: Record<Platform, string> = {
  win:   '.exe',
  mac:   '.dmg',
  linux: '.AppImage',
}

async function findLatestInstaller(dir: string, ext: string): Promise<string | null> {
  try {
    const files = (await readdir(dir)).filter((file) => file.startsWith('PeerMesh-Setup_') && file.endsWith(ext))
    if (!files.length) return null
    files.sort().reverse()
    return files[0]
  } catch { return null }
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
  const platform: Platform = (override && override in PLATFORM_MIME) ? override : detectPlatform(ua)

  const mime = PLATFORM_MIME[platform]
  const ext = PLATFORM_EXT[platform]

  // Try public/ first (Vercel)
  const publicDir = join(process.cwd(), 'public')
  const publicFile = await findLatestInstaller(publicDir, ext)
  if (publicFile) {
    const content = await readFile(join(publicDir, publicFile))
    return new NextResponse(content, {
      headers: {
        'Content-Type': mime,
        'Content-Disposition': `attachment; filename="${publicFile}"`,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'X-Platform': platform,
      },
    })
  }

  // Try desktop/dist/ (local dev)
  try {
    const distDir = join(process.cwd(), 'desktop', 'dist')
    const found = await findLatestInstaller(distDir, ext)
    if (found) {
      const content = await readFile(join(distDir, found))
      return new NextResponse(content, {
        headers: {
          'Content-Type': mime,
          'Content-Disposition': `attachment; filename="${found}"`,
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
