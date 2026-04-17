# PeerMesh Desktop App

Lightweight Electron tray app. Shares your connection silently in the background.

## Features
- Sits in system tray — no window needed
- Auto-starts with Windows/Mac on login
- Toggle sharing on/off from tray menu
- Auto-detects sign-in from peermesh.com
- Integrates with dashboard (localhost:7654 control server)

## Development

```bash
cd desktop
npm install
npm start
```

## Build installer

```bash
# Windows (.exe installer)
npm run build-win

# Mac (.dmg)
npm run build-mac
```

Output goes to `desktop/dist/`.

## How auth works

1. User opens the app — sees "Sign in with browser"
2. App opens peermesh.com/dashboard in browser
3. User signs in on website
4. App polls `/api/extension-auth` every 2s
5. Detects login → saves token → starts sharing automatically
6. From then on: app auto-starts on login and shares silently

## Files

- `main.js` — Electron main process, tray, relay WebSocket, HTTP proxy
- `preload.js` — Secure IPC bridge
- `renderer/index.html` — Settings window UI
- `renderer/app.js` — UI logic
- `assets/` — Icons (icon.ico, icon.icns, icon.png)
