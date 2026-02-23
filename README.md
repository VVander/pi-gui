# pi-gui

A minimal, secure web GUI for the [pi coding agent](https://github.com/badlogic/pi-mono).

## Security model

The server **only binds to `127.0.0.1`** – it is never reachable from the internet.
You access it by forwarding a port through your existing SSH connection:

```
ssh -L 8080:localhost:8080 root@your-vps
```

Then open **http://localhost:8080** in your browser.
Authentication is provided entirely by your SSH key – no passwords, tokens, or TLS certificates required.

Add this to `~/.ssh/config` on your local machine so the tunnel opens automatically every time you SSH in:

```
Host your-vps
    HostName <your-vps-ip>
    User root
    IdentityFile ~/.ssh/your_key
    LocalForward 8080 127.0.0.1:8080
```

## Architecture

```
Browser (localhost:8080)
  │
  │  SSH tunnel
  │
  └─► pi-gui server (127.0.0.1:8080)  ← binds here only
        │
        │  WebSocket /ws
        │
        ├─► pi --mode rpc  (one process per browser tab)
        │     stdin/stdout: JSON RPC protocol
        │     tools: bash, read, edit, write …
        │
        └─► static files (dist/)
```

Each browser tab gets its own dedicated `pi` process with full tool access.
The pi process inherits the server's environment (API keys, settings, etc.).

## Setup

### 1. Install dependencies & build

```bash
cd ~/dev/pi-gui
npm install
npm run build        # builds frontend → dist/
npm run build:server # compiles server → dist-server/
```

### 2. Run manually (for testing)

```bash
# Option A – run compiled server
node dist-server/index.js

# Option B – dev mode (Vite HMR + tsx watch)
npm run dev
```

Then SSH in with port forwarding and open http://localhost:8080.

### 3. Install as a systemd service (runs on boot, auto-restarts)

```bash
sudo cp pi-gui.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pi-gui
sudo systemctl status pi-gui
```

View logs:
```bash
journalctl -u pi-gui -f
```

## Usage

| Action | How |
|--------|-----|
| Send message | Type and press **Enter** |
| New line in message | **Shift+Enter** |
| Abort generation | Click **Stop** button |
| New session | Click **＋ New** in the header |
| Expand tool output | Click any tool card |
| Expand thinking | Click the 💭 Thinking block |

## Project structure

```
pi-gui/
├── index.html            Frontend entry point
├── src/
│   ├── main.ts           Frontend app (TypeScript)
│   └── style.css         Dark theme
├── server/
│   └── index.ts          WebSocket + HTTP server
├── dist/                 Built frontend (git-ignored)
├── dist-server/          Built server  (git-ignored)
├── pi-gui.service        systemd unit file
├── vite.config.ts        Frontend build config
├── tsconfig.json         Frontend TypeScript config
└── tsconfig.server.json  Server TypeScript config
```
