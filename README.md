# pi-remote-web-ui

A minimal, secure web GUI for the [pi coding agent](https://github.com/badlogic/pi-mono).

<img width="1055" height="863" alt="image" src="https://github.com/user-attachments/assets/b4527eb5-a4a4-490d-bbd0-d046ea8755e6" />



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
Browser tabs (localhost:8080)
  │
  │  SSH tunnel
  │
  └─► pi-remote-web-ui server (127.0.0.1:8080)  ← binds here only
        │
        ├─► AgentSession (in-process, shared across all tabs)
        │     Uses pi SDK directly — no subprocess spawning
        │     tools: bash, read, edit, write …
        │
        └─► static files (dist/)
```

A single `AgentSession` instance runs inside the server process.
All browser tabs share the same conversation — events are broadcast to every
connected client in real time.  When a new tab connects, it receives the
full conversation history via a `state_sync` message.

This follows the [pi SDK recommendation](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/sdk.md)
for Node.js applications to use `AgentSession` directly rather than spawning
`pi --mode rpc` subprocesses.

## Setup

### 1. Install dependencies & build

```bash
cd ~/dev/pi-remote-web-ui
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
sudo cp pi-remote-web-ui.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pi-remote-web-ui
sudo systemctl status pi-remote-web-ui
```

View logs:
```bash
journalctl -u pi-remote-web-ui -f
```

## Usage

| Action | How |
|--------|-----|
| Send message | Type and press **Enter** |
| New line in message | **Shift+Enter** |
| Abort generation | Click **Stop** button |
| New session | Click **＋ New** in the header (resets for all tabs) |
| Expand tool output | Click any tool card |
| Expand thinking | Click the 💭 Thinking block |

**Note:** All connected tabs share the same session.  Starting a new session
or sending a prompt from any tab affects every tab.

## Project structure

```
pi-remote-web-ui/
├── index.html                  Frontend entry point
├── src/
│   ├── main.ts                 Frontend app (TypeScript)
│   └── style.css               Dark theme
├── server/
│   └── index.ts                WebSocket + HTTP server (AgentSession in-process)
├── dist/                       Built frontend (git-ignored)
├── dist-server/                Built server  (git-ignored)
├── pi-remote-web-ui.service    systemd unit file
├── vite.config.ts              Frontend build config
├── tsconfig.json               Frontend TypeScript config
└── tsconfig.server.json        Server TypeScript config
```
