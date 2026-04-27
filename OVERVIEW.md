# PeerMesh Overview

Last updated: 2026-04-27

This document is implementation-accurate. It describes what the current codebase does today, where it matches the intended PeerMesh model, and where it does not.

## What PeerMesh Is

PeerMesh is a residential bandwidth exchange network.

- A requester chooses a country or a private share code.
- PeerMesh assigns a live provider slot from a desktop app or CLI helper running on a real user machine.
- Traffic flows through the relay to that provider, and the target site sees the provider's residential IP.

High-level path:

```text
Requester UI or extension
  -> POST /api/session/create
  -> Relay WebSocket session
  -> Provider desktop/CLI slot
  -> Target website
```

## Business Model

### Base allocation

- Every user profile starts with a 5 GB monthly allocation.
- Contribution credits are 1:1 with shared bandwidth. If a user shares 1 GB, they earn 1 GB of contribution credits.
- Paid usage is backed by a USD wallet funded through Flutterwave.
- Provider earnings accumulate as pending payout balance in USD.

### Roles

PeerMesh stores three roles in `profiles.role`:

- `peer`: shares and uses the network, earns contribution credits and is intended to receive revenue share.
- `host`: primarily shares bandwidth and is intended to receive revenue share without being a normal requester by default.
- `client`: consumes bandwidth only and pays or spends free/credit allocation.

### Important implementation note

The current code does not strongly enforce different requester rules per role.

Requester access is enforced mostly by:

- authenticated user
- confirmed email
- verified phone
- active sharing OR wallet balance OR contribution credits OR premium
- trust score >= 30
- monthly bandwidth remaining

That means:

- The intended policy "peer must share at least one public slot to connect for free" is only partially enforced. The code checks `is_sharing`, not specifically "has at least one public slot".
- The intended policy "host must switch to peer to consume free capacity" is not strongly enforced by role today. A host can still connect if they pass the same generic access checks.
- The `client` role behaves closest to the current implementation: use only, with payment or free/credit access.

## Access Policy Before Connecting

Before a requester can connect to a provider, the current code path requires:

1. The user must be signed in.
2. The user's email must be confirmed.
3. The user's phone must be verified.
4. The user must either:
   - be actively sharing, or
   - have wallet balance, or
   - have contribution credits, or
   - be premium.
5. The trust score must be at least 30.
6. The monthly bandwidth limit must not be exhausted.

This gate is enforced by `app/api/session/create/route.ts` together with `lib/account-access.ts`.

## New User Flow

### 1. Authentication

- User signs up or signs in through Supabase Auth.
- Email confirmation is required before connecting or linking a desktop/extension helper.

### 2. First dashboard experience

After sign-in, the dashboard shows:

- trust score
- total shared bytes
- total used bytes
- monthly bandwidth usage
- wallet balance
- pending payout balance
- contribution credits
- country picker for public routing
- private code input for private routing
- helper status for desktop/CLI

### 3. If the user is not phone verified

- The dashboard can still load.
- The user can still sign in.
- When they try to connect, they are redirected to `/verify/phone`.

### 4. If the user is verified but has no usage access

- If they are not sharing and have no wallet balance, no contribution credits, and no premium access, connect attempts redirect to `/verify/payment`.
- The UI message is effectively: enable sharing or fund the wallet.

### 5. If the user wants to become a provider

- They need the desktop app or CLI helper.
- They must accept provider terms.
- Sharing can then be started from the dashboard, desktop app, or CLI.

## Provider Flow

### Provider types

PeerMesh currently supports:

- Desktop provider: Electron helper
- CLI provider: Node CLI helper

Both can:

- open multiple provider slots
- register each slot independently with the relay
- serve HTTP fetch requests
- serve CONNECT tunnel requests for HTTPS

### Public sharing

- A provider slot registers with the relay using `register_provider`.
- If the slot is public and healthy, it becomes eligible for public country-based matching.
- Public requesters do not choose individual public devices. They see country availability counts, not a raw device list.

### Private sharing

- Private sharing is managed through `private_share_devices`.
- A provider can enable a 9-digit private share code.
- Private slots are excluded from the public pool.
- Requesters connect to those slots only by entering the code.

### Multi-slot behavior

- Each slot gets its own `device_id`.
- A single machine can serve multiple requesters at once.
- Daily limit checks apply at both profile and slot level.

## Requester Flow

### Public route

1. User picks a country in the dashboard.
2. Frontend calls `POST /api/session/create`.
3. Server checks auth, verification, access, trust, and monthly usage.
4. Server looks for live public providers in that country.
5. Server creates a pending session and returns:
   - `sessionId`
   - `relayEndpoint`
   - `relayFallbackList`
   - signed accountability receipt
   - preferred provider hints if available
