# PeerMesh

PeerMesh is a peer-to-peer location exchange network. Users share their internet connection with the network and in return can browse the web appearing to come from any country where other peers exist.

Think of it like a VPN — but instead of routing your traffic through a corporate datacenter, it routes through real people's home connections. Every IP in the network belongs to a verified, accountable real person.

---

## The Core Idea

When you browse the web through PeerMesh, the website you visit sees someone else's home IP address — not yours. In exchange, your connection powers someone else's browsing session somewhere in the world.

No central servers. No datacenter IPs. Just people sharing with people.

---

## How It Works

```
Your Browser
    ↓
PeerMesh Relay (routing layer)
    ↓
Another User's Home Connection
    ↓
Target Website
```

The relay is a lightweight signaling server — it connects you to a peer and gets out of the way. It never stores your browsing content. The actual traffic flows between you and the peer directly through the tunnel.

---

## Who Uses PeerMesh

PeerMesh has three types of users:

### Peer
**Shares bandwidth + browses the web. Free.**

A Peer contributes their connection to the network and gets full browsing access in return. The more you share, the more you can use. This is the core of how PeerMesh works — a self-sustaining exchange between real people.

### Host
**Shares bandwidth only. Earns money.**

A Host supplies bandwidth to the network without using it for browsing. Every time a Client uses a Host's connection, the Host earns 60% of the session revenue. Hosts are the supply engine — dedicated machines, always-on desktops, or anyone who wants to monetize their unused bandwidth.

### Client
**Browses only. Pays per session.**

A Client doesn't share anything. They pay for access using the slider-based pricing system and get full browsing capability. Clients are the revenue engine that funds Host earnings and keeps the network growing.

---

## Features

### Real Residential IPs
Every exit node in PeerMesh is a real home connection — not a datacenter, not a VPS. Websites that actively block datacenter IPs and VPN ranges see a normal residential address from a real ISP. This is the fundamental difference between PeerMesh and every traditional VPN or proxy service.

### Verified Accountability
Every user completes phone verification and a one-time $1 payment before browsing through someone else's Ip [Peer, Client]. This ensures every IP in the network belongs to a real, accountable person — not a bot, not an abuse farm. If a peer's IP is used for abuse, there is a real person attached to it.

### Private Sharing
Providers can generate a 9-digit private share code and give it to specific people — a team, a family, a client. Only someone with that code can connect to that specific provider's IP. The code can have an expiry date. This turns PeerMesh into a personal residential proxy that only you control.

### Peer Affinity
After your first session with a provider, PeerMesh remembers that pairing. Next time you connect to the same country, it tries to reconnect you to the same provider. Your IP stays consistent across sessions — important for sites that track IP stability like banking, social media, and account-based services.

### Multi-Slot Providers
A single provider machine can serve up to 32 simultaneous users at once. Each slot is an independent connection with its own bandwidth tracking and session management. One always-on desktop or CLI instance can power dozens of sessions simultaneously.

### Full Browser Proxy
The Chrome extension routes all browser traffic through the peer — not just one tab, not just HTTP requests. DNS lookups, WebSocket connections, images, scripts, everything. The browser behaves as if it is physically located where the peer is.

### Identity Spoofing
When connected, the extension also adjusts the browser's fingerprint to match the peer's country — timezone, language, geolocation, screen resolution, user agent, and hardware signals. Websites that check these values see a consistent picture, not a mismatch between IP location and browser settings.

### Auto-Reconnect
If a provider drops mid-session, the relay automatically finds a replacement provider in the same country and reconnects you — usually within a few seconds and without any visible interruption. No manual reconnect required.

### Session Pricing (Clients)
Clients configure their session using four controls:

| Control | What It Does |
|---|---|
| RPM | How many requests per minute the session allows |
| Bandwidth | Total data cap for the session |
| Period | How long the session stays active |
| Stickiness | Whether the IP stays fixed or rotates |

Higher values cost more. Sticky long-duration high-throughput sessions are priced significantly higher than basic browsing — this keeps the network clean and makes abuse expensive.

Presets cover most users:
- **Basic Browsing** — casual use, rotating IP, low cost
- **Stable Identity** — same IP across sessions, good for accounts
- **High Throughput** — fast, high volume, rotating IP

Advanced mode unlocks the full slider controls.

### Bandwidth Tracking
Every byte transferred is tracked per user. Peers have a daily sharing limit and a daily usage limit. The system ensures the exchange stays fair — heavy consumers who don't share enough are prompted to either share more or switch to a paid Client plan.

### Abuse Protection
Multiple layers prevent misuse:
- Per-session request rate limits enforced at the relay
- Host blocklist covering private IP ranges, Tor, SMTP, and torrent traffic
- Port allowlist (80, 443, 8080, 8443 only)
- Trust score system — abuse reports dock a provider's score and reduce their priority in the peer pool
- Anomaly detection flags sessions with abnormal patterns

---

## Provider Options

Providers (Peers and Hosts) can run PeerMesh in three ways:

**Chrome Extension**
The simplest option. Install the extension, enable sharing, done. Single slot, web requests only. No desktop app required.

**Desktop App**
An Electron tray application that runs in the background. Supports up to 32 slots, handles full HTTPS tunnel traffic (not just web requests), and includes a local proxy server so the extension can route all browser traffic through it.

**CLI**
`npx peermesh-provider` — a Node.js command-line provider for servers and power users. Supports up to 32 slots, `--slots` flag to configure concurrency, `--limit` flag to set a daily bandwidth cap. Designed for always-on machines.

---

## Privacy

- The relay connects peers but does not store browsing content
- Session accountability records are kept for abuse investigation — who used whose IP, when, how many bytes
- Providers can see that a session is active on their connection but not what the requester is browsing
- Requesters' traffic is encrypted end-to-end for HTTPS destinations — the provider's machine opens a tunnel but cannot read the content

---

## Why Not Just Use a VPN?

| | VPN | PeerMesh |
|---|---|---|
| Exit node type | Corporate datacenter | Real home connections |
| IP reputation | Known, often blocked | Residential, not flagged |
| Who controls traffic | One company | Distributed peers |
| Cost model | Monthly subscription | Share to earn, or pay per session |
| Accountability | Anonymous servers | Verified real people |
| Private sharing | No | Yes — 9-digit codes |
| IP consistency | Changes on reconnect | Peer affinity keeps it stable |
| Identity matching | IP only | IP + full browser fingerprint |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Web App + API | Next.js, TypeScript, Vercel |
| Database + Auth | Supabase (Postgres) |
| Relay Server | Node.js WebSocket server on Fly.io |
| Chrome Extension | Manifest V3, service worker |
| Desktop Provider | Electron |
| CLI Provider | Node.js (`npx peermesh-provider`) |

---

*PeerMesh — the internet, from anywhere, powered by people.*
