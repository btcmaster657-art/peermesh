# Local Dev Testing Guide

One env var — `PEERMESH_ENV` — selects which named variables to use.
No hardcoded URLs anywhere. If a required variable is missing, the process
exits immediately with a clear error message.

---

## Environment modes

| `PEERMESH_ENV` | API var used | Relay var used |
|---|---|---|
| `production` | `API_BASE` | `RELAY_ENDPOINTS` |
| `dev` | `API_BASE_DEV` | `RELAY_ENDPOINTS_DEV` |
| `local` | `API_BASE_LOCAL` | `RELAY_ENDPOINTS_LOCAL` |

All three sets of vars live in `.env.local` (and `.env.local.dev` as a template).
To switch environment, change only `PEERMESH_ENV` — nothing else.

---

## Switch to local testing

Change one line in `.env.local`:

```
PEERMESH_ENV=local
```

Then restart Next.js and the relay. All clients pick up the change automatically.

---

## Start a full local test session

```bash
# Terminal 1 — Next.js (reads .env.local)
npm run dev

# Terminal 2 — local relay
PEERMESH_ENV=local node relay/relay.js
# Windows PowerShell:
$env:PEERMESH_ENV="local"; node relay/relay.js

# Terminal 3 — CLI provider
PEERMESH_ENV=local node cli/index.js
# Windows:
$env:PEERMESH_ENV="local"; node cli/index.js

# Extension — build dev config then load unpacked
PEERMESH_ENV=local node build-save-extension.js --dev
# Windows:
$env:PEERMESH_ENV="local"; node build-save-extension.js --dev
# → load extension/ folder at chrome://extensions (Load unpacked)

# Desktop
$env:PEERMESH_ENV="local"; cd desktop; npx electron .
```

---

## Switch to dev (staging) environment

```
PEERMESH_ENV=dev
```

Uses `API_BASE_DEV` and `RELAY_ENDPOINTS_DEV` — point these at a staging
deployment or a different Vercel preview URL.

---

## Deploy to production

```
PEERMESH_ENV=production
```

```bash
# Rebuild extension for prod
node build-save-extension.js
# Deploy Next.js
npx vercel --prod
```

---

## Error if a variable is missing

If `PEERMESH_ENV=local` but `API_BASE_LOCAL` is not set:

```
[ENV] ERROR: API_BASE_LOCAL is required when PEERMESH_ENV=local but is not set
```

Process exits immediately. Fix: add the missing variable to `.env.local`.

---

## Variable reference

```
# Selector
PEERMESH_ENV=production|dev|local

# API URLs — one per environment
API_BASE=https://peermesh-beta.vercel.app
API_BASE_DEV=https://your-staging.vercel.app
API_BASE_LOCAL=http://localhost:3000

# Relay endpoints — one per environment (comma-separated)
RELAY_ENDPOINTS=wss://peermesh-relay.fly.dev,wss://peermesh-2ma4.onrender.com
RELAY_ENDPOINTS_DEV=wss://peermesh-relay.fly.dev,wss://peermesh-2ma4.onrender.com
RELAY_ENDPOINTS_LOCAL=ws://localhost:8080

# Shared across all environments
RELAY_SECRET=<your-relay-secret>
```
