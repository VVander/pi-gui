/**
 * pi-gui server
 *
 * Binds to 127.0.0.1:8080 only.  Access is via SSH port-forwarding:
 *   ssh -L 8080:localhost:8080 user@your-vps
 *
 * Each WebSocket connection spawns its own `pi --mode rpc` process and
 * bridges JSON messages between the browser and pi's stdin/stdout.
 */

import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as child_process from "child_process";
import { fileURLToPath } from "url";
import { WebSocketServer, WebSocket } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "../dist");
const PORT = 8080;
const HOST = "127.0.0.1"; // Never expose to the internet – use SSH tunnel

// ── MIME types ────────────────────────────────────────────────────────────────
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript",
  ".css":  "text/css",
  ".json": "application/json",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".ico":  "image/x-icon",
  ".woff2":"font/woff2",
  ".woff": "font/woff",
};

// ── HTTP static-file server ───────────────────────────────────────────────────
function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
  let urlPath = req.url ?? "/";

  // Strip query string
  const qIdx = urlPath.indexOf("?");
  if (qIdx !== -1) urlPath = urlPath.slice(0, qIdx);

  // Decode and normalise
  try { urlPath = decodeURIComponent(urlPath); } catch { /* ignore */ }
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
        if (e2) { res.writeHead(404); res.end("Not found"); return; }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(d2);
      });
      return;
    }
    res.writeHead(200, { "Content-Type": mime });
    res.end(data);
  });
}

// ── HTTP + WebSocket server ───────────────────────────────────────────────────
const server = http.createServer(serveStatic);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws: WebSocket) => {
  console.log(`[${new Date().toISOString()}] Client connected`);

  // Spawn a dedicated pi --mode rpc process for this connection
  const pi = child_process.spawn("pi", ["--mode", "rpc"], {
    env: process.env as NodeJS.ProcessEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let lineBuffer = "";

  pi.stdout.on("data", (chunk: Buffer) => {
    lineBuffer += chunk.toString();
    // Split on newlines, keep incomplete last line
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(trimmed);
      }
    }
  });

  pi.stderr.on("data", (chunk: Buffer) => {
    // Log pi's stderr for debugging, but don't forward to browser
    process.stderr.write(`[pi] ${chunk.toString()}`);
  });

  pi.on("exit", (code, signal) => {
    console.log(`[${new Date().toISOString()}] pi process exited (code=${code} signal=${signal})`);
    if (ws.readyState === WebSocket.OPEN) ws.close(1011, "pi process exited");
  });

  pi.on("error", (err) => {
    console.error(`[pi spawn error]`, err);
    if (ws.readyState === WebSocket.OPEN) ws.close(1011, "pi spawn failed");
  });

  // Browser → pi
  ws.on("message", (data) => {
    if (pi.stdin.writable) {
      pi.stdin.write(data.toString() + "\n");
    }
  });

  // Browser disconnected → kill pi
  ws.on("close", () => {
    console.log(`[${new Date().toISOString()}] Client disconnected`);
    if (!pi.killed) {
      pi.stdin.end();
      setTimeout(() => { if (!pi.killed) pi.kill("SIGTERM"); }, 2000);
    }
  });

  ws.on("error", (err) => {
    console.error("[ws error]", err);
    if (!pi.killed) pi.kill("SIGTERM");
  });
});

server.listen(PORT, HOST, () => {
  console.log(`pi-gui listening on http://${HOST}:${PORT}`);
  console.log(`Access via SSH tunnel: ssh -L ${PORT}:localhost:${PORT} user@your-vps`);
  console.log(`Then open: http://localhost:${PORT}`);
});
