# PeerMesh — Project Audit

**Build status:** ✅ Compiles clean · Zero type errors
**Stack:** Next.js 16 (App Router) · TypeScript · Supabase · Tailwind v4 · WebRTC · Node.js relay · Chrome Extension

---

## What This Is

A peer-to-peer location exchange network. Users share their internet connection and in return can browse the web appearing to come from any country where peers exist. A $1 one-time verified identity + phone verification ensures every IP in the network belongs to a real accountable person.

**Two client interfaces — same backend:**
- **Website** (`/browse`) — iframe proxy, works for most sites, no install required
- **Chrome Extension** — sets Chrome's system proxy, routes ALL tabs through peer's real IP, YouTube/Google/everything works

---

## Directory Structure

```
peermesh/
├── app/                          Next.js App Router
│   ├── page.tsx                  Landing page
│   ├── layout.tsx                Root layout
│   ├── globals.css               Dark theme CSS variables
│   ├── auth/
│   │   ├── page.tsx              Auth page (Suspense wrapper)
│   │   └── AuthForm.tsx          Sign in / Sign up (client component)
│   ├── verify/
│   │   ├── phone/page.tsx        Phone OTP step
│   │   └── payment/page.tsx      $1 payment step
│   ├── dashboard/
│   │   └── page.tsx              Main dashboard (country picker, connect, share toggle)
│   ├── browse/
│   │   ├── page.tsx              Suspense wrapper
│   │   └── BrowseView.tsx        Iframe proxy browser (client component)
│   ├── extension/
│   │   ├── page.tsx              Extension install page
│   │   └── ExtensionPageClient.tsx  Download/install flow with toast
│   └── api/
│       ├── auth/signout/         POST — sign out
│       ├── verify/phone/         POST — OTP send/verify (bypass: 123456)
│       ├── verify/payment/       POST — activate account (bypass: skip Stripe)
│       ├── peers/available/      GET  — peer counts by country (excludes self)
│       ├── session/create/       POST — create session + accountability receipt
│       ├── session/end/          POST — end session, log bytes
│       ├── user/sharing/         POST — toggle is_sharing
│       ├── abuse/report/         POST — file abuse report, dock trust score
│       ├── proxy-asset/          GET  — server-side asset proxy (no auth, CORS open)
│       ├── proxy-fetch/          POST — server-side fetch proxy with script inlining
│       ├── agent-token/          GET  — returns user's access token for agent
│       ├── agent-download/       GET  — serves provider-agent/agent.js for download
│       ├── extension-auth/       GET  — returns user profile+token for extension (CORS open)
│       └── extension-download/   GET  — builds and serves extension ZIP dynamically
├── lib/
│   ├── supabase/
│   │   ├── client.ts             Browser Supabase client
│   │   ├── server.ts             Server Supabase client (cookie-aware)
│   │   └── admin.ts              Service role client (bypasses RLS)
│   ├── types.ts                  Profile, Session, PeerAvailability types
│   ├── utils.ts                  formatBytes(), COUNTRIES list, getFlagForCountry()
│   ├── traffic-filter.ts         isRequestAllowed(), isUserTrusted(), checkRateLimit()
│   ├── peer-requester.ts         WebRTC/agent-mode requester class
│   ├── peer-provider.ts          WebRTC provider class (browser-based sharing)
│   └── agent-client.ts           checkAgent(), startAgent(), stopAgent() for localhost:7654
├── relay/
│   ├── relay.js                  Node.js WebSocket signaling + HTTP proxy server
│   ├── package.json              ws dependency
│   ├── Dockerfile                Node 20 Alpine
│   └── fly.toml                  Fly.io config (jnb region, port 8080+8081)
├── extension/
│   ├── manifest.json             Chrome MV3 manifest
│   ├── popup/
│   │   ├── popup.html            Extension popup HTML
│   │   ├── popup.css             Dark theme matching website
│   │   └── popup.js             Full popup logic + auth polling
│   ├── background/
│   │   └── service-worker.js    Proxy management, relay connection, PAC script
│   └── icons/
│       ├── icon16.png
│       ├── icon48.png
│       └── icon128.png
├── provider-agent/
│   ├── agent.js                  Node.js provider agent (real IP, HTTP proxy on 7655)
│   └── package.json
├── supabase.sql                  Full DB schema (idempotent cleanup at top)
├── middleware.ts                 Session refresh on every request
├── next.config.ts                reactStrictMode: false, image domains
├── .env.local                    All environment variables
├── AUDIT.md                      This file
└── DEPLOY.md                     Production deployment checklist
```

---

## Pages

| Route | Type | Purpose |
|---|---|---|
| `/` | Server | Landing — headline, country flags, Get Started + Extension CTAs |
| `/auth` | Client | Sign in / Sign up with tab toggle. On login routes to correct verify step |
| `/verify/phone` | Client | Phone OTP. Bypass mode accepts `123456` |
| `/verify/payment` | Client | $1 Stripe charge. Bypass mode has skip button |
| `/dashboard` | Client | Country picker, two connect modes (Extension + Web Browser), share toggle with agent auto-start, bandwidth bar, stats |
| `/browse` | Client | Proxy browser. URL bar, iframe renders proxied content, fetch/XHR interceptor injected into pages, link rewriting |
| `/extension` | Client | Extension install page. Download ZIP + 3-step guide with copyable `chrome://extensions` URL and toast notifications |

