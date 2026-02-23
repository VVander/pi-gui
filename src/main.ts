import "./style.css";
import "highlight.js/styles/github-dark.css";
import { Marked } from "marked";
import { markedHighlight } from "marked-highlight";
import hljs from "highlight.js";

// ── Markdown setup ────────────────────────────────────────────────────────────
const marked = new Marked(
  markedHighlight({
    emptyLangClass: "hljs",
    langPrefix: "hljs language-",
    highlight(code, lang) {
      const language = hljs.getLanguage(lang) ? lang : "plaintext";
      return hljs.highlight(code, { language }).value;
    },
  })
);
marked.setOptions({ breaks: true, gfm: true });

// ── Types ─────────────────────────────────────────────────────────────────────
interface ThinkingBlock {
  type: "thinking";
  text: string;
  expanded: boolean;
}
interface TextBlock {
  type: "text";
  text: string;
}
interface ToolBlock {
  type: "tool";
  callId: string;
  name: string;
  args: unknown;
  output: string;
  isError: boolean;
  running: boolean;
  expanded: boolean;
}
type Block = ThinkingBlock | TextBlock | ToolBlock;

interface UserItem {
  kind: "user";
  text: string;
}
interface AssistantItem {
  kind: "assistant";
  blocks: Block[];
  streaming: boolean;
}
type ConversationItem = UserItem | AssistantItem;

interface ExtUIRequest {
  id: string;
  method: "select" | "confirm" | "input" | "editor" | "notify" | "setStatus" | "setWidget" | "setTitle" | "set_editor_text";
  title?: string;
  message?: string;
  options?: string[];
  prefill?: string;
  timeout?: number;
  notifyType?: "info" | "warning" | "error";
  statusKey?: string;
  statusText?: string;
}

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  connected: false,
  streaming: false,
  items: [] as ConversationItem[],
  dialog: null as ExtUIRequest | null,
};

let currentAssistantItem: AssistantItem | null = null;
let ws: WebSocket | null = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $messages  = document.getElementById("messages")!;
const $status    = document.getElementById("status-dot")!;
const $statusTxt = document.getElementById("status-text")!;
const $indicator = document.getElementById("streaming-indicator")!;
const $input     = document.getElementById("prompt-input") as HTMLTextAreaElement;
const $btnSend   = document.getElementById("btn-send")!;
const $btnAbort  = document.getElementById("btn-abort")!;
const $btnNew    = document.getElementById("btn-new")!;
const $overlay   = document.getElementById("dialog-overlay")!;
const $dialogBox = document.getElementById("dialog-box")!;

// Toast container (added to body)
const $toastContainer = document.createElement("div");
$toastContainer.id = "toast-container";
document.body.appendChild($toastContainer);

// ── WebSocket connection ──────────────────────────────────────────────────────
function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.onopen = () => {
    state.connected = true;
    updateStatus();
  };

  ws.onclose = () => {
    state.connected = false;
    state.streaming = false;
    currentAssistantItem = null;
    updateStatus();
    // Auto-reconnect after 3s
    setTimeout(connect, 3000);
  };

  ws.onerror = () => ws?.close();

  ws.onmessage = (e) => {
    try {
      handleServerEvent(JSON.parse(e.data as string));
    } catch {
      // ignore malformed lines
    }
  };
}

function send(cmd: object) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(cmd));
  }
}

