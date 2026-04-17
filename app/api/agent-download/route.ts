import { NextResponse } from 'next/server'
import { readFile } from 'fs/promises'
import { join } from 'path'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const installer = searchParams.get('installer')

  try {
    if (installer === 'windows') {
      const content = await readFile(join(process.cwd(), 'provider-agent', 'install-windows.bat'))
      return new NextResponse(content, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': 'attachment; filename="peermesh-setup.bat"',
        },
      })
    }

    if (installer === 'mac') {
      const content = await readFile(join(process.cwd(), 'provider-agent', 'install-mac.sh'))
      return new NextResponse(content, {
        headers: {
          'Content-Type': 'text/x-sh',
          'Content-Disposition': 'attachment; filename="peermesh-setup.sh"',
        },
      })
    }

    // Default: serve agent.js directly
    const agentPath = join(process.cwd(), 'provider-agent', 'agent.js')
    const content = await readFile(agentPath, 'utf-8')
    return new NextResponse(content, {
      headers: {
        'Content-Type': 'application/javascript',
        'Content-Disposition': 'attachment; filename="peermesh-agent.js"',
      },
    })
  } catch {
    return NextResponse.json({ error: 'File not found' }, { status: 404 })
  }
}
