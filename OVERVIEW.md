# PeerMesh — Project Overview

## What Is PeerMesh?

PeerMesh is a **peer-to-peer location exchange network**. Users share their internet connection with the network, and in return they can browse the web appearing to come from any country where other peers exist.

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
User's Browser
    ↓ connects to
Vercel (Next.js web app)
    ↓ session matched via
Fly.io Relay (WebSocket server)
    ↓ routes traffic through
Provider's PC running agent.js (real home IP in Rwanda, Nigeria, etc.)
    ↓ fetches the target website
Target Website sees provider's real IP
```

---

## Two Ways to Use It

### 1. 🧩 Chrome Extension (Full Proxy)
- Sets Chrome's system proxy via a PAC script
- Routes **ALL tabs** through a peer's real IP
- YouTube, Google, Netflix — everything works
- Download ZIP → Load in `chrome://extensions` → Connect

### 2. 🌐 Web Browser (Iframe Proxy)
- Built into the website at `/browse`
- No install required
- Works for most sites (not YouTube video streams)
- URL bar → content loads in an iframe via the peer

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend + API | Next.js 15 (App Router), TypeScript, Tailwind v4 |
| Auth + Database | Supabase (Postgres + Auth) |
| Relay Server | Node.js WebSocket server on Fly.io |
| Chrome Extension | Manifest V3, PAC proxy script |
| Provider Agent | Node.js script users run on their PC |
| Deployment | Vercel (web app) + Fly.io (relay) |

---

## Project Structure

```
peermesh/
├── app/                  Next.js pages + API routes
│   ├── page.tsx          Landing page
│   ├── auth/             Sign in / Sign up
│   ├── verify/           Phone OTP + $1 payment verification
│   ├── dashboard/        Main dashboard (connect, share, stats)
│   ├── browse/           Iframe proxy browser
│   ├── extension/        Extension download + install guide
│   └── api/              All backend API routes
├── lib/                  Shared logic (Supabase clients, peer classes, utils)
├── relay/                WebSocket relay server (deployed to Fly.io)
├── extension/            Chrome extension source (MV3)
├── provider-agent/       Node.js agent users run to share their connection
└── supabase.sql          Full database schema
```

---

## User Journey

```
1. Visit peermesh.app
2. Sign Up → phone OTP → $1 payment → Dashboard
3. Choose how to connect:
   A) Chrome Extension → routes ALL tabs through a peer's IP
   B) Web Browser → iframe proxy for quick browsing
4. To share your connection:
   → Toggle "Share my connection" on the dashboard
   → Download + run the provider agent (node agent.js)
   → Your machine becomes an exit node for others
```

---

## Database (Supabase)

| Table | Purpose |
|---|---|
| `profiles` | User info, country, trust score, verification status, bandwidth usage |
| `sessions` | One row per browsing session with accountability receipt |
| `session_accountability` | Immutable audit log — who used whose IP, when |
| `abuse_reports` | Users can report abuse; docks provider trust score |

---

## What's Built ✅

- Full auth flow (sign up, phone OTP, $1 payment)
- Dashboard with country picker, connect modes, share toggle
- Chrome extension with full proxy routing
- Web iframe proxy browser
- Provider agent (Node.js, runs on user's PC)
- WebSocket relay server (deployed on Fly.io)
- Abuse reporting + trust score system
- Bandwidth tracking per user
- Extension ZIP builder (served dynamically with production URLs baked in)
- Version bump script for extension releases

---

## What's Not Built Yet ⏳

| Item | Status |
|---|---|
| Real Stripe payment | Stub — needs Stripe integration |
| Real Twilio SMS | Stub — needs Twilio credentials |
| `/upgrade` page | Linked but not built |
| Stripe subscription management | Premium tier flow not built |
| Admin/moderation UI | No UI for reviewing abuse reports |
| TURN server fallback | WebRTC needs this for corporate networks |
| Chrome Web Store submission | Pending ($5 one-time fee) |
| Monthly bandwidth reset cron | RPC exists, no scheduler hooked up |

---

## Deployment

| Service | What runs there |
|---|---|
| **Vercel** | Next.js web app (auto-deploys on git push) |
| **Fly.io** | WebSocket relay server (Johannesburg region) |
| **Supabase** | Database + Auth |
| **User's PC** | Provider agent (`node agent.js`) |

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

*Built with Next.js · Supabase · Fly.io · Chrome MV3 · Node.js*
