import { NextResponse } from 'next/server'
import { readFile, readdir, access } from 'fs/promises'
import { join } from 'path'

export async function GET() {
  // Try public/ first (works on Vercel)
  const publicExe = join(process.cwd(), 'public', 'PeerMesh-Setup.exe')

  try {
    await access(publicExe)
    const content = await readFile(publicExe)
    return new NextResponse(content.buffer as ArrayBuffer, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="PeerMesh-Setup.exe"',
        'Cache-Control': 'public, max-age=86400',
      },
    })
  } catch {}

  // Try desktop/dist/ (works locally)
  try {
    const distDir = join(process.cwd(), 'desktop', 'dist')
    const files = await readdir(distDir)
    const exe = files.find(f => f.endsWith('.exe') && !f.endsWith('.blockmap'))
    if (exe) {
      const content = await readFile(join(distDir, exe))
      return new NextResponse(content.buffer as ArrayBuffer, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': 'attachment; filename="PeerMesh-Setup.exe"',
        },
      })
    }
  } catch {}

  // Fallback: redirect to GitHub releases if hosted there
  // return NextResponse.redirect('https://github.com/YOUR_USERNAME/peermesh/releases/latest/download/PeerMesh-Setup.exe')

  // Last resort: BAT installer
  try {
    const bat = await readFile(join(process.cwd(), 'provider-agent', 'install-windows.bat'))
    return new NextResponse(bat.buffer as ArrayBuffer, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="peermesh-setup.bat"',
      },
    })
  } catch {
    return NextResponse.json({ error: 'Installer not available' }, { status: 404 })
  }
}
