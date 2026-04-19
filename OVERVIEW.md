# PeerMesh — Project Overview

## What Is PeerMesh?

PeerMesh is a **peer-to-peer location exchange network**. Users share their internet connection with the network and in return can browse the web appearing to come from any country where other peers exist.

Think of it like a VPN — but instead of a central server, real people's home connections are the exit nodes. Every IP in the network belongs to a verified, accountable real person.

---

## The Core Idea

- **You share your connection → you get access to everyone else's.**
- A **$1 one-time payment + phone verification** ensures every peer is a real, accountable person (no bots, no abuse farms).
- Traffic is routed: `Your Browser → Relay Server → Peer's Machine → Target Website`
- The target website sees the **peer's real home IP**, not yours.

---

## How It Works (Technical Flow)

```
User's Browser / Chrome Extension
    ↓ POST /api/session/create
Next.js API (Vercel)
    ↓ WebSocket request_session
Fly.io Relay (WebSocket relay server)
    ↓ session_request → agent_ready
Provider's Desktop/CLI (real home IP)
    ↓ fetches target website directly
Target Website sees provider's real residential IP
```

### Connection Modes

**Extension (full-browser proxy)**
- Service worker connects to relay via WebSocket
- If desktop helper is running: Chrome proxy set to `127.0.0.1:7655` (local HTTP proxy server in desktop app) — all browser traffic tunnelled through the relay to the provider
- If no desktop helper: PAC script routes traffic through relay port 8081 directly

**Web browser (`/browse`)**
- `PeerRequester` connects to relay, sends `proxy_request` messages
- Provider fetches URLs and returns responses through the relay
- Content rendered in a sandboxed iframe with link/asset rewriting

---

## Provider Types

| Type | How it runs | Slots | Kind tag |
|---|---|---|---|
| Desktop app | Electron tray app, auto-starts | Up to 32 | `desktop` |
| CLI | `npx peermesh-provider` | Up to 32 | `cli` |

Both register with the relay as `agentMode: true` providers. They handle `proxy_request` (HTTP fetch) and `open_tunnel` (CONNECT tunnel for HTTPS) messages directly — no browser-side provider class is used.

---

## Multi-Slot Architecture

A single provider machine can open **N independent WebSocket connections** to the relay simultaneously, one per slot. Each slot:

- Registers with a unique `deviceId` formatted as `{baseDeviceId}_slot_{index}`
- Carries the same `userId`, `country`, and `baseDeviceId`
- Has its own independent WebSocket, tunnel map, byte counter, heartbeat timer, and reconnect backoff
- Appears as a separate provider in the relay's peer pool

This means one machine with 4 slots can serve 4 different requesters at the same time. The relay's eviction logic only evicts a peer if the same `deviceId` reconnects — different slot deviceIds coexist freely.

**Caps and warnings:**
- Hard cap: 32 slots (`SLOT_CAP`)
- Warning shown at >8 slots: "High resource usage"
- Warning shown at >16 slots: "Very high resource usage — recommended for servers only"

**Daily limit enforcement** is aggregate across all slots — a provider cannot bypass a 1GB limit by spreading traffic across 4 slots.

**Heartbeat efficiency:** Only slot 0 calls `pollTodayBytes()` on the 30s timer. All slots send their own `PUT /api/user/sharing` heartbeat (required — each slot has its own `deviceId` row in `provider_devices`), but the shared byte/limit poll is deduplicated to slot 0 only.

---

## Private vs Public Connection Mode

### Public mode
- Requester picks a country → relay matches any available provider in that country
- Provider slots with private sharing enabled are excluded from public counts and cannot be matched to public requesters

### Private mode
- Provider enables private sharing in the popup → a 9-digit code is generated and stored in `private_share_devices` keyed by `baseDeviceId`
- Requester enters the 9-digit code → `POST /api/session/create { privateCode }` resolves it to `baseDeviceId` + `providerUserId`
- Relay enforces `privateBaseDeviceId` matching in `isEligible` — public requesters cannot reach private slots
- `privateOnly` is set **synchronously** on the provider's WebSocket object before it enters the peer pool (no race window)
- All slots under the same `baseDeviceId` are covered by one private share row
- `peers/available` excludes private slots from public counts by checking `deviceId === baseId || deviceId.startsWith(`${baseId}_slot_`)`

