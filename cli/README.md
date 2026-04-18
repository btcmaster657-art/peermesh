# PeerMesh Provider CLI

Share your internet connection with PeerMesh and earn free browsing credits.  
Works as a **drop-in alternative to the desktop app** — the dashboard and extension detect it automatically on port 7654.

---

## Install

### Windows (cmd / winglet)
```cmd
curl -fsSL https://nodejs.org/dist/v20.11.0/node-v20.11.0-x64.msi -o node.msi && msiexec /i node.msi /quiet && npm install -g peermesh-provider
```

### Windows (PowerShell / Invoke)
```powershell
Invoke-WebRequest https://nodejs.org/dist/v20.11.0/node-v20.11.0-x64.msi -OutFile node.msi; Start-Process msiexec -ArgumentList '/i node.msi /quiet' -Wait; npm install -g peermesh-provider
```

### macOS (built-in curl + brew)
```bash
brew install node && npm install -g peermesh-provider
```
Or without Homebrew (built-in curl only):
```bash
curl -fsSL https://nodejs.org/dist/v20.11.0/node-v20.11.0.pkg -o node.pkg && sudo installer -pkg node.pkg -target / && npm install -g peermesh-provider
```

### Linux (built-in curl)
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs && npm install -g peermesh-provider
```

---

## Run without installing

```bash
npx peermesh-provider
```

---

## Run

```bash
peermesh-provider
```

First run opens a sign-in page in your browser. Enter the code shown, approve it, and you're sharing.

The CLI starts a control server on **port 7654** — the same port the desktop app uses.  
The dashboard and extension will detect it automatically and show **● CLI** in the header.

---

## Options

```bash
# Set a daily bandwidth limit (auto-disconnects when reached)
peermesh-provider --limit 500        # 500 MB/day
peermesh-provider --limit 1024       # 1 GB/day

# Remove your daily limit
peermesh-provider --no-limit

# Override your country code
peermesh-provider --country NG

# Show today's usage and exit
peermesh-provider --status

# Clear saved credentials and re-authenticate
peermesh-provider --reset
```

---

## Sync with dashboard / extension

The CLI and desktop app are interchangeable — both expose the same HTTP control API on `localhost:7654`.

- Dashboard share toggle controls the CLI just like the desktop app
- Extension detects the CLI and shows the correct helper label
- Only one can run at a time on the same machine (same port)

---

## Keep it running

**Mac/Linux — systemd (built-in):**
```bash
sudo tee /etc/systemd/system/peermesh.service <<EOF
[Unit]
Description=PeerMesh Provider
After=network.target

[Service]
ExecStart=$(which peermesh-provider)
Restart=always
User=$USER

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl enable --now peermesh.service
```

**Mac — launchd (built-in):**
```bash
cat > ~/Library/LaunchAgents/app.peermesh.provider.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>app.peermesh.provider</string>
  <key>ProgramArguments</key><array><string>$(which peermesh-provider)</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
EOF
launchctl load ~/Library/LaunchAgents/app.peermesh.provider.plist
```

**Windows — Task Scheduler (built-in):**
```powershell
$action = New-ScheduledTaskAction -Execute "$(where.exe peermesh-provider)"
$trigger = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName "PeerMesh Provider" -Action $action -Trigger $trigger -RunLevel Highest -Force
```

---

## Uninstall

```bash
npm uninstall -g peermesh-provider
```

To also remove saved credentials and config:

**Mac/Linux:**
```bash
rm -rf ~/.peermesh
```

**Windows (PowerShell):**
```powershell
Remove-Item -Recurse -Force "$env:USERPROFILE\.peermesh"
```

**Windows (cmd):**
```cmd
rmdir /s /q "%USERPROFILE%\.peermesh"
```

If you set up a background service, remove it first:

**Linux — systemd:**
```bash
sudo systemctl disable --now peermesh.service
sudo rm /etc/systemd/system/peermesh.service
```

**Mac — launchd:**
```bash
launchctl unload ~/Library/LaunchAgents/app.peermesh.provider.plist
rm ~/Library/LaunchAgents/app.peermesh.provider.plist
```

**Windows — Task Scheduler:**
```powershell
Unregister-ScheduledTask -TaskName "PeerMesh Provider" -Confirm:$false
```

---

## What it does

- Connects to the PeerMesh relay as a provider
- Routes other users' HTTPS traffic through your connection
- Earns you browsing credits (free tier access)
- Exposes a control server on port 7654 so the dashboard and extension can detect and control it
- Blocks: .onion, SMTP, mail servers, torrent trackers, private IPs
- Sends a heartbeat every 30s to keep your peer count accurate
- Flushes bandwidth stats to the server every 5s
- Auto-disconnects when daily limit is reached (if set)
