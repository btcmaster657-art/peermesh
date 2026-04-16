# Production Deployment

## How the agent works in production

```
User's browser (anywhere)
    ↓ loads dashboard from
Vercel (your Next.js app)
    ↓ dashboard JS runs in user's browser
    ↓ calls localhost:7654 (user's own machine)
User's PC running agent.js
    ↓ agent connects to
Fly.io relay (wss://peermesh-relay.fly.dev)
    ↓ fetches URLs using
User's real IP (Rwanda, Nigeria, etc.)
```

`localhost:7654` always resolves to the user's own machine regardless of where
the dashboard is hosted. This is correct — the agent runs on the provider's PC.

---

## Step 1 — Deploy relay to Fly.io

```bash
cd relay
fly launch    # first time only
fly deploy
```

Note the URL: `wss://peermesh-relay.fly.dev`

---

## Step 2 — Set Vercel environment variables

In Vercel dashboard → Settings → Environment Variables:

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | your supabase url |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | your anon key |
| `SUPABASE_SERVICE_ROLE` | your service role key |
| `NEXT_PUBLIC_RELAY_ENDPOINT` | `wss://peermesh-relay.fly.dev` |
| `RELAY_ENDPOINTS` | `wss://peermesh-relay.fly.dev` |
| `RELAY_SECRET` | a random secret string |
| `NEXT_PUBLIC_APP_URL` | `https://your-app.vercel.app` |
| `NEXT_PUBLIC_SITE_URL` | `https://your-app.vercel.app` |
| `NEXT_PUBLIC_BYPASS_VERIFICATION` | `false` |

---

## Step 3 — Deploy to Vercel

```bash
git add .
git commit -m "production ready"
git push
```

Vercel auto-deploys on push.

---

## Step 4 — Update Supabase auth settings

In Supabase → Authentication → URL Configuration:
- Site URL: `https://your-app.vercel.app`
- Redirect URLs: `https://your-app.vercel.app/**`

---

## How providers share their connection

1. Provider visits `https://your-app.vercel.app/dashboard`
2. Toggles "Share my connection"
3. Dashboard detects no agent at `localhost:7654`
4. Shows download button → provider downloads `peermesh-agent.js`
5. Provider runs:
   ```bash
   npm install ws
   node peermesh-agent.js
   ```
6. Dashboard detects agent, sends config (relay URL + token + userId + country)
7. Agent connects to Fly.io relay from provider's real IP
8. Provider shows as available in peer counts

## How requesters browse

1. Requester visits dashboard, selects country, clicks Connect
2. Session created in Supabase
3. Browser connects to Fly.io relay via WebSocket
4. Relay matches with available provider agent
5. Fetch requests go: Browser → Relay → Provider Agent → Target Site
6. Response goes: Target Site → Provider Agent → Relay → Browser → iframe
7. All traffic appears to come from provider's real IP
