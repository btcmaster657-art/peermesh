import { NextResponse } from 'next/server'
import { readFile } from 'fs/promises'
import { join } from 'path'

export async function GET() {
  try {
    const agentPath = join(process.cwd(), 'provider-agent', 'agent.js')
    const content = await readFile(agentPath, 'utf-8')

    return new NextResponse(content, {
      headers: {
        'Content-Type': 'application/javascript',
        'Content-Disposition': 'attachment; filename="peermesh-agent.js"',
      },
    })
  } catch {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  }
}