---

## Session Lifecycle

```
1. POST /api/session/create          → creates DB session row, returns relayEndpoint + sessionId
2. WebSocket request_session         → relay finds provider, creates relay session
3. provider sends agent_ready        → relay sends agent_session_ready to requester
                                     → relay PATCHes session row with provider_id + provider_kind
4. Traffic flows (proxy_request / open_tunnel)
5. Session ends (disconnect / provider drop / daily limit)
   → relay calls POST /api/session/end (isRelay=true)
   → browser/popup may also call POST /api/session/end (isRelay=false)
   → UPDATE .eq('status','active') guard ensures only the first caller runs RPCs
   → second caller hits count=0 and returns early — no double-credit
```

### Byte accounting
- Desktop/CLI providers flush bytes via `POST /api/user/sharing { bytes }` every 5s during sessions (`flushStats`)
- `session/end` skips `increment_bytes_shared` for `provider_kind = 'desktop'` or `'cli'` to avoid double-credit
- `provider_kind` is stored on the session row at `agent_ready` time so the browser-client path can read it back even without the relay's context

### Auto-reconnect
- If a provider drops mid-session, the relay attempts to find a replacement (up to 3 attempts, 2s apart)
- On success: sends `session_reconnected` to requester with new `sessionId` — no UI disruption
- Extension service worker updates `proxySession` on desktop and `proxySessionId` in session storage
- On failure after 3 attempts: sends `session_ended` to requester

### Peer affinity
- After each session, the relay saves `requesterUserId → providerUserId` for that country in memory and persists it to DB via `set_preferred_provider`
- On next `request_session`, the client passes `preferredProviderUserId` (loaded from DB at session create time)
- Relay tries the preferred provider first before falling back to any eligible provider
- Survives relay restarts; scales across multiple relay instances

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend + API | Next.js 16 (App Router, Turbopack), TypeScript |
| Auth + Database | Supabase (Postgres + Auth) |
| Relay Server | Node.js WebSocket server on Fly.io |
| Chrome Extension | Manifest V3, service worker, PAC proxy |
| Desktop Provider | Electron tray app (`desktop/main.js`) |
| CLI Provider | Node.js ESM (`cli/index.js`), `npx peermesh-provider` |
| Deployment | Vercel (web app) + Fly.io (relay) |

---

## Project Structure

```
peermesh/
├── app/
│   ├── api/
│   │   ├── extension-auth/     Device flow auth (code → poll → approve)
│   │   ├── session/
│   │   │   ├── create/         Creates DB session, resolves private code, returns relay params
│   │   │   └── end/            Ends session, credits bytes, persists affinity (PATCH + POST)
│   │   ├── peers/available/    Live provider counts by country (excludes private slots)
│   │   ├── proxy-fetch/        Server-side fetch proxy (used by web browse view)
│   │   ├── proxy-asset/        Asset proxy for iframe content rewriting
│   │   ├── user/sharing/       Provider heartbeat, byte flush, private share management
│   │   ├── agent-token/        Issues short-lived tokens for proxy-fetch auth
│   │   ├── abuse/report/       Abuse reporting endpoint
│   │   └── verify/             Phone OTP + payment verification
│   ├── browse/                 Web iframe proxy browser (BrowseView)
│   ├── dashboard/              Main dashboard
│   ├── extension/              Extension install page
│   └── auth/                   Sign in / sign up
├── lib/
│   ├── peer-requester.ts       WebSocket requester (agent mode only)
│   ├── peer-provider.ts        Stub — real provider logic is in desktop/main.js + cli/index.js
│   ├── traffic-filter.ts       Host blocklist, port allowlist, rate limiter (100 req/min/session)
│   ├── private-sharing.ts      Code generation, expiry helpers
│   ├── supabase/               admin + server + client Supabase instances
│   └── utils.ts                Shared helpers
├── relay/
│   └── relay.js                WebSocket relay (Fly.io) — peer pool, session management,
│                               affinity, auto-reconnect, private/public routing
├── extension/
│   ├── background/service-worker.js   Relay connection, proxy settings, sharing control
│   └── popup/popup.js                 UI — connect, share, private code, stats
├── desktop/
│   └── main.js                 Electron app — multi-slot relay provider, local HTTP proxy
│                               server (port 7655), control server (port 7654)
├── cli/
│   └── index.js                CLI provider — multi-slot, --slots flag, --limit flag,
│                               control server, desktop peer coordination
└── supabase.sql                Full database schema + RPC definitions
```