6. Requester opens a relay WebSocket session.
7. Relay matches a provider.
8. Provider acknowledges with `agent_ready`.
9. Traffic starts.

### Private route

1. User enters a 9-digit code.
2. `POST /api/session/create` resolves it to a provider user and base device.
3. The API checks that the private share is active and not owned by the requester.
4. The relay only allows that specific private provider/base device to satisfy the session.

## What the Relay Server Does

The relay is the live traffic coordinator.

It is responsible for:

- authenticating providers and requesters through `/api/relay/auth`
- keeping the live provider pool
- matching requesters to providers
- excluding busy slots
- excluding private-only slots from public matching
- checking provider trust and daily-limit eligibility
- forwarding HTTP and tunnel traffic
- patching session metadata back into the database
- attempting auto-reconnect if a provider drops mid-session

## How Requesters See Devices

Requesters do not browse a full public device list.

They see:

- country-level public availability counts from `/api/peers/available`
- or a private-code entry path for private devices

So the requester experience is:

- public: "connect me to any eligible provider in this country"
- private: "connect me to the provider behind this exact code"

## Session Lifecycle

### Session start

- `POST /api/session/create` creates a pending database row.
- The relay authenticates the requester.
- The relay finds a provider.
- Provider sends `agent_ready`.
- Relay patches `provider_id`, `provider_kind`, `provider_device_id`, `provider_base_device_id`, and observed target hosts back into the session row.

### During the session

- Desktop and CLI providers handle `proxy_request` and `open_tunnel`.
- Providers report shared bytes separately through `/api/user/sharing`.
- The relay tracks activity and can reconnect a requester to a new provider if the old one drops.

### Session end

- Relay or client can call `POST /api/session/end`.
- The route is written to behave idempotently.
- Requester bandwidth counters are incremented once.
- Desktop and CLI provider bytes are not double-counted during session finalization.

## Common User-Facing Errors

Current errors a requester can hit include:

- `Confirm your email before connecting.`
- `Verify your phone to connect to providers.`
- `FREE LAYER - Enable sharing to connect, or fund your USD wallet to browse without sharing.`
- `Account suspended due to low trust score`
- `Monthly bandwidth limit reached. Wait for reset or fund your USD wallet for higher usage.`
- `No peers available in <country>`
- `Private share code is invalid or expired`
- `Private share is currently offline`
- `Private share is offline or busy`

Local desktop/proxy errors can also surface, such as:

- no active PeerMesh session
- provider unavailable
- tunnel timeout

## Billing and Payout Status

### Implemented

- 5 GB monthly allocation
- contribution credits based on bytes shared
- USD wallet balance on profile
- Flutterwave wallet top-up checkout
- Flutterwave payment verification/webhook settlement
- wallet ledger records
- payment transaction records
- pending provider payout balance on profile
- payout FX preview for display

### Not fully implemented end-to-end

- automated Flutterwave payout disbursement
- full per-request API-key metering and wallet debit
- strict role-based billing enforcement beyond the generic access gate

The database schema for API keys, API usage, and provider payouts exists, but the full money-moving and per-request debit loop is not complete.

## Security and Production Readiness

As of 2026-04-27, PeerMesh is not ready for a public production launch.

### Launch blockers

- Desktop token refresh can issue a fresh desktop token from `userId` alone without proving possession of the previous token or device session.
- Phone verification is not a real OTP verification flow yet. The API currently marks users as verified without validating an SMS code against Twilio.

### Other serious risks

- Session receipt signing falls back to `dev-secret` if production secrets are missing.
- Some provider geolocation depends on an external HTTP geolocation service for relay-forwarded IPs.
- The in-memory rate limiter comment says 100 requests per minute, but the current numeric cap is much higher than that comment implies.
- Desktop/native-host behavior in the supplied debug log shows repeated native host starts and refresh churn, which is an operational stability concern even aside from the security issues above.

### Practical verdict

- Suitable for internal testing, controlled beta, and continued hardening.
- Not suitable for open public launch until auth refresh and phone verification are fixed at minimum.

## Product View

PeerMesh has a strong product thesis:

- residential IP supply from real user devices
- a share-to-earn-credit model
- private and public routing
- desktop and CLI provider paths

The weak point is not the idea. The weak point is that the security and enforcement model has to be as strong as the accountability promise.

Right now the product story is clearer than the implementation guarantees. The fastest path to a real launch is:

1. lock down desktop auth refresh and device revocation
2. implement real phone OTP verification
3. remove insecure secret fallbacks
4. finish payout disbursement and API debit logic
5. align role policy with code, not just docs and UI copy

## Summary

PeerMesh today is a working relay-and-provider system with:

- verified session creation flow
- public and private routing
- multi-slot desktop/CLI providers
- contribution credit accounting
- Flutterwave wallet funding

But it is still in a hardening phase, not a public-launch phase.