---

## API Routes

| Route | Method | Purpose |
|---|---|---|
| `/api/auth/signout` | POST | Signs out, redirects to `/` |
| `/api/verify/phone` | POST | `send` stores phone + fires SMS (Twilio stub). `verify` checks OTP. Bypass: `123456` |
| `/api/verify/payment` | POST | Marks `is_verified=true`. Bypass skips Stripe. Production has Stripe stub |
| `/api/peers/available` | GET | Reads `profiles` where `is_sharing=true AND is_verified=true`, excludes requesting user |
| `/api/session/create` | POST | Validates trust/verification/bandwidth. Picks relay. Creates session row. Issues accountability receipt |
| `/api/session/end` | POST | Marks session ended, calls `increment_bandwidth` RPC |
| `/api/user/sharing` | POST | Flips `is_sharing` on profile |
| `/api/abuse/report` | POST | Files abuse report, docks provider trust by 10, flags session |
| `/api/proxy-asset` | GET | Unauthenticated asset proxy. Decodes `&amp;` in URLs. Blocks private IP ranges |
| `/api/proxy-fetch` | POST | Authenticated server-side fetch. Inlines relative scripts/CSS into HTML responses |
| `/api/agent-token` | GET | Returns `{token, userId, expiresAt}` for use in provider agent |
| `/api/agent-download` | GET | Serves `provider-agent/agent.js` as download |
| `/api/extension-auth` | GET | CORS-open. Returns user profile+token. Polled by extension popup to detect login |
| `/api/extension-download` | GET | Builds extension ZIP on-the-fly with production URLs baked in |

---

## Lib Modules

| File | Purpose |
|---|---|
| `lib/supabase/client.ts` | `createBrowserClient()` for client components |
| `lib/supabase/server.ts` | `createServerClient()` with cookie store for Server Components |
| `lib/supabase/admin.ts` | Service role client, bypasses RLS, server-only |
| `lib/types.ts` | `Profile`, `Session`, `PeerAvailability` TypeScript types |
| `lib/utils.ts` | `formatBytes()`, `COUNTRIES` (12 countries), `getFlagForCountry()` |
| `lib/traffic-filter.ts` | Blocks torrent/onion/SMTP/private IPs. Rate limits 100 req/min per session |
| `lib/peer-requester.ts` | WebRTC requester + agent mode (relay-forwarded requests). Resolves when DataChannel opens |
| `lib/peer-provider.ts` | WebRTC provider. Routes fetches through `/api/proxy-fetch` to avoid browser CORS |
| `lib/agent-client.ts` | `checkAgent()` polls `localhost:7654/health`. `startAgent()` POSTs config. `stopAgent()` POSTs stop |

---

## Relay Server (`relay/`)

Two servers in one process:

| Port | Purpose |
|---|---|
| `8080` | WebSocket signaling server |
| `8081` | HTTP CONNECT proxy — Chrome extension points here |

**WebSocket message types handled:**
- `register_provider` — evicts duplicates, registers peer with agentMode flag
- `request_session` — matches requester with provider (blocks same userId), adds requester to peers map
- `session_offer` / `webrtc_answer` / `webrtc_ice` — WebRTC signaling passthrough
- `agent_ready` — agent acknowledged session, notifies requester
- `proxy_request` / `proxy_response` — HTTP request forwarding for agent-mode sessions
- `open_tunnel` / `tunnel_ready` / `tunnel_data` / `tunnel_close` — HTTPS CONNECT tunnel for extension proxy
- `end_session` — cleans up session, frees both peers' `sessionId`

**HTTP proxy (port 8081):**
- Plain HTTP — forwards via `proxy_request` to connected agent
- HTTPS CONNECT — tunnels raw TCP through agent via `open_tunnel` messages

---

## Chrome Extension (`extension/`)

| File | Purpose |
|---|---|
| `manifest.json` | MV3, permissions: proxy, storage, alarms, notifications, webRequest |
| `popup/popup.js` | Full UI. Polls `/api/extension-auth` every 2s to auto-detect website login. Country picker, connect/disconnect, share toggle, stats |
| `popup/popup.css` | Dark theme matching website |
| `background/service-worker.js` | Manages relay WebSocket. On connect: sets Chrome PAC script routing all traffic via `relay-host:8081`. On disconnect: clears proxy. Handles `proxy_response` messages for in-extension fetches |

**Auth flow:** User signs in on website → popup polls `/api/extension-auth` → token received → dashboard shows → connect available.

**Connect flow:** Click Connect → `POST /api/session/create` → relay WebSocket connects → session matched with provider agent → PAC script set → ALL Chrome tabs route through peer's IP.