// ── RPC event handler ─────────────────────────────────────────────────────────
function handleServerEvent(event: Record<string, unknown>) {
  switch (event.type) {
    case "agent_start": {
      state.streaming = true;
      currentAssistantItem = { kind: "assistant", blocks: [], streaming: true };
      state.items.push(currentAssistantItem);
      updateStatus();
      break;
    }

    case "message_update": {
      if (!currentAssistantItem) break;
      const delta = event.assistantMessageEvent as Record<string, unknown> | undefined;
      if (!delta) break;

      if (delta.type === "text_delta") {
        let tb = currentAssistantItem.blocks.find((b): b is TextBlock => b.type === "text");
        if (!tb) { tb = { type: "text", text: "" }; currentAssistantItem.blocks.push(tb); }
        tb.text += (delta.delta as string) ?? "";
      } else if (delta.type === "thinking_delta") {
        let kb = currentAssistantItem.blocks.find((b): b is ThinkingBlock => b.type === "thinking");
        if (!kb) { kb = { type: "thinking", text: "", expanded: false }; currentAssistantItem.blocks.push(kb); }
        kb.text += (delta.delta as string) ?? "";
      } else if (delta.type === "toolcall_end") {
        const tc = delta.toolCall as Record<string, unknown>;
        if (tc) {
          currentAssistantItem.blocks.push({
            type: "tool",
            callId: tc.id as string,
            name: tc.name as string,
            args: tc.arguments,
            output: "",
            isError: false,
            running: true,
            expanded: false,
          });
        }
      }
      break;
    }

    // Multiple turns: on a new message_start after a turn is done, create a new assistant item
    case "message_start": {
      if (currentAssistantItem && currentAssistantItem.blocks.length > 0) {
        currentAssistantItem.streaming = false;
        currentAssistantItem = { kind: "assistant", blocks: [], streaming: true };
        state.items.push(currentAssistantItem);
      } else if (!currentAssistantItem) {
        currentAssistantItem = { kind: "assistant", blocks: [], streaming: true };
        state.items.push(currentAssistantItem);
      }
      break;
    }

    case "tool_execution_update": {
      const partial = event.partialResult as Record<string, unknown> | undefined;
      const content = (partial?.content as Array<Record<string, unknown>> | undefined)?.[0];
      const text = content?.type === "text" ? (content.text as string) : "";
      if (text) findToolBlock(event.toolCallId as string, (b) => { b.output = text; });
      break;
    }

    case "tool_execution_end": {
      const result = event.result as Record<string, unknown> | undefined;
      const content = (result?.content as Array<Record<string, unknown>> | undefined)?.[0];
      const text = content?.type === "text" ? (content.text as string) : "";
      findToolBlock(event.toolCallId as string, (b) => {
        b.running = false;
        b.isError = (event.isError as boolean) ?? false;
        if (text) b.output = text;
        // Auto-expand on error
        if (b.isError) b.expanded = true;
      });
      break;
    }

    case "agent_end": {
      state.streaming = false;
      if (currentAssistantItem) { currentAssistantItem.streaming = false; }
      currentAssistantItem = null;
      updateStatus();
      break;
    }

    case "extension_ui_request": {
      const req = event as unknown as ExtUIRequest;
      if (req.method === "notify") {
        showToast(req.statusText ?? req.title ?? "", req.notifyType ?? "info");
      } else if (["select", "confirm", "input", "editor"].includes(req.method)) {
        state.dialog = req;
        renderDialog();
      }
      break;
    }

    case "extension_error": {
      showToast(`Extension error: ${event.error as string}`, "error");
      break;
    }
  }

  renderMessages();
}

