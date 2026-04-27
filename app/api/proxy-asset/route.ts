import { NextResponse } from 'next/server'

// Blocked to prevent SSRF
const BLOCKED_HOSTS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
]

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  let target = searchParams.get('url')
  if (!target) return new NextResponse('Missing url', { status: 400 })

  // Decode HTML entities in URL (e.g. &amp; → &)
  target = target.replace(/&amp;/g, '&')

  // Fix double-encoding: unwrap nested proxy-asset URLs
  while (target && target.includes('/api/proxy-asset')) {
    try {
      const t: string = target.startsWith('http') ? target : `http://localhost${target}`
      const inner = new URL(t)
      const innerUrl = inner.searchParams.get('url')
      if (!innerUrl || innerUrl === target) break
      target = innerUrl
    } catch { break }
  }

  try {
    const url = new URL(target)

    if (!['http:', 'https:'].includes(url.protocol)) {
      return new NextResponse('Protocol not allowed', { status: 403 })
    }

    if (BLOCKED_HOSTS.some(p => p.test(url.hostname))) {
      return new NextResponse('Host not allowed', { status: 403 })
    }

    const res = await fetch(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.5',
        'Referer': url.origin,
        'Origin': url.origin,
      },
      redirect: 'follow',
    })

    const contentType = res.headers.get('content-type') ?? 'application/octet-stream'
    const body = await res.arrayBuffer()

    return new NextResponse(body, {
      status: res.status,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET',
      },
    })
  } catch {
    return new NextResponse('Fetch failed', { status: 502 })
  }
}
