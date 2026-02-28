/**
 * pi-remote-web-ui server
 *
 * Binds to 127.0.0.1:8080 only.  Access is via SSH port-forwarding:
 *   ssh -L 8080:localhost:8080 user@your-vps
 *
 * Supports multiple named sessions ("tabs").  Each WebSocket client tracks
 * which tab it is currently viewing; session events are only forwarded to
 * clients watching the corresponding tab.
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
  type SessionInfo,
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

// ── Tab management ────────────────────────────────────────────────────────────

interface TabEntry {
  tabId: string;
  name: string;
  session: AgentSession;
}

// Ordered list of tab IDs (creation order)
const tabOrder: string[] = [];
// tabId → TabEntry
const tabs = new Map<string, TabEntry>();
// WebSocket → tabId the client is currently viewing
const clientActiveTab = new Map<WebSocket, string>();
// Counter for default tab names
let tabCounter = 0;

function getTabsList(): Array<{ tabId: string; name: string }> {
  return tabOrder
    .filter((id) => tabs.has(id))
    .map((id) => {
      const t = tabs.get(id)!;
      return { tabId: t.tabId, name: t.name };
    });
}

/** Send to all connected clients regardless of active tab. */
function broadcastAll(wss: WebSocketServer, msg: unknown) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

/** Send only to clients currently viewing the given tab. */
function broadcastToTabViewers(wss: WebSocketServer, tabId: string, msg: unknown) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (
      client.readyState === WebSocket.OPEN &&
      clientActiveTab.get(client) === tabId
    ) {
      client.send(data);
    }
  }
}

/** Send the current tabs list to every connected client. */
function broadcastTabsList(wss: WebSocketServer) {
  broadcastAll(wss, { type: "tabs_update", tabs: getTabsList() });
}

/** Send a state_sync for the given tab to a single WebSocket client. */
function sendStateSync(ws: WebSocket, entry: TabEntry) {
  ws.send(
    JSON.stringify({
      type: "state_sync",
      tabId: entry.tabId,
      messages: entry.session.messages,
      streaming: entry.session.isStreaming,
      model: entry.session.model?.id,
      sessionId: entry.session.sessionId,
    })
  );
}

/** Create a new tab (and its underlying AgentSession).
 *  Pass `sessionPath` to resume an existing session file. */
async function createTab(
  wss: WebSocketServer,
  authStorage: AuthStorage,
  modelRegistry: ModelRegistry,
  name?: string,
  sessionPath?: string,
): Promise<TabEntry> {
  const tabId = crypto.randomUUID();
  tabCounter++;

  const sessionManager = sessionPath
    ? SessionManager.open(sessionPath)
    : SessionManager.create(process.cwd());

  const { session } = await createAgentSession({
    sessionManager,
    authStorage,
    modelRegistry,
  });

  // Derive a display name: prefer explicit arg, then session's own name, else counter
  const displayName = name ?? (sessionPath ? (sessionManager.getSessionName() ?? `Session ${tabCounter}`) : `Session ${tabCounter}`);

  // Forward all session events only to clients currently viewing this tab.
  session.subscribe((event) => {
    broadcastToTabViewers(wss, tabId, event);
  });

  await session.bindExtensions({
    uiContext: createExtensionUIContext(wss) as any,
    onError: (err) => {
      broadcastToTabViewers(wss, tabId, {
        type: "extension_error",
        extensionPath: err.extensionPath,
        event: err.event,
        error: err.error,
      });
    },
  });

  const entry: TabEntry = { tabId, name: displayName, session };
  tabs.set(tabId, entry);
  tabOrder.push(tabId);
  return entry;
}

/** Close a tab.  Returns the tabId clients should switch to, or null if none left. */
function closeTab(tabId: string): string | null {
  const entry = tabs.get(tabId);
  if (!entry) return null;

  // Refuse to close the last remaining tab.
  if (tabs.size <= 1) return tabId;

  // Determine replacement tab for clients that were watching this one.
  const idx = tabOrder.indexOf(tabId);
  const remainingOrder = tabOrder.filter((id) => id !== tabId && tabs.has(id));
  const replacementId = remainingOrder[Math.max(0, idx - 1)] ?? remainingOrder[0] ?? null;

  // Dispose session and remove from tracking.
  entry.session.dispose();
  tabs.delete(tabId);
  const orderIdx = tabOrder.indexOf(tabId);
  if (orderIdx !== -1) tabOrder.splice(orderIdx, 1);

  return replacementId;
}

