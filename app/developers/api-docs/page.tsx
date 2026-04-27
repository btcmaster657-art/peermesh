import { CodeBlock, DeveloperActionLink, DeveloperPageHeader, developerCardStyle, developerGridStyle, developerMonospaceLabelStyle } from '../ui'

const endpointCards = [
  {
    label: 'VERSION',
    path: 'GET /api/version',
    detail: 'Returns the current API version metadata and installable surface versions for the desktop app, browser extension, and CLI.',
    code: `curl https://your-peermesh-domain/api/version`,
  },
  {
    label: 'SESSION CREATE',
    path: 'POST /api/session/create',
    detail: 'Create a routed session for a target country or a private share code. This is the primary integration entry point for external apps.',
    code: `curl -X POST https://your-peermesh-domain/api/session/create \\
  -H "Authorization: Bearer <api-key-or-user-token>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "country": "US",
    "bandwidthGb": 2,
    "rpm": 120,
    "periodHours": 6,
    "sessionMode": "rotating",
    "requestId": "checkout-flow-42"
  }'`,
  },
  {
    label: 'RELAY FINALIZATION',
    path: 'POST /api/session/end',
    detail: 'Relay-side finalization endpoint. PeerMesh meters traffic at the relay and uses those observed bytes for billing and provider payouts. Client-reported bytes are ignored.',
    code: `curl -X POST https://your-peermesh-domain/api/session/end \\
  -H "x-relay-secret: <relay-secret>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "sessionId": "<session-id>",
    "bytesUsed": 73400320,
    "targetHost": "api.example.com",
    "targetHosts": ["api.example.com", "cdn.example.com"],
    "disconnectReason": "completed"
  }'`,
  },
  {
    label: 'API KEYS',
    path: 'GET/POST/PATCH /api/billing/api-keys',
    detail: 'List keys, create a scoped key, and deactivate or reactivate keys without touching the underlying account.',
    code: `curl -X POST https://your-peermesh-domain/api/billing/api-keys \\
  -H "Authorization: Bearer <supabase-access-token>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "Checkout worker",
    "tier": "advanced",
    "rpmLimit": 240,
    "sessionMode": "sticky"
  }'`,
  },
]

const usageFlow = `1. Create or rotate an API key from the Keys page.
2. Quote cost with POST /api/billing/quote before provisioning traffic.
3. Fund the USD wallet with POST /api/billing/flutterwave/checkout.
4. Create a session with POST /api/session/create.
5. Route traffic through the returned relay endpoint.
6. Close the relay connection or tunnel when work is complete.
7. PeerMesh finalizes billing from relay-observed traffic, not developer-reported byte counts.`

const nodeExample = `const baseUrl = 'https://your-peermesh-domain'
const apiKey = process.env.PEERMESH_API_KEY

const create = await fetch(\`\${baseUrl}/api/session/create\`, {
  method: 'POST',
  headers: {
    Authorization: \`Bearer \${apiKey}\`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    country: 'US',
    bandwidthGb: 1,
    rpm: 60,
    periodHours: 1,
    sessionMode: 'rotating',
    requestId: 'job-187',
  }),
})

const session = await create.json()
if (!create.ok) throw new Error(session.error)

// Route your HTTP workload through session.relayEndpoint here.
// When work is complete, close the relay connection.
// PeerMesh meters usage at the relay and settles billing from observed bytes.`

const errorCodes = `401 Unauthorized
403 Confirm your email before connecting.
403 Insufficient wallet balance. Fund the requested API session first.
403 Standard keys only support rotating sessions.
404 Private share code is invalid or expired.
409 No peers available in <country>.
429 The session is sending requests too quickly. Wait and retry.`

export default function DeveloperDocsPage() {
  return (
    <div style={developerGridStyle}>
      <DeveloperPageHeader
        eyebrow="API SURFACE"
        title="PeerMesh integration guide"
        description={
          <>
            PeerMesh exposes a developer-facing API for plugging residential routing into applications, web backends, worker fleets,
            and controlled browser automation. The current API contract is <code>/api</code> with version label <code>v1</code>,
            discoverable from <code>GET /api/version</code>.
          </>
        }
        actions={
          <>
            <DeveloperActionLink href="/developers/keys" label="Manage Keys" />
            <DeveloperActionLink href="/developers/billing" label="Open Billing" />
          </>
        }
      />

      <div style={{ ...developerCardStyle, display: 'grid', gap: '14px' }}>
        <div style={developerMonospaceLabelStyle}>AUTH MODES</div>
        <div style={{ display: 'grid', gap: '8px', fontSize: '14px', color: 'var(--muted)', lineHeight: 1.8 }}>
          <div><strong style={{ color: 'var(--text)' }}>Supabase bearer tokens</strong> are used for authenticated dashboard actions such as billing, key management, and wallet funding.</div>
          <div><strong style={{ color: 'var(--text)' }}>PeerMesh API keys</strong> are used by external systems when creating or ending API-driven sessions.</div>
          <div><strong style={{ color: 'var(--text)' }}>Desktop tokens</strong> remain valid for first-party device surfaces but are not the recommended integration path for third-party apps.</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '16px' }}>
        {endpointCards.map((card) => (
          <div key={card.label} style={{ ...developerCardStyle, display: 'grid', gap: '12px' }}>
            <div style={developerMonospaceLabelStyle}>{card.label}</div>
            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '13px', color: 'var(--text)' }}>{card.path}</div>
            <div style={{ fontSize: '13px', color: 'var(--muted)', lineHeight: 1.8 }}>{card.detail}</div>
            <CodeBlock code={card.code} />
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '16px' }}>
        <div style={{ ...developerCardStyle, display: 'grid', gap: '12px' }}>
          <div style={developerMonospaceLabelStyle}>STANDARD FLOW</div>
          <CodeBlock code={usageFlow} />
        </div>
        <div style={{ ...developerCardStyle, display: 'grid', gap: '12px' }}>
          <div style={developerMonospaceLabelStyle}>COMMON RESPONSES</div>
          <CodeBlock code={errorCodes} />
        </div>
      </div>

      <div style={{ ...developerCardStyle, display: 'grid', gap: '12px' }}>
        <div style={developerMonospaceLabelStyle}>NODE EXAMPLE</div>
        <CodeBlock code={nodeExample} />
      </div>
    </div>
  )
}