---

## API Routes Reference

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/api/session/create` | Create session, resolve private code, return relay params |
| `POST` | `/api/session/end` | End session, credit bytes (idempotent via status guard) |
| `PATCH` | `/api/session/end` | Relay assigns provider_id + provider_kind to session |
| `GET` | `/api/peers/available` | Live provider slot counts by country |
| `GET` | `/api/user/sharing` | Fetch profile stats, private share state, daily limit |
| `POST` | `/api/user/sharing` | Flush bytes / set isSharing / manage private share / accept terms |
| `PUT` | `/api/user/sharing` | Provider heartbeat (upserts provider_devices row) |
| `DELETE` | `/api/user/sharing` | Provider stopped sharing (removes device row) |
| `POST` | `/api/proxy-fetch` | Server-side URL fetch for web browse view |
| `GET` | `/api/proxy-asset` | Proxy static assets for iframe rewriting |
| `POST` | `/api/extension-auth` | Request device auth code |
| `GET` | `/api/extension-auth` | Poll device code / verify token |
| `GET` | `/api/agent-token` | Issue short-lived proxy-fetch token |
| `POST` | `/api/abuse/report` | Submit abuse report |

---

## Database Tables

| Table | Purpose |
|---|---|
| `profiles` | User info, trust score, bandwidth usage, daily limit, sharing state |
| `sessions` | One row per browsing session — provider_id, provider_kind, bytes_used, status |
| `session_accountability` | Immutable audit log — who used whose IP, when, how many bytes |
| `provider_devices` | Live heartbeat rows — one per slot deviceId, with country and last_heartbeat |
| `private_share_devices` | Private share codes keyed by user_id + base_device_id |
| `abuse_reports` | Abuse reports; docks provider trust score |

### Key RPCs

| RPC | Purpose |
|---|---|
| `upsert_provider_heartbeat` | Insert/update provider_devices row |
| `remove_provider_device` | Delete device row on stop |
| `cleanup_stale_providers` | Remove devices with last_heartbeat > 45s ago |
| `increment_bytes_shared` | Add to provider's total_bytes_shared + today counter |
| `increment_bandwidth` | Add to requester's total_bytes_used |
| `finalize_session_accountability` | Write immutable accountability row |
| `set_preferred_provider` | Persist requester→provider affinity |

---

## Relay Architecture

The relay (`relay/relay.js`) is a single Node.js process on Fly.io managing:

- **`peers` Map** — all connected WebSocket clients (providers + requesters)
- **`sessions` Map** — active relay sessions linking requester↔provider
- **`proxyClients` Map** — CONNECT tunnel WebSocket connections (`/proxy?session=X`)
- **`peerAffinity` Map** — in-memory requester→provider affinity cache
- **`providerShareStatusCache` Map** — 5s TTL cache of provider daily limit status, keyed by `userId:baseDeviceId`

### Provider registration (race-free)
1. Relay receives `register_provider`
2. Awaits `getProviderShareStatus(userId, baseDeviceId)` — fetches private share state and daily limit
3. Sets `ws.privateOnly = true` if private share is active
4. Only then adds peer to pool and sends `registered`

This eliminates the race window where a public requester could grab a private-only slot before `privateOnly` was set.

### Finding a provider
`findProvider` checks eligibility synchronously (country, busy, trust, private/public mode) then checks daily limits via the share status cache. Preferred provider (affinity) is tried first. For private mode, if the preferred provider is offline/busy, returns null immediately — no fallback to other providers.

---

## Security Notes

- **Relay byte limit:** Each WebSocket connection is terminated if it transfers >1GB total (`bytesTransferred > 1_073_741_824`)
- **Host blocklist:** `.onion`, SMTP/mail, torrents, private IP ranges blocked at both relay (tunnel) and provider (fetch) level
- **Port allowlist:** Only 80, 443, 8080, 8443 allowed for tunnels (`traffic-filter.ts`)
- **Rate limiter:** 100 requests/min per sessionId in `proxy-fetch` (`checkRateLimit` from `traffic-filter.ts`)
- **Private code:** 9-digit numeric, generated with `crypto.randomInt`, collision-checked against DB (20 attempts)
- **Relay secret:** All relay→API calls authenticated with `x-relay-secret` header
- **Session end idempotency:** `UPDATE ... WHERE status = 'active'` guard prevents double RPC execution when relay and browser both call session/end

---

## Control Server (Desktop + CLI)

Both desktop and CLI run a local HTTP server for cross-process coordination:

| Port | Owner |
|---|---|
| `7654` | Whoever starts first (desktop or CLI) — primary control port |
| `7655` | Desktop local HTTP proxy server (Chrome routes traffic here) |
| `7656` | Secondary peer port — used by whichever process starts second |

The two processes register with each other via `POST /native/peer/register`. The desktop watches the CLI via a 3s poll and reclaims port 7654 when the CLI exits.

---

## What's Built ✅

- Full auth flow (sign up, phone OTP, $1 payment)
- Dashboard with country picker, connect modes, share toggle
- Chrome extension with full proxy routing (PAC + local proxy modes)
- Web iframe proxy browser with link/asset rewriting and fetch interception
- Desktop Electron provider app with multi-slot, tray icon, local proxy server
- CLI provider (`npx peermesh-provider`) with multi-slot, `--slots`, `--limit`, `--no-limit` flags
- WebSocket relay with affinity, auto-reconnect, private/public routing, daily limit enforcement
- Private sharing — 9-digit codes, per-device, expiry, all slots covered
- Multi-slot provider support (up to 32 concurrent sessions per machine)
- Peer affinity — DB-persisted, relay-seeded, survives restarts
- Abuse reporting + trust score system
- Bandwidth tracking per user (daily + total)
- Extension ZIP builder (served dynamically with production URLs baked in)
- Rate limiting on proxy-fetch (100 req/min per session)
- Session end idempotency (status guard + count check)
- provider_kind stored on session row — correct byte credit routing

---

## What's Not Built Yet ⏳

| Item | Status |
|---|---|
| Real Stripe payment | Stub — needs Stripe integration |
| Real Twilio SMS | Stub — needs Twilio credentials |
| `/upgrade` page | Linked but not built |
| Stripe subscription management | Premium tier flow not built |
| Admin/moderation UI | No UI for reviewing abuse reports |
| Chrome Web Store submission | Pending ($5 one-time fee) |
| Monthly bandwidth reset cron | RPC exists, no scheduler hooked up |
| Redis rate limiter | Current rate limiter is in-memory per serverless instance |
| `source` field on helper object | Service worker doesn't map `where: 'cli'` to `source` — popup always shows "Desktop" |

---

## Deployment

| Service | What runs there |
|---|---|
| **Vercel** | Next.js web app (auto-deploys on git push) |
| **Fly.io** | WebSocket relay server (Johannesburg region) |
| **Supabase** | Database + Auth |
| **User's PC** | Desktop app or CLI provider |

---

## Why This Is Different From a VPN

| VPN | PeerMesh |
|---|---|
| Central servers you pay for | Real people's home connections |
| IPs are known/blocked by sites | Residential IPs — not flagged |
| One company controls all traffic | Distributed, peer-to-peer |
| Monthly subscription | Share your connection, get access free |
| Anonymous exit nodes | Every IP tied to a verified real person |

---

*Built with Next.js · Supabase · Fly.io · Chrome MV3 · Electron · Node.js*
