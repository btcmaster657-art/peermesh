# PeerMesh Overview

Last updated: 2026-04-27

This document is implementation-accurate for the current repository state.

## What PeerMesh Is

PeerMesh is a residential bandwidth exchange network with three user-facing modes:

- public browsing through any eligible provider in a selected country
- private browsing through a specific provider using a 9-digit share code
- metered developer/API access authenticated with PeerMesh API keys

The system is split across four runtime surfaces:

- the Next.js 16 app in `app/`
- the relay process started through `run-relay.mjs`
- the desktop provider in `desktop/`
- the CLI provider in `cli/`

At a high level:

```text
Requester client
  -> app/api/session/create
  -> relay auth and relay WebSocket session
  -> desktop or CLI provider slot
  -> target website
  -> app/api/session/end for final settlement
```

## Launch Status

As of 2026-04-27:

- `npm test` passes
- `npm run lint` passes
- `npm run build` passes
- the role model is enforced in runtime access checks
- API-key sessions are authenticated, quoted, billed, and recorded
- contribution credits are minted 1:1 from shared bytes
- provider earnings are accrued into pending payout balances and `provider_payouts` rows

Operational note:

- the repository now performs payout accounting automatically
- bank or cash-out disbursement orchestration is still an operations concern unless you add a dedicated payout execution workflow on top of the pending payout ledger

## User Roles

`profiles.role` stores one of:

- `peer`: can use the network and can share the network
- `host`: can share the network but cannot connect as a requester
- `client`: can connect as a requester but cannot share bandwidth

Runtime enforcement lives in:

- `lib/roles.ts`
- `lib/account-access.ts`
- `app/api/session/create/route.ts`
- `app/api/relay/auth/route.ts`
- `app/api/user/sharing/route.ts`
- `app/api/account/role/route.ts`

Effective behavior:

- host accounts are blocked from requester sessions
- client accounts are blocked from provider registration and sharing controls
- peer accounts can both browse and provide capacity
- switching to `client` is blocked while sharing is still enabled

## Access Rules

### Public requester access

Public connections are enforced by `getConnectionAccessRequirement()` in `lib/account-access.ts`.

Requirements:

1. authenticated user, desktop session, or API key
2. confirmed email for user-auth flows
3. verified phone for requester flows
4. role must allow requester use
5. trust score must pass the traffic filter
6. monthly bandwidth cannot exceed the effective limit unless paid access exists

Public role behavior:

- `peer`: needs either active sharing or paid access
- `client`: needs paid access
- `host`: denied

### Private requester access

Private code sessions still require:

- a verified phone
- a requester-capable role
- an active private share code that is not owned by the requester

Private mode intentionally skips the public paid-access gate. That means verified `peer` and `client` accounts can use a valid private code even without wallet balance or contribution credits.

## Billing Model

PeerMesh has two enforced billing layers.

### User browsing

User browsing is settled in `lib/wallet.ts` via `settleSessionUsage()` and `lib/billing.ts` via `settleUserUsage()`.

Settlement order:

1. free monthly allocation
2. contribution credits
3. USD wallet balance

Current defaults:

- base monthly allocation: 5 GB
- premium bonus: +5 GB unless overridden by env
- browse wallet pricing: `$3 / GB` unless overridden by env
- provider revenue share on collected wallet debits: `60%` unless overridden by env

Important details:

- free bytes and contribution credits are consumed before wallet debits
- if wallet balance is lower than the final bill, PeerMesh records the collected amount plus the shortfall
- provider revenue share is derived only from collected paid usage, not from free allocation or contribution-credit consumption

### Developer/API billing

API access is authenticated by PeerMesh API keys defined in `api_keys`.

Implemented pieces:

- key creation, listing, and revocation: `app/api/billing/api-keys/route.ts`
- key hashing and resolution: `lib/api-keys.ts`
- pricing engine: `lib/billing.ts`
- quote route: `app/api/billing/quote/route.ts`
- requester auth resolution: `lib/requester-auth.ts`
- relay requester enforcement: `app/api/relay/auth/route.ts`
- final usage logging: `api_usage` via `lib/wallet.ts`

API key behavior:

- keys authenticate through `x-api-key` or `Authorization: Bearer pmk_live_...`
- `session/create` stores `api_key_id`, request metadata, quoted tier data, and estimated cost on the session row
- RPM caps, sticky-session eligibility, and verification requirements are enforced before session creation
- API sessions require enough wallet balance to cover the estimated quote before they start
- `session/end` logs the final row in `api_usage` and debits wallet balance from the requester's account

Supported API tiers:

- `standard`
- `advanced`
- `enterprise`
- `contributor`

Contributor keys are restricted to provider-capable accounts that have accepted provider terms.

## Contribution Credits

Contribution credits are now an enforced 1:1 bandwidth credit.

Implemented mechanics:

- helper and provider share reports call `increment_bytes_shared`
- `increment_bytes_shared` updates both `total_bytes_shared` and `contribution_credits_bytes`
- `sharedBytesToCreditBytes()` in `lib/billing.ts` mirrors the same 1:1 conversion logic in code

Net effect:

- `1 GB` shared produces `1 GB` of contribution credits
- those credits are later consumed before wallet balance during requester settlement

## Provider Earnings and Payout Accounting

Provider earnings are accounted for during session finalization.

