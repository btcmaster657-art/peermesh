// Provider-side logic is handled by the desktop app (desktop/main.js) and CLI (cli/index.js).
// Both register with the relay via WebSocket as agentMode providers and handle
// proxy_request / open_tunnel messages directly — no browser-side provider class is needed.
export {}
