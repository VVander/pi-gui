# Pi-GUI Agent Guidelines

## Repository Rules

- The `main` branch is protected: all changes require a pull request approved by the repository owner.
- Never commit directly to `main`. Always create a feature branch and submit a PR.

## Project Overview

Pi-GUI is a web GUI for the [pi coding agent](https://github.com/badlogic/pi-mono), accessed securely via SSH port forwarding. The server uses the pi SDK's `AgentSession` API directly (no subprocesses). All connected browser tabs share a single session.

## Architecture

- **Server** (`server/index.ts`): HTTP static server + WebSocket, with an in-process `AgentSession` from `@mariozechner/pi-coding-agent`. Events are broadcast to all connected clients.
- **Frontend** (`src/main.ts`): Vanilla TypeScript SPA. Renders markdown (marked + highlight.js), tool cards, thinking blocks, and extension UI dialogs.
- **Build**: Vite for frontend, `tsc` for server. Output in `dist/` and `dist-server/`.
- **Deployment**: systemd service (`pi-gui.service`), binds to `127.0.0.1:8080` only.

## Development Workflow

1. Create a branch from `main`
2. Make changes, test with `npm run dev` (Vite HMR + tsx watch)
3. Build: `npm run build && npm run build:server`
4. Push the branch and open a PR against `main`
5. PR must be approved before merging