When a paid session ends:

- wallet debit is recorded in `wallet_ledger`
- provider revenue share is calculated from the collected debit
- `profiles.wallet_pending_payout_usd` is incremented for the provider
- a `provider_payouts` row is inserted for the provider

Relevant code:

- `lib/wallet.ts`
- `app/api/session/end/route.ts`
- `app/api/billing/wallet/route.ts`

What the repo does today:

- accrues payout balances automatically
- exposes payout history and FX preview for display

What is still operational:

- final bank or transfer disbursement execution is not exposed as a first-class route in this tree

## Sharing and Provider Control

PeerMesh providers run through either:

- the Electron desktop app
- the CLI helper

Sharing enforcement:

- only `peer` and `host` roles can share
- provider registration is blocked unless the account is phone verified
- provider registration is blocked unless provider terms were accepted
- `client` accounts cannot register provider relays or enable sharing

Provider-control endpoints:

- sharing state and helper sync: `app/api/user/sharing/route.ts`
- relay registration auth: `app/api/relay/auth/route.ts`
- role switching: `app/api/account/role/route.ts`

Provider capabilities include:

- multi-slot sharing
- daily profile limits
- daily per-slot limits
- public country-based matching
- private share codes per device or slot
- desktop and relay reconnect behavior

## Connection Modes

### Public mode

Public browsing selects any eligible provider in the requested country.

Selection inputs:

- country code
- preferred provider memory from prior successful sessions
- provider slot occupancy
- relay availability
- private-share exclusion

Requesters do not browse a raw public provider list. They only see country-level availability.

### Private mode

Private browsing uses a 9-digit share code backed by `private_share_devices`.

Private-mode enforcement:

- the code must exist
- the code must be active
- the code cannot belong to the requester
- the relay auth path must match the provider user and base device stored on the session

## Session Lifecycle

### Session creation

`app/api/session/create/route.ts`:

- resolves requester auth
- enforces email, phone, role, trust, and billing rules
- validates private share codes when present
- selects relay candidates
- inserts a pending session row
- issues a signed accountability receipt

Session metadata stored at creation may include:

- `request_access_mode`
- `request_auth_kind`
- `api_key_id`
- `request_id`
- `pricing_tier`
- `requested_bandwidth_gb`
- `requested_rpm`
- `requested_period_hours`
- `requested_session_mode`
- `estimated_cost_usd`

### Relay auth

`app/api/relay/auth/route.ts`:

- validates provider vs requester role
- rejects API keys for provider registration
- ensures API keys can only attach to sessions they actually created
- ensures private-route claims match the authorized session row

### Session finalization

`app/api/session/end/route.ts`:

- ends the session exactly once
- records final bytes and provider metadata
- settles requester billing
- increments requester monthly bandwidth
- increments provider shared bytes when appropriate
- updates preferred-provider memory

This route is the main settlement checkpoint for both user-auth and API-key sessions.

## Authentication Surfaces

PeerMesh currently supports:

- Supabase user sessions
- device and desktop session tokens
- PeerMesh API keys

Relevant routes:

- `app/api/extension-auth/route.ts`
- `app/api/extension-auth/refresh/route.ts`
- `app/api/device-token/route.ts`
- `app/api/agent-token/route.ts`
- `app/api/auth/*`

Current auth properties:

- email confirmation is enforced
- desktop refresh requires real refresh tokens
- refresh sessions are stored as hashed device-session records
- relay auth validates the session owner before allowing traffic

## Wallet and Payments

Wallet funding is handled through Flutterwave.

Implemented routes:

- checkout: `app/api/billing/flutterwave/checkout/route.ts`
- verify: `app/api/billing/flutterwave/verify/route.ts`
- webhook: `app/api/billing/flutterwave/webhook/route.ts`
- wallet summary: `app/api/billing/wallet/route.ts`

Settlement primitives:

- top-up verification credits `wallet_balance_usd`
- wallet ledger records payment and debit events
- payout preview can convert pending USD value into a configured payout currency estimate

## Major Data Tables

The main persistence model lives in `supabase.sql`.

Core tables:

- `profiles`
- `sessions`
- `provider_devices`
- `private_share_devices`
- `provider_slot_limits`
- `payment_transactions`
- `wallet_ledger`
- `provider_payouts`
- `api_keys`
- `api_usage`
- `device_sessions`
- `extension_auth_tokens`
- `device_codes`

Key RPCs and functions:

- `increment_bandwidth`
- `increment_bytes_shared`
- `set_preferred_provider`
- `cleanup_stale_sessions`

## Operational Prerequisites

For a real deployment, PeerMesh still depends on the surrounding environment being configured correctly.

Important secrets and external dependencies include:

- Supabase URL, anon key, and service-role credentials
- relay secret and receipt secret
- Flutterwave credentials
- Twilio credentials when phone bypass is disabled
- provider desktop and CLI distribution artifacts

## Summary

PeerMesh now enforces the core v1 mechanics that matter for runtime correctness:

- role-based requester/provider boundaries
- metered API-key authentication and usage accounting
- free-allocation, contribution-credit, and wallet settlement
- provider earning accrual into payout balances
- signed session receipts and relay-checked ownership

The codebase is now in a releasable state for the main product flow, with release gates passing and the previously missing request-path enforcement implemented.