// ── Helper to find a tool block across recent assistant items ─────────────────
function findToolBlock(callId: string, mutate: (b: ToolBlock) => void) {
  for (let i = state.items.length - 1; i >= 0; i--) {
    const item = state.items[i];
    if (item.kind === "assistant") {
      const block = item.blocks.find((b): b is ToolBlock => b.type === "tool" && b.callId === callId);
      if (block) { mutate(block); return; }
    }
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────────
function renderMessages() {
  $messages.innerHTML = "";

  for (const item of state.items) {
    if (item.kind === "user") {
      $messages.appendChild(renderUserMsg(item));
    } else {
      $messages.appendChild(renderAssistantMsg(item));
    }
  }

  // Streaming indicator
  $indicator.classList.toggle("hidden", !state.streaming);

  // Scroll to bottom (only if near bottom already)
  const nearBottom = $messages.scrollHeight - $messages.scrollTop - $messages.clientHeight < 200;
  if (nearBottom || state.streaming) {
    $messages.scrollTop = $messages.scrollHeight;
  }
}

function renderUserMsg(item: UserItem): HTMLElement {
  const div = document.createElement("div");
  div.className = "msg msg-user";
  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";
  bubble.textContent = item.text;
  div.appendChild(bubble);
  return div;
}

function renderAssistantMsg(item: AssistantItem): HTMLElement {
  const div = document.createElement("div");
  div.className = "msg msg-assistant";

  for (const block of item.blocks) {
    if (block.type === "thinking") {
      div.appendChild(renderThinkingBlock(block));
    } else if (block.type === "tool") {
      div.appendChild(renderToolBlock(block));
    } else if (block.type === "text") {
      div.appendChild(renderTextBlock(block));
    }
  }

  return div;
}

function renderThinkingBlock(block: ThinkingBlock): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "block-thinking" + (block.expanded ? " expanded" : "");

  const header = document.createElement("div");
  header.className = "block-header";
  header.innerHTML = `<span>💭 Thinking</span><span class="chevron">▶</span>`;
  header.addEventListener("click", () => {
    block.expanded = !block.expanded;
    renderMessages();
  });

  const content = document.createElement("div");
  content.className = "block-content";
  content.textContent = block.text;

  wrap.appendChild(header);
  wrap.appendChild(content);
  return wrap;
}

function renderToolBlock(block: ToolBlock): HTMLElement {
  const wrap = document.createElement("div");
  const statusClass = block.running ? "running" : block.isError ? "error" : "success";
  wrap.className = `block-tool ${statusClass}${block.expanded ? " expanded" : ""}`;

  // Friendly argument preview
  const argPreview = getArgPreview(block.name, block.args);

  const statusIcon = block.running ? "⟳ running…" : block.isError ? "✕ error" : "✓";
  const toolIcon = toolIcons[block.name] ?? "🔧";

  const header = document.createElement("div");
  header.className = "block-header";
  header.innerHTML = `
    <span class="tool-name">${toolIcon} ${escHtml(block.name)}</span>
    <span class="tool-arg-preview">${escHtml(argPreview)}</span>
    <span class="tool-status">${statusIcon}</span>
    <span class="chevron">${block.expanded ? "▲" : "▼"}</span>
  `;
  header.addEventListener("click", () => {
    block.expanded = !block.expanded;
    renderMessages();
  });

  const content = document.createElement("div");
  content.className = "block-content";

  if (block.args !== undefined) {
    const argsLabel = document.createElement("div");
    argsLabel.className = "tool-section-label";
    argsLabel.textContent = "Arguments";
    const argsPre = document.createElement("pre");
    argsPre.className = "tool-args-pre";
    argsPre.textContent = typeof block.args === "string"
      ? block.args
      : JSON.stringify(block.args, null, 2);
    content.appendChild(argsLabel);
    content.appendChild(argsPre);
  }

  if (block.output) {
    const outLabel = document.createElement("div");
    outLabel.className = "tool-section-label";
    outLabel.textContent = block.running ? "Output (streaming)" : "Output";
    const outPre = document.createElement("pre");
    outPre.className = "tool-output-pre" + (block.isError ? " error-output" : "");
    outPre.textContent = block.output;
    content.appendChild(outLabel);
    content.appendChild(outPre);
  }

  wrap.appendChild(header);
  wrap.appendChild(content);
  return wrap;
}

function renderTextBlock(block: TextBlock): HTMLElement {
  const div = document.createElement("div");
  div.className = "block-text";
  div.innerHTML = marked.parse(block.text) as string;
  return div;
}

// ── Dialog rendering ──────────────────────────────────────────────────────────
function renderDialog() {
  const req = state.dialog;
  if (!req) { $overlay.classList.add("hidden"); return; }

  const titleEl  = document.getElementById("dialog-title")!;
  const msgEl    = document.getElementById("dialog-message")!;
  const bodyEl   = document.getElementById("dialog-body")!;
  const actionsEl = document.getElementById("dialog-actions")!;

  titleEl.textContent  = req.title ?? "";
  msgEl.textContent    = req.message ?? "";
  bodyEl.innerHTML     = "";
  actionsEl.innerHTML  = "";

  const respond = (value: unknown) => {
    send({ type: "extension_ui_response", id: req.id, ...value });
    state.dialog = null;
    $overlay.classList.add("hidden");
  };

  if (req.method === "select") {
    for (const opt of req.options ?? []) {
      const btn = document.createElement("button");
      btn.className = "dialog-select-option";
      btn.textContent = opt;
      btn.addEventListener("click", () => respond({ value: opt }));
      bodyEl.appendChild(btn);
    }
    addCancelBtn(actionsEl, respond);

  } else if (req.method === "confirm") {
    const yes = document.createElement("button");
    yes.className = "btn btn-primary"; yes.textContent = "Yes";
    yes.addEventListener("click", () => respond({ confirmed: true }));
    const no = document.createElement("button");
    no.className = "btn btn-ghost"; no.textContent = "No";
    no.addEventListener("click", () => respond({ confirmed: false }));
    actionsEl.append(no, yes);

  } else if (req.method === "input") {
    const inp = document.createElement("input");
    inp.className = "dialog-input";
    inp.type = "text";
    bodyEl.appendChild(inp);
    setTimeout(() => inp.focus(), 50);
    const ok = document.createElement("button");
    ok.className = "btn btn-primary"; ok.textContent = "OK";
    ok.addEventListener("click", () => respond({ value: inp.value }));
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") ok.click(); });
    addCancelBtn(actionsEl, respond);
    actionsEl.appendChild(ok);

  } else if (req.method === "editor") {
    const ta = document.createElement("textarea");
    ta.className = "dialog-textarea";
    ta.value = req.prefill ?? "";
    bodyEl.appendChild(ta);
    setTimeout(() => ta.focus(), 50);
    const ok = document.createElement("button");
    ok.className = "btn btn-primary"; ok.textContent = "OK";
    ok.addEventListener("click", () => respond({ value: ta.value }));
    addCancelBtn(actionsEl, respond);
    actionsEl.appendChild(ok);
  }

  $overlay.classList.remove("hidden");
}

function addCancelBtn(container: HTMLElement, respond: (v: unknown) => void) {
  const btn = document.createElement("button");
  btn.className = "btn btn-ghost"; btn.textContent = "Cancel";
  btn.addEventListener("click", () => respond({ cancelled: true }));
  container.appendChild(btn);
}

// ── Status ────────────────────────────────────────────────────────────────────
function updateStatus() {
  $status.className = "status-dot " + (
    !state.connected ? "disconnected" :
    state.streaming  ? "streaming" : "connected"
  );
  $statusTxt.textContent = !state.connected ? "Disconnected" : state.streaming ? "Working…" : "Connected";

  $btnSend.classList.toggle("hidden", state.streaming);
  $btnAbort.classList.toggle("hidden", !state.streaming);
  $input.disabled = !state.connected;
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function showToast(msg: string, type: "info" | "warning" | "error" = "info") {
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  $toastContainer.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function escHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const toolIcons: Record<string, string> = {
  bash: "⬡", read: "📖", edit: "✏️", write: "📝",
  grep: "🔍", find: "🗂️", ls: "📁",
};

function getArgPreview(name: string, args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  if (name === "bash"  && a.command) return String(a.command).slice(0, 80);
  if (name === "read"  && a.path)    return String(a.path);
  if (name === "write" && a.path)    return String(a.path);
  if (name === "edit"  && a.path)    return String(a.path);
  if (name === "grep"  && a.pattern) return `${a.pattern} ${a.path ?? ""}`.trim();
  if (name === "find"  && a.path)    return String(a.path);
  if (name === "ls"    && a.path)    return String(a.path);
  // Fallback: first string value
  const first = Object.values(a).find((v) => typeof v === "string");
  return first ? String(first).slice(0, 80) : "";
}

// ── Input handling ────────────────────────────────────────────────────────────
function sendPrompt() {
  const text = $input.value.trim();
  if (!text || !state.connected || state.streaming) return;

  state.items.push({ kind: "user", text });
  $input.value = "";
  autoResizeInput();
  renderMessages();
  send({ type: "prompt", message: text });
}

$btnSend.addEventListener("click", sendPrompt);
$btnAbort.addEventListener("click", () => send({ type: "abort" }));
$btnNew.addEventListener("click", () => {
  // Start a fresh pi session by closing + reopening WebSocket
  if (ws) { ws.onclose = null; ws.close(); }
  state.items = [];
  state.streaming = false;
  currentAssistantItem = null;
  renderMessages();
  connect();
});

$input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendPrompt();
  }
});
$input.addEventListener("input", autoResizeInput);

function autoResizeInput() {
  $input.style.height = "auto";
  $input.style.height = Math.min($input.scrollHeight, 200) + "px";
}

// Dismiss dialog overlay on backdrop click
$overlay.addEventListener("click", (e) => {
  if (e.target === $overlay && state.dialog) {
    send({ type: "extension_ui_response", id: state.dialog.id, cancelled: true });
    state.dialog = null;
    $overlay.classList.add("hidden");
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────────
updateStatus();
renderMessages();
connect();
