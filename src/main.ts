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

interface AttachedImage {
  data: string; // base64 (no data: prefix)
  mimeType: string;
}
interface UserItem {
  kind: "user";
  text: string;
  images?: AttachedImage[];
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
  pendingImages: [] as AttachedImage[],
};

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ALLOWED_IMAGE_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

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
const $btnAttach = document.getElementById("btn-attach")!;
const $fileInput = document.getElementById("file-input") as HTMLInputElement;
const $attachStrip = document.getElementById("attachment-strip")!;
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

// ── State sync handler ────────────────────────────────────────────────────────
// Rebuilds the conversation from the full message array sent on connect or
// after a new_session command.
function handleStateSync(data: Record<string, unknown>) {
  const messages = data.messages as Array<Record<string, unknown>> | undefined;
  state.items = [];
  currentAssistantItem = null;
  state.streaming = (data.streaming as boolean) ?? false;

  if (messages) {
    for (const msg of messages) {
      if (msg.role === "user") {
        const content = msg.content;
        let text: string;
        const images: AttachedImage[] = [];
        if (typeof content === "string") {
          text = content;
        } else if (Array.isArray(content)) {
          const arr = content as Array<Record<string, unknown>>;
          text = arr
            .filter((c) => c.type === "text")
            .map((c) => c.text as string)
            .join("\n");
          for (const c of arr) {
            if (c.type === "image" && typeof c.data === "string" && typeof c.mimeType === "string") {
              images.push({ data: c.data, mimeType: c.mimeType });
            }
          }
        } else {
          text = String(content);
        }
        const item: UserItem = { kind: "user", text };
        if (images.length > 0) item.images = images;
        state.items.push(item);
      } else if (msg.role === "assistant") {
        const contentArr = msg.content as Array<Record<string, unknown>> | undefined;
        const blocks: Block[] = [];
        if (contentArr) {
          for (const c of contentArr) {
            if (c.type === "text") {
              blocks.push({ type: "text", text: c.text as string });
            } else if (c.type === "thinking") {
              blocks.push({ type: "thinking", text: c.thinking as string, expanded: false });
            } else if (c.type === "toolCall") {
              blocks.push({
                type: "tool",
                callId: c.id as string,
                name: c.name as string,
                args: c.arguments,
                output: "",
                isError: false,
                running: false,
                expanded: false,
              });
            }
          }
        }
        state.items.push({ kind: "assistant", blocks, streaming: false });
      } else if (msg.role === "toolResult") {
        // Attach tool output to the matching tool block
        const callId = msg.toolCallId as string;
        const content = (msg.content as Array<Record<string, unknown>> | undefined)?.[0];
        const text = content?.type === "text" ? (content.text as string) : "";
        findToolBlock(callId, (b) => {
          b.output = text;
          b.running = false;
          b.isError = (msg.isError as boolean) ?? false;
          if (b.isError) b.expanded = true;
        });
      }
    }
  }

  renderMessages();
  updateStatus();
}

// ── RPC event handler ─────────────────────────────────────────────────────────
function handleServerEvent(event: Record<string, unknown>) {
  switch (event.type) {
    case "state_sync": {
      handleStateSync(event);
      return; // already rendered
    }

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
  if (item.images && item.images.length > 0) {
    const imgs = document.createElement("div");
    imgs.className = "msg-bubble-images";
    for (const img of item.images) {
      const el = document.createElement("img");
      el.src = `data:${img.mimeType};base64,${img.data}`;
      el.alt = "attachment";
      imgs.appendChild(el);
    }
    bubble.appendChild(imgs);
  }
  if (item.text) {
    const txt = document.createElement("div");
    txt.textContent = item.text;
    bubble.appendChild(txt);
  } else if (!item.images || item.images.length === 0) {
    bubble.textContent = item.text;
  }
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
  const images = state.pendingImages;
  if (!state.connected || state.streaming) return;
  if (!text && images.length === 0) return;

  const item: UserItem = { kind: "user", text };
  if (images.length > 0) item.images = images.slice();
  state.items.push(item);
  $input.value = "";
  state.pendingImages = [];
  autoResizeInput();
  renderAttachmentStrip();
  renderMessages();
  const payload: Record<string, unknown> = { type: "prompt", message: text };
  if (images.length > 0) payload.images = images;
  send(payload);
}

$btnSend.addEventListener("click", sendPrompt);
$btnAbort.addEventListener("click", () => send({ type: "abort" }));
$btnNew.addEventListener("click", () => {
  // Ask the server to start a new session (shared across all tabs).
  // The server will broadcast a state_sync event to every connected client.
  send({ type: "new_session" });
});

// ── Attachments ───────────────────────────────────────────────────────────────
$btnAttach.addEventListener("click", () => $fileInput.click());
$fileInput.addEventListener("change", async () => {
  const files = Array.from($fileInput.files ?? []);
  $fileInput.value = ""; // reset so re-picking the same file fires change
  for (const file of files) {
    if (!ALLOWED_IMAGE_MIME.has(file.type)) {
      showToast(`Unsupported file type: ${file.type || "unknown"}`, "warning");
      continue;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      showToast(`Image too large: ${file.name} (${Math.round(file.size / 1024 / 1024)}MB, max 10MB)`, "warning");
      continue;
    }
    try {
      const data = await fileToBase64(file);
      state.pendingImages.push({ data, mimeType: file.type });
    } catch (err) {
      showToast(`Failed to read ${file.name}`, "error");
      console.error("[attach error]", err);
    }
  }
  renderAttachmentStrip();
});

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function renderAttachmentStrip() {
  $attachStrip.innerHTML = "";
  if (state.pendingImages.length === 0) {
    $attachStrip.classList.add("hidden");
    return;
  }
  $attachStrip.classList.remove("hidden");
  state.pendingImages.forEach((img, idx) => {
    const chip = document.createElement("div");
    chip.className = "attachment-chip";
    const el = document.createElement("img");
    el.src = `data:${img.mimeType};base64,${img.data}`;
    el.alt = "attachment preview";
    chip.appendChild(el);
    const rm = document.createElement("button");
    rm.className = "remove";
    rm.type = "button";
    rm.textContent = "×";
    rm.title = "Remove";
    rm.addEventListener("click", () => {
      state.pendingImages.splice(idx, 1);
      renderAttachmentStrip();
    });
    chip.appendChild(rm);
    $attachStrip.appendChild(chip);
  });
}

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
