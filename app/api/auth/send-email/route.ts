import { NextResponse } from 'next/server'

const RESEND_API_KEY = process.env.RESEND_API_KEY ?? ''
const FROM_EMAIL     = process.env.FROM_EMAIL ?? 'noreply@peermesh.app'

export async function POST(req: Request) {
  const { to, subject, html } = await req.json().catch(() => ({}))
  if (!to || !subject || !html) {
    return new NextResponse(JSON.stringify({ error: 'to, subject and html are required' }), { 
      status: 400,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    })
  }

  if (RESEND_API_KEY) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({ from: `PeerMesh <${FROM_EMAIL}>`, to, subject, html }),
    })
    if (!res.ok) {
      const err = await res.text().catch(() => '')
      console.error('[send-email] Resend error', res.status, err)
      return new NextResponse(JSON.stringify({ error: 'Could not send email' }), { 
        status: 500,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      })
    }
    return new NextResponse(JSON.stringify({ success: true }), { 
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    })
  }

  // Fallback: log in dev
  console.log(`[send-email] DEV — to=${to} subject=${subject}`)
  console.log(`[send-email] html=${html.slice(0, 200)}`)
  return new NextResponse(JSON.stringify({ success: true }), { 
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  })
}
