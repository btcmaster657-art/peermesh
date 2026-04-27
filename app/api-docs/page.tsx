import Link from 'next/link'

const sectionStyle: React.CSSProperties = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: '12px',
  padding: '16px',
}

function CodeBlock({ code }: { code: string }) {
  return (
    <pre style={{ margin: 0, padding: '12px', background: 'var(--bg)', borderRadius: '8px', overflowX: 'auto', fontSize: '12px', lineHeight: 1.6 }}>
      <code>{code}</code>
    </pre>
  )
}

export default function ApiDocsPage() {
  return (
    <main className="flex flex-1 justify-center px-6 py-16">
      <div style={{ width: '100%', maxWidth: '920px', display: 'grid', gap: '16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '12px', color: 'var(--accent)', letterSpacing: '3px', marginBottom: '6px' }}>
              PEERMESH API
            </div>
            <h1 style={{ margin: 0, fontSize: '24px', fontWeight: 600 }}>Developer documentation</h1>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <Link href="/dashboard" style={{ padding: '9px 12px', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text)', textDecoration: 'none', fontFamily: 'var(--font-geist-mono)', fontSize: '11px' }}>
              DASHBOARD
            </Link>
            <Link href="/verify/payment" style={{ padding: '9px 12px', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text)', textDecoration: 'none', fontFamily: 'var(--font-geist-mono)', fontSize: '11px' }}>
              BILLING
            </Link>
          </div>
        </div>

        <div style={sectionStyle}>
          <div style={{ fontSize: '14px', lineHeight: 1.8, color: 'var(--muted)' }}>
            PeerMesh has two billing layers. User browsing uses the free 5GB monthly allocation plus contribution credits first. Developer API usage is quoted separately and draws from the USD wallet funded through Flutterwave.
          </div>
        </div>

        <div style={sectionStyle}>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: 'var(--accent)', letterSpacing: '1px', marginBottom: '10px' }}>SESSION CREATE</div>
          <CodeBlock code={`POST /api/session/create\nAuthorization: Bearer <supabase access token>\nContent-Type: application/json\n\n{\n  "country": "US"\n}`} />
          <div style={{ fontSize: '13px', color: 'var(--muted)', marginTop: '10px', lineHeight: 1.7 }}>
            For private routing, send <code>privateCode</code> instead of <code>country</code>. A successful response returns the relay endpoint, session id, accountability receipt, and relay fallback list.
          </div>
        </div>

        <div style={sectionStyle}>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: 'var(--accent)', letterSpacing: '1px', marginBottom: '10px' }}>PRICING QUOTE</div>
          <CodeBlock code={`POST /api/billing/quote\nAuthorization: Bearer <supabase access token>\nContent-Type: application/json\n\n{\n  "tier": "advanced",\n  "bandwidthGb": 5,\n  "rpm": 240,\n  "periodHours": 24,\n  "sessionMode": "sticky"\n}`} />
          <div style={{ fontSize: '13px', color: 'var(--muted)', marginTop: '10px', lineHeight: 1.7 }}>
            Quote formula: <code>base_per_gb × rpm_factor × session_factor × period_factor × tier_factor × pressure_factor × bandwidth</code>. Constraint messages are returned when RPM or sticky-session rules are exceeded.
          </div>
        </div>

        <div style={sectionStyle}>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: 'var(--accent)', letterSpacing: '1px', marginBottom: '10px' }}>WALLET TOP-UP</div>
          <CodeBlock code={`POST /api/billing/flutterwave/checkout\nAuthorization: Bearer <supabase access token>\nContent-Type: application/json\n\n{\n  "amountUsd": 25\n}`} />
          <div style={{ fontSize: '13px', color: 'var(--muted)', marginTop: '10px', lineHeight: 1.7 }}>
            The checkout route creates a pending PeerMesh transaction, requests a Flutterwave checkout session, and returns the hosted payment URL. After redirect, verify the transaction through <code>/api/billing/flutterwave/verify</code>.
          </div>
        </div>

        <div style={sectionStyle}>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: 'var(--accent)', letterSpacing: '1px', marginBottom: '10px' }}>COMMON RESPONSES</div>
          <CodeBlock code={`403 FREE LAYER - Enable sharing to connect, or fund your USD wallet to browse without sharing.\n403 Monthly bandwidth limit reached. Wait for reset or fund your USD wallet for higher usage.\n404 Private share code is invalid or expired\n409 No peers available in <country>\n429 The session is sending requests too quickly. Wait a moment and retry.`} />
        </div>

        <div style={sectionStyle}>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: 'var(--accent)', letterSpacing: '1px', marginBottom: '10px' }}>ROLES</div>
          <div style={{ display: 'grid', gap: '8px', fontSize: '13px', color: 'var(--muted)' }}>
            <div><strong style={{ color: 'var(--text)' }}>Peer</strong>: shares and uses the network, earns contribution credits and revenue share.</div>
            <div><strong style={{ color: 'var(--text)' }}>Host</strong>: shares capacity only, earns revenue and payout balance.</div>
            <div><strong style={{ color: 'var(--text)' }}>Client</strong>: uses capacity only, pays from wallet or consumes free and contribution allocations.</div>
          </div>
        </div>
      </div>
    </main>
  )
}
