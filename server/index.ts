/**
 * pi-gui server
 *
 * Binds to 127.0.0.1:8080 only.  Access is via SSH port-forwarding:
 *   ssh -L 8080:localhost:8080 user@your-vps
 *
 * Uses AgentSession directly (per pi SDK docs) instead of spawning
 * `pi --mode rpc` subprocesses.  A single AgentSession is shared
 * across all WebSocket connections — every connected tab observes the
 * same conversation in real time.
 */

import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { fileURLToPath } from "url";
import { WebSocketServer, WebSocket } from "ws";
import {
  createAgentSession,
  AuthStorage,
  ModelRegistry,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import type { AgentSession } from "@mariozechner/pi-coding-agent";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "../dist");
const PORT = 8080;
const HOST = "127.0.0.1"; // Never expose to the internet – use SSH tunnel

// ── MIME types ────────────────────────────────────────────────────────────────
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

// ── HTTP static-file server ───────────────────────────────────────────────────
function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
  let urlPath = req.url ?? "/";

  // Strip query string
  const qIdx = urlPath.indexOf("?");
  if (qIdx !== -1) urlPath = urlPath.slice(0, qIdx);

  // Decode and normalise
  try {
    urlPath = decodeURIComponent(urlPath);
  } catch {
    /* ignore */
  }
  const safePath = path.normalize(urlPath).replace(/\\/g, "/");

  // Map "/" to index.html
  const target = safePath === "/" ? "index.html" : safePath.replace(/^\//, "");
  const absPath = path.join(PUBLIC_DIR, target);

  // Directory-traversal guard
  if (!absPath.startsWith(PUBLIC_DIR + path.sep) && absPath !== PUBLIC_DIR) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  const ext = path.extname(absPath).toLowerCase();
  const mime = MIME[ext] ?? "application/octet-stream";

  fs.readFile(absPath, (err, data) => {
    if (err) {
      // SPA fallback – serve index.html for any unknown path
      fs.readFile(path.join(PUBLIC_DIR, "index.html"), (e2, d2) => {
        if (e2) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(d2);
      });
      return;
    }
    res.writeHead(200, { "Content-Type": mime });
    res.end(data);
  });
}

// ── Extension UI bridge ───────────────────────────────────────────────────────
// Extension UI requests (select, confirm, input, etc.) need to be forwarded to
// the browser and the response sent back.  We keep a map of pending requests
// keyed by a random UUID.

type PendingUIRequest = {
  resolve: (response: Record<string, unknown>) => void;
  reject: (err: Error) => void;
};

const pendingExtensionRequests = new Map<string, PendingUIRequest>();

function broadcast(wss: WebSocketServer, msg: unknown) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

function createExtensionUIContext(wss: WebSocketServer) {
  function createDialogPromise<T>(
    opts: { signal?: AbortSignal; timeout?: number } | undefined,
    defaultValue: T,
    request: Record<string, unknown>,
    parseResponse: (r: Record<string, unknown>) => T,
  ): Promise<T> {
    if (opts?.signal?.aborted) return Promise.resolve(defaultValue);
    const id = crypto.randomUUID();
    return new Promise<T>((resolve, _reject) => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        opts?.signal?.removeEventListener("abort", onAbort);
        pendingExtensionRequests.delete(id);
      };
      const onAbort = () => {
        cleanup();
        resolve(defaultValue);
      };
      opts?.signal?.addEventListener("abort", onAbort, { once: true });
      if (opts?.timeout) {
        timeoutId = setTimeout(() => {
          cleanup();
          resolve(defaultValue);
        }, opts.timeout);
      }
      pendingExtensionRequests.set(id, {
        resolve: (response) => {
          cleanup();
          resolve(parseResponse(response));
        },
        reject: (err) => {
          cleanup();
          resolve(defaultValue);
        },
      });
      broadcast(wss, { type: "extension_ui_request", id, ...request });
    });
  }

  return {
    select: (
      title: string,
      options: string[],
      opts?: { signal?: AbortSignal; timeout?: number },
    ) =>
      createDialogPromise(
        opts,
        undefined as string | undefined,
        { method: "select", title, options, timeout: opts?.timeout },
        (r: Record<string, unknown>) =>
          "cancelled" in r && r.cancelled
            ? undefined
            : "value" in r
              ? (r.value as string)
              : undefined,
      ),
    confirm: (
      title: string,
      message?: string,
      opts?: { signal?: AbortSignal; timeout?: number },
    ) =>
      createDialogPromise(
        opts,
        false,
        { method: "confirm", title, message, timeout: opts?.timeout },
        (r: Record<string, unknown>) =>
          "cancelled" in r && r.cancelled
            ? false
            : "confirmed" in r
              ? (r.confirmed as boolean)
              : false,
      ),
    input: (
      title: string,
      placeholder?: string,
      opts?: { signal?: AbortSignal; timeout?: number },
    ) =>
      createDialogPromise(
        opts,
        undefined as string | undefined,
        { method: "input", title, placeholder, timeout: opts?.timeout },
        (r: Record<string, unknown>) =>
          "cancelled" in r && r.cancelled
            ? undefined
            : "value" in r
              ? (r.value as string)
              : undefined,
      ),
    notify(message: string, type?: "info" | "warning" | "error") {
      broadcast(wss, {
        type: "extension_ui_request",
        id: crypto.randomUUID(),
        method: "notify",
        message,
        notifyType: type,
      });
    },
    onTerminalInput() {
      return () => {};
    },
    setStatus(key: string, text: string | undefined) {
      broadcast(wss, {
        type: "extension_ui_request",
        id: crypto.randomUUID(),
        method: "setStatus",
        statusKey: key,
        statusText: text,
      });
    },
    setWorkingMessage(_message: string | undefined) {
      // Not supported in web UI
    },
    setWidget(
      key: string,
      content: string[] | undefined,
      options?: { placement?: string },
    ) {
      if (content === undefined || Array.isArray(content)) {
        broadcast(wss, {
          type: "extension_ui_request",
          id: crypto.randomUUID(),
          method: "setWidget",
          widgetKey: key,
          widgetLines: content,
          widgetPlacement: options?.placement,
        });
      }
    },
    setTitle(_title: string | undefined) {
      // Not supported in web UI
    },
    editor: undefined,
  };
}