**Proxy architecture:**
```
Chrome tab (any site)
    ↓ PAC script routes to
relay:8081 (HTTP proxy)
    ↓ CONNECT tunnel via
relay:8080 (WebSocket)
    ↓ open_tunnel message to
provider-agent (Node.js)
    ↓ real TCP connection from
provider's real IP → target website
```

---

## Provider Agent (`provider-agent/`)

Node.js process running on provider's machine. Two servers:

| Port | Purpose |
|---|---|
| `7654` | Control server — dashboard polls `/health`, POSTs `/start` and `/stop` |
| `7655` | Local HTTP proxy (alternative direct routing path) |

**Agent flow:**
1. Dashboard detects agent via `localhost:7654/health`
2. Dashboard POSTs config (relay URL, token, userId, country) to `/start`
3. Agent connects to relay WebSocket, registers as provider with `agentMode: true`
4. When session requested: sends `agent_ready`, handles `proxy_request` messages
5. All fetches execute in Node.js — no CORS, real IP, full access

---

## Database (`supabase.sql`)

### Cleanup block (top of file — safe to re-run)
Drops triggers in `DO $$ ... exception when others then null $$` blocks, then drops tables/views/functions with `CASCADE`.

### Tables

| Table | Purpose |
|---|---|
| `profiles` | Extends `auth.users`. Username, country, trust score, verification status, phone, Stripe ID, subscription tier, sharing toggle, bandwidth counters |
| `sessions` | One row per browsing session. Requester, provider, country, relay, status, bytes, accountability receipt |
| `session_accountability` | Immutable audit log. Signed receipt per session. Service-role-only RLS |
| `abuse_reports` | Filed by users against sessions. Includes reason and review flag |

### RPCs

| Function | Purpose |
|---|---|
| `update_trust_score(p_user_id, delta)` | Clamps 0–100, called by abuse reports |
| `increment_bandwidth(p_user_id, p_bytes)` | Adds to `total_bytes_used` + `bandwidth_used_month` |
| `increment_bytes_shared(p_user_id, p_bytes)` | Adds to `total_bytes_shared` |
| `reset_monthly_bandwidth()` | Zeros free tier monthly bandwidth (cron target) |
| `handle_new_user()` | Trigger — auto-creates profile on signup with `ON CONFLICT DO NOTHING` |
| `handle_updated_at()` | Trigger — sets `updated_at = now()` on profile updates |

---

## Environment Variables

| Variable | Used by | Purpose |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | All clients | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Browser/server clients | Public anon key |
| `SUPABASE_SERVICE_ROLE` | Admin client | Service role — server only |
| `NEXT_PUBLIC_BYPASS_VERIFICATION` | Verify pages + API | `true` = skip phone/Stripe in dev |
| `NEXT_PUBLIC_SITE_URL` | Signout route | Base URL for redirects |
| `NEXT_PUBLIC_APP_URL` | Agent config | Deployed Vercel URL baked into extension/agent |
| `NEXT_PUBLIC_RELAY_ENDPOINT` | Dashboard, peer classes | WebSocket relay URL |
| `NEXT_PUBLIC_RELAY_PROXY_PORT` | Extension service worker | HTTP proxy port (8081) |
| `RELAY_ENDPOINTS` | session/create | Comma-separated relay URLs for round-robin |
| `RELAY_SECRET` | relay.js | Shared secret |

---

## User Flow

```
Visit / → Sign Up → /auth?mode=signup
    → phone OTP (123456 in dev) → /verify/phone
    → $1 payment (skip in dev) → /verify/payment
    → /dashboard

Dashboard options:
    A) 🧩 EXTENSION button → /extension
         → Download ZIP → Unzip → chrome://extensions → Load unpacked
         → Popup auto-detects login (polls /api/extension-auth)
         → Select country → Connect
         → ALL Chrome tabs route through peer's IP (PAC script → relay:8081)
         → YouTube, Google, Netflix all work

    B) 🌐 WEB BROWSER button → /browse
         → URL bar → fetch through agent via relay
         → Iframe renders proxied HTML
         → Works for most sites (not YouTube video playback)
```

---

## What Is NOT Built Yet

| Item | Notes |
|---|---|
| Stripe real payment | Stub with TODO in `api/verify/payment/route.ts` |
| Twilio real SMS | Stub with TODO in `api/verify/phone/route.ts` |
| RS256 JWT for accountability | Currently base64 JSON — needs `jose` + private key |
| `/upgrade` page | Linked from dashboard, page does not exist |
| Stripe subscription management | Premium upgrade flow not built |
| Government ID verification | Schema column exists, no UI |
| Monthly bandwidth cron | `reset_monthly_bandwidth()` RPC exists, no scheduler |
| Admin/moderation UI | No UI for reviewing abuse reports |
| TURN server fallback | WebRTC works on open networks; corporate networks need TURN |
| Extension on Chrome Web Store | Pending submission ($5 one-time fee) |
| YouTube video playback | 403 on video streams — YouTube IP-binds video tokens |
