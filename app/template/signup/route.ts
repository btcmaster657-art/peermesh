import { NextResponse } from 'next/server'

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get('token') ?? '------'
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Confirm your PeerMesh email</title>
<style>
  body { margin:0; padding:0; background:#0a0a0f; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
  .wrap { max-width:480px; margin:40px auto; background:#13131a; border:1px solid #1e1e2a; border-radius:16px; overflow:hidden; }
  .header { background:#0a0a0f; padding:28px 32px; border-bottom:1px solid #1e1e2a; }
  .logo { font-family:'Courier New',monospace; color:#00ff88; font-size:13px; letter-spacing:4px; }
  .body { padding:32px; }
  h1 { color:#e8e8f0; font-size:20px; font-weight:600; margin:0 0 12px; }
  p { color:#666680; font-size:14px; line-height:1.7; margin:0 0 24px; }
  .token-box { background:#0a0a0f; border:1px solid #1e1e2a; border-radius:12px; padding:24px; text-align:center; margin:0 0 24px; }
  .token { font-family:'Courier New',monospace; font-size:36px; font-weight:700; letter-spacing:10px; color:#00ff88; }
  .expiry { font-family:'Courier New',monospace; font-size:11px; color:#666680; margin-top:8px; }
  .footer { padding:20px 32px; border-top:1px solid #1e1e2a; }
  .footer p { font-size:11px; color:#444460; margin:0; }
</style>
</head>
<body>
<div class="wrap">
  <div class="header"><div class="logo">PEERMESH</div></div>
  <div class="body">
    <h1>Confirm your email</h1>
    <p>Welcome to PeerMesh. Enter the code below to confirm your email address. It expires in <strong style="color:#e8e8f0">15 minutes</strong>.</p>
    <div class="token-box">
      <div class="token">${token}</div>
      <div class="expiry">EXPIRES IN 15 MINUTES</div>
    </div>
    <p>If you didn't create a PeerMesh account, you can safely ignore this email.</p>
  </div>
  <div class="footer">
    <p>PeerMesh — Share your connection. Stay free.</p>
  </div>
</div>
</body>
</html>`

  return new NextResponse(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}