// ── Extension UI context factory ──────────────────────────────────────────────

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
        reject: (_err) => {
          cleanup();
          resolve(defaultValue);
        },
      });
      broadcastAll(wss, { type: "extension_ui_request", id, ...request });
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
      broadcastAll(wss, {
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
      broadcastAll(wss, {
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
        broadcastAll(wss, {
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
  console.log("Initialising pi-remote-web-ui…");

  const authStorage = AuthStorage.create();
  const modelRegistry = new ModelRegistry(authStorage);

  // ── HTTP + WebSocket server ───────────────────────────────────────────────
  const server = http.createServer(serveStatic);
  const wss = new WebSocketServer({ server, path: "/ws" });

  // Create the first tab now that wss exists (needed for extension UI context).
  const initialTab = await createTab(wss, authStorage, modelRegistry, "Session 1");
  console.log(
    `Initial tab ready (model: ${initialTab.session.model?.id ?? "default"}, session: ${initialTab.session.sessionId})`
  );

  // ── WebSocket connection handling ─────────────────────────────────────────
  wss.on("connection", (ws: WebSocket) => {
    console.log(
      `[${new Date().toISOString()}] Client connected (${wss.clients.size} total)`
    );

    // Assign the new client to the first tab.
    const firstTabId = tabOrder[0];
    clientActiveTab.set(ws, firstTabId);

    // Send the current tab list and current session state.
    ws.send(JSON.stringify({ type: "tabs_update", tabs: getTabsList() }));
    const firstEntry = tabs.get(firstTabId)!;
    sendStateSync(ws, firstEntry);

    // ── Client → AgentSession ─────────────────────────────────────────────
    ws.on("message", async (data) => {
      let cmd: Record<string, unknown>;
      try {
        cmd = JSON.parse(data.toString());
      } catch {
        return;
      }

      try {
        // Resolve the session for the tab this client is currently viewing.
        const activeTabId = clientActiveTab.get(ws) ?? tabOrder[0];
        const activeEntry = tabs.get(activeTabId);

        switch (cmd.type) {
          case "prompt": {
            const text = cmd.message as string;
            if (!text || !activeEntry) break;
            const session = activeEntry.session;
            if (session.isStreaming) {
              await session.prompt(text, {
                streamingBehavior:
                  (cmd.streamingBehavior as "steer" | "followUp") ?? "followUp",
              });
            } else {
              session.prompt(text).catch((err) => {
                console.error("[prompt error]", err);
              });
            }
            break;
          }

          case "abort":
            if (activeEntry) await activeEntry.session.abort();
            break;

          case "new_session": {
            // Create a brand-new tab.
            const newEntry = await createTab(wss, authStorage, modelRegistry);
            // Switch this client to the new tab.
            clientActiveTab.set(ws, newEntry.tabId);
            // Tell everyone about the updated tab list.
            broadcastTabsList(wss);
            // Send fresh state to this client.
            sendStateSync(ws, newEntry);
            break;
          }

          case "switch_session": {
            const targetTabId = cmd.tabId as string;
            const targetEntry = tabs.get(targetTabId);
            if (!targetEntry) break;
            clientActiveTab.set(ws, targetTabId);
            sendStateSync(ws, targetEntry);
            break;
          }

          case "close_tab": {
            const targetTabId = cmd.tabId as string;
            if (!tabs.has(targetTabId)) break;
            // Don't close the last tab.
            if (tabs.size <= 1) break;

            const replacementId = closeTab(targetTabId);

            // Tell everyone the tab list changed.
            broadcastTabsList(wss);

            // Any client that was viewing the closed tab must be redirected.
            for (const client of wss.clients) {
              if (
                client.readyState === WebSocket.OPEN &&
                clientActiveTab.get(client) === targetTabId
              ) {
                const fallback = replacementId
                  ? tabs.get(replacementId)
                  : tabs.get(tabOrder[0]);
                if (fallback) {
                  clientActiveTab.set(client, fallback.tabId);
                  sendStateSync(client, fallback);
                }
              }
            }
            break;
          }

          case "list_sessions": {
            // Gather all persisted sessions and filter out those already open.
            const openIds = new Set(
              Array.from(tabs.values()).map((t) => t.session.sessionId)
            );
            let allSessions: SessionInfo[] = [];
            try {
              allSessions = await SessionManager.listAll();
            } catch (err) {
              console.error("[list_sessions error]", err);
            }
            // Exclude currently-open sessions and sort newest first.
            const available = allSessions
              .filter((s) => !openIds.has(s.id))
              .sort((a, b) => b.modified.getTime() - a.modified.getTime());
            // Send only to the requesting client.
            ws.send(
              JSON.stringify({
                type: "sessions_list",
                sessions: available.map((s) => ({
                  id: s.id,
                  path: s.path,
                  name: s.name,
                  cwd: s.cwd,
                  created: s.created.toISOString(),
                  modified: s.modified.toISOString(),
                  messageCount: s.messageCount,
                  firstMessage: s.firstMessage,
                })),
              })
            );
            break;
          }

          case "open_session": {
            const sessionPath = cmd.sessionPath as string;
            if (!sessionPath) break;
            // Don't open the same session twice.
            const allSessions = await SessionManager.listAll();
            const info = allSessions.find((s) => s.path === sessionPath);
            if (!info) break;
            // Check if already open.
            const alreadyOpen = Array.from(tabs.values()).find(
              (t) => t.session.sessionId === info.id
            );
            if (alreadyOpen) {
              // Just switch to it.
              clientActiveTab.set(ws, alreadyOpen.tabId);
              sendStateSync(ws, alreadyOpen);
              break;
            }
            // Open the session as a new tab.
            const newEntry = await createTab(
              wss,
              authStorage,
              modelRegistry,
              undefined,
              sessionPath,
            );
            clientActiveTab.set(ws, newEntry.tabId);
            broadcastTabsList(wss);
            sendStateSync(ws, newEntry);
            break;
          }

          case "delete_session": {
            const sessionPath = cmd.sessionPath as string;
            if (!sessionPath) break;

            // Find the session info so we can match it to an open tab.
            let allForDelete: SessionInfo[] = [];
            try { allForDelete = await SessionManager.listAll(); } catch { /* ignore */ }
            const deleteInfo = allForDelete.find((s) => s.path === sessionPath);

            // Close the tab if this session is currently open (and not the last tab).
            if (deleteInfo) {
              const openTab = Array.from(tabs.values()).find(
                (t) => t.session.sessionId === deleteInfo.id
              );
              if (openTab && tabs.size > 1) {
                const replacementId = closeTab(openTab.tabId);
                broadcastTabsList(wss);
                for (const client of wss.clients) {
                  if (
                    client.readyState === WebSocket.OPEN &&
                    clientActiveTab.get(client) === openTab.tabId
                  ) {
                    const fallback = replacementId
                      ? tabs.get(replacementId)
                      : tabs.get(tabOrder[0]);
                    if (fallback) {
                      clientActiveTab.set(client, fallback.tabId);
                      sendStateSync(client, fallback);
                    }
                  }
                }
              }
            }

            // Delete the session file.
            try {
              await fs.promises.unlink(sessionPath);
            } catch (err) {
              console.error("[delete_session] unlink error:", err);
            }

            // Re-send the updated sessions list to the requesting client.
            const openIdsAfter = new Set(
              Array.from(tabs.values()).map((t) => t.session.sessionId)
            );
            let updatedSessions: SessionInfo[] = [];
            try { updatedSessions = await SessionManager.listAll(); } catch { /* ignore */ }
            const availableAfter = updatedSessions
              .filter((s) => !openIdsAfter.has(s.id))
              .sort((a, b) => b.modified.getTime() - a.modified.getTime());
            ws.send(
              JSON.stringify({
                type: "sessions_list",
                sessions: availableAfter.map((s) => ({
                  id: s.id,
                  path: s.path,
                  name: s.name,
                  cwd: s.cwd,
                  created: s.created.toISOString(),
                  modified: s.modified.toISOString(),
                  messageCount: s.messageCount,
                  firstMessage: s.firstMessage,
                })),
              })
            );
            break;
          }

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
      clientActiveTab.delete(ws);
      console.log(
        `[${new Date().toISOString()}] Client disconnected (${wss.clients.size} total)`
      );
    });

    ws.on("error", (err) => {
      console.error("[ws error]", err);
    });
  });

  server.listen(PORT, HOST, () => {
    console.log(`pi-remote-web-ui listening on http://${HOST}:${PORT}`);
    console.log(
      `Access via SSH tunnel: ssh -L ${PORT}:localhost:${PORT} user@your-vps`
    );
    console.log(`Then open: http://localhost:${PORT}`);
  });

  // Graceful shutdown
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      console.log(`\n${sig} received, shutting down…`);
      for (const entry of tabs.values()) {
        entry.session.dispose();
      }
      server.close();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