// ── Boot ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("Initialising AgentSession…");

  const authStorage = AuthStorage.create();
  const modelRegistry = new ModelRegistry(authStorage);

  const { session } = await createAgentSession({
    sessionManager: SessionManager.create(process.cwd()),
    authStorage,
    modelRegistry,
  });

  console.log(
    `AgentSession ready (model: ${session.model?.id ?? "default"}, session: ${session.sessionId})`,
  );

  // ── HTTP + WebSocket server ───────────────────────────────────────────────
  const server = http.createServer(serveStatic);
  const wss = new WebSocketServer({ server, path: "/ws" });

  // Subscribe to all agent events and broadcast to every connected client.
  session.subscribe((event) => {
    broadcast(wss, event);
  });

  // Bind extension UI context so extensions can show dialogs, notifications, etc.
  await session.bindExtensions({
    uiContext: createExtensionUIContext(wss) as any,
    onError: (err) => {
      broadcast(wss, {
        type: "extension_error",
        extensionPath: err.extensionPath,
        event: err.event,
        error: err.error,
      });
    },
  });

  // ── WebSocket connection handling ─────────────────────────────────────────
  wss.on("connection", (ws: WebSocket) => {
    console.log(
      `[${new Date().toISOString()}] Client connected (${wss.clients.size} total)`,
    );

    // Send current conversation state so the new tab catches up.
    const messages = session.messages;
    ws.send(
      JSON.stringify({
        type: "state_sync",
        messages,
        streaming: session.isStreaming,
        model: session.model?.id,
        sessionId: session.sessionId,
      }),
    );

    // ── Client → AgentSession ─────────────────────────────────────────────
    ws.on("message", async (data) => {
      let cmd: Record<string, unknown>;
      try {
        cmd = JSON.parse(data.toString());
      } catch {
        return;
      }

      try {
        switch (cmd.type) {
          case "prompt": {
            const text = cmd.message as string;
            if (!text) break;
            if (session.isStreaming) {
              await session.prompt(text, {
                streamingBehavior:
                  (cmd.streamingBehavior as "steer" | "followUp") ?? "followUp",
              });
            } else {
              // Don't await — prompt is async and we don't want to block the ws handler.
              // Events stream via the subscription above.
              session.prompt(text).catch((err) => {
                console.error("[prompt error]", err);
              });
            }
            break;
          }

          case "abort":
            await session.abort();
            break;

          case "new_session":
            await session.newSession();
            // Notify all clients that the session was reset
            broadcast(wss, {
              type: "state_sync",
              messages: session.messages,
              streaming: session.isStreaming,
              model: session.model?.id,
              sessionId: session.sessionId,
            });
            break;

          case "extension_ui_response": {
            const id = cmd.id as string;
            const pending = pendingExtensionRequests.get(id);
            if (pending) {
              pendingExtensionRequests.delete(id);
              pending.resolve(cmd as Record<string, unknown>);
            }
            break;
          }

          default:
            // Unknown command — ignore
            break;
        }
      } catch (err) {
        console.error(`[cmd error] ${cmd.type}:`, err);
      }
    });

    ws.on("close", () => {
      console.log(
        `[${new Date().toISOString()}] Client disconnected (${wss.clients.size} total)`,
      );
    });

    ws.on("error", (err) => {
      console.error("[ws error]", err);
    });
  });

  server.listen(PORT, HOST, () => {
    console.log(`pi-gui listening on http://${HOST}:${PORT}`);
    console.log(
      `Access via SSH tunnel: ssh -L ${PORT}:localhost:${PORT} user@your-vps`,
    );
    console.log(`Then open: http://localhost:${PORT}`);
  });

  // Graceful shutdown
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      console.log(`\n${sig} received, shutting down…`);
      session.dispose();
      server.close();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
