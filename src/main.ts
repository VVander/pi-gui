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

interface TabInfo {
  tabId: string;
  name: string;
}

interface SessionBrowserItem {
  id: string;
  path: string;
  name?: string;
  cwd: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
}

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  connected: false,
  streaming: false,
  items: [] as ConversationItem[],
  dialog: null as ExtUIRequest | null,
  // Tab state
  tabs: [] as TabInfo[],
  activeTabId: null as string | null,
  // Session browser
  sessionBrowserOpen: false,
  sessionBrowserSessions: null as SessionBrowserItem[] | null, // null = loading
  sessionBrowserFilter: "",
  // Set to true only when opening a saved session; consumed by handleStateSync
  scrollToBottomOnSync: false,
  // Persisted scroll position per tab, keyed by tabId
  tabScrollPositions: {} as Record<string, number>,
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
const $overlay         = document.getElementById("dialog-overlay")!;
const $dialogBox       = document.getElementById("dialog-box")!;
const $tabBar          = document.getElementById("tab-bar")!;
const $sessionBrowserOverlay = document.getElementById("session-browser-overlay")!;
const $sessionSearch   = document.getElementById("session-search") as HTMLInputElement;
const $sessionList     = document.getElementById("session-list")!;
const $sessionBrowserClose = document.getElementById("session-browser-close")!;

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
// after a switch_session / new_session command.
function handleStateSync(data: Record<string, unknown>) {
  // Ignore stale syncs for tabs we're no longer viewing.
  const tabId = data.tabId as string | undefined;
  if (tabId && tabId !== state.activeTabId) return;

  const messages = data.messages as Array<Record<string, unknown>> | undefined;
  state.items = [];
  currentAssistantItem = null;
  state.streaming = (data.streaming as boolean) ?? false;

  if (messages) {
    for (const msg of messages) {
      if (msg.role === "user") {
        const content = msg.content;
        let text: string;
        if (typeof content === "string") {
          text = content;
        } else if (Array.isArray(content)) {
          text = (content as Array<Record<string, unknown>>)
            .filter((c) => c.type === "text")
            .map((c) => c.text as string)
            .join("\n");
        } else {
          text = String(content);
        }
        state.items.push({ kind: "user", text });
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

  if (state.scrollToBottomOnSync) {
    // Opening a saved session — jump to the bottom.
    state.scrollToBottomOnSync = false;
    requestAnimationFrame(() => { $messages.scrollTop = $messages.scrollHeight; });
  } else if (state.activeTabId && state.tabScrollPositions[state.activeTabId] !== undefined) {
    // Restore the saved scroll position for this tab.
    const saved = state.tabScrollPositions[state.activeTabId];
    requestAnimationFrame(() => { $messages.scrollTop = saved; });
  }
}

// ── RPC event handler ─────────────────────────────────────────────────────────
function handleServerEvent(event: Record<string, unknown>) {
  switch (event.type) {
    case "tabs_update": {
      state.tabs = (event.tabs as TabInfo[]) ?? [];
      // If we don't have an active tab yet, default to the first one.
      if (!state.activeTabId && state.tabs.length > 0) {
        state.activeTabId = state.tabs[0].tabId;
      }
      renderTabs();
      return;
    }

    case "state_sync": {
      // Update our active tab from the sync's tabId (server may have redirected us).
      if (event.tabId) state.activeTabId = event.tabId as string;
      handleStateSync(event);
      renderTabs(); // re-render tabs so active highlight is correct
      return;
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

    case "sessions_list": {
      state.sessionBrowserSessions = (event.sessions as SessionBrowserItem[]) ?? [];
      renderSessionBrowser();
      return;
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

// ── Tab rendering ─────────────────────────────────────────────────────────────
function renderTabs() {
  $tabBar.innerHTML = "";
  $tabBar.dataset.tabCount = String(state.tabs.length);

  // ── Find-sessions button (left of all tabs) ──────────────────────────────
  const $find = document.createElement("button");
  $find.className = "btn-find-sessions";
  $find.textContent = "⊞";
  $find.title = "Browse saved sessions";
  $find.addEventListener("click", openSessionBrowser);
  $tabBar.appendChild($find);

  // ── Individual tabs ──────────────────────────────────────────────────────
  for (const tab of state.tabs) {
    const isActive = tab.tabId === state.activeTabId;

    const $tab = document.createElement("div");
    $tab.className = "tab" + (isActive ? " active" : "");
    $tab.title = tab.name;

    const $label = document.createElement("span");
    $label.className = "tab-label";
    $label.textContent = tab.name;

    const $close = document.createElement("button");
    $close.className = "tab-close";
    $close.textContent = "✕";
    $close.title = "Close tab";
    $close.addEventListener("click", (e) => {
      e.stopPropagation();
      send({ type: "close_tab", tabId: tab.tabId });
    });

    $tab.appendChild($label);
    $tab.appendChild($close);

    // Left-click → switch to this tab
    $tab.addEventListener("click", () => {
      if (tab.tabId !== state.activeTabId) {
        // Save scroll position for the tab we're leaving.
        if (state.activeTabId) {
          state.tabScrollPositions[state.activeTabId] = $messages.scrollTop;
        }
        state.activeTabId = tab.tabId;
        send({ type: "switch_session", tabId: tab.tabId });
        renderTabs(); // optimistic active highlight while waiting for state_sync
      }
    });

    // Middle-click → close tab
    $tab.addEventListener("auxclick", (e) => {
      if ((e as MouseEvent).button === 1) {
        e.preventDefault();
        send({ type: "close_tab", tabId: tab.tabId });
      }
    });

    $tabBar.appendChild($tab);
  }

  // ── New-tab (+) button (right of all tabs) ───────────────────────────────
  const $newTab = document.createElement("button");
  $newTab.className = "btn-new-tab";
  $newTab.textContent = "+";
  $newTab.title = "New session";
  $newTab.addEventListener("click", () => {
    send({ type: "new_session" });
  });
  $tabBar.appendChild($newTab);
}

// ── Session browser ───────────────────────────────────────────────────────────
function openSessionBrowser() {
  state.sessionBrowserOpen = true;
  state.sessionBrowserSessions = null; // show loading state
  state.sessionBrowserFilter = "";
  $sessionSearch.value = "";
  $sessionBrowserOverlay.classList.remove("hidden");
  renderSessionBrowser();
  // Request the list from the server
  send({ type: "list_sessions" });
  // Focus the search box once the list arrives
  setTimeout(() => $sessionSearch.focus(), 50);
}

function closeSessionBrowser() {
  state.sessionBrowserOpen = false;
  $sessionBrowserOverlay.classList.add("hidden");
}

function renderSessionBrowser() {
  $sessionList.innerHTML = "";

  if (state.sessionBrowserSessions === null) {
    // Loading state
    const el = document.createElement("div");
    el.className = "session-list-loading";
    const spinner = document.createElement("span");
    spinner.className = "spinner";
    el.appendChild(spinner);
    el.appendChild(document.createTextNode(" Loading sessions…"));
    $sessionList.appendChild(el);
    return;
  }

  const filter = state.sessionBrowserFilter.toLowerCase().trim();
  const visible = state.sessionBrowserSessions.filter((s) => {
    if (!filter) return true;
    const name = (s.name ?? s.id).toLowerCase();
    const preview = s.firstMessage.toLowerCase();
    const cwd = s.cwd.toLowerCase();
    return name.includes(filter) || preview.includes(filter) || cwd.includes(filter);
  });

  if (visible.length === 0) {
    const el = document.createElement("div");
    el.className = "session-list-empty";
    el.textContent = state.sessionBrowserSessions.length === 0
      ? "No saved sessions found."
      : "No sessions match your filter.";
    $sessionList.appendChild(el);
    return;
  }

  for (const s of visible) {
    const $item = document.createElement("div");
    $item.className = "session-item";

    // Top row: name + delete button
    const $top = document.createElement("div");
    $top.className = "session-item-top";

    const $name = document.createElement("span");
    $name.className = "session-item-name";
    $name.textContent = s.name ?? truncateId(s.id);

    const $del = document.createElement("button");
    $del.className = "session-item-delete";
    $del.title = "Delete session";
    $del.innerHTML = "🗑";
    $del.addEventListener("click", (e) => {
      e.stopPropagation();
      if (window.confirm("Are you sure you want to delete this session?\n\n" + (s.name ?? s.id))) {
        send({ type: "delete_session", sessionPath: s.path });
        // Optimistically remove from list while server responds
        state.sessionBrowserSessions = (state.sessionBrowserSessions ?? []).filter(
          (x) => x.path !== s.path
        );
        renderSessionBrowser();
      }
    });

    $top.appendChild($name);
    $top.appendChild($del);

    // Meta row: timestamp · message count · cwd
    const $meta = document.createElement("div");
    $meta.className = "session-item-meta";
    const cwdShort = s.cwd.replace(/^.*\/([^/]+)$/, "$1") || s.cwd;
    const relDate = formatRelativeDate(new Date(s.modified));
    const msgs = `${s.messageCount} message${s.messageCount !== 1 ? "s" : ""}`;

    const $dateSpan = document.createElement("span");
    $dateSpan.textContent = relDate;
    $dateSpan.title = new Date(s.modified).toLocaleString();
    $meta.appendChild($dateSpan);
    $meta.appendChild(document.createTextNode(` · ${msgs} · ${cwdShort}`));

    // Preview: first message text
    const $preview = document.createElement("div");
    $preview.className = "session-item-preview";
    $preview.textContent = s.firstMessage || "(empty)";

    $item.appendChild($top);
    $item.appendChild($meta);
    if (s.firstMessage) $item.appendChild($preview);

    $item.addEventListener("click", () => {
      state.scrollToBottomOnSync = true;
      send({ type: "open_session", sessionPath: s.path });
      closeSessionBrowser();
    });

    $sessionList.appendChild($item);
  }
}

function truncateId(id: string): string {
  return id.length > 16 ? id.slice(0, 8) + "…" + id.slice(-4) : id;
}

function formatRelativeDate(d: Date): string {
  const diff = Date.now() - d.getTime();
  const mins  = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days  = Math.floor(diff / 86_400_000);
  if (mins  <  1) return "just now";
  if (mins  < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days  <  7) return `${days}d ago`;
  return d.toLocaleDateString();
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

// Dismiss extension UI dialog on backdrop click
$overlay.addEventListener("click", (e) => {
  if (e.target === $overlay && state.dialog) {
    send({ type: "extension_ui_response", id: state.dialog.id, cancelled: true });
    state.dialog = null;
    $overlay.classList.add("hidden");
  }
});

// Session browser: close button, backdrop click, Escape key, search input
$sessionBrowserClose.addEventListener("click", closeSessionBrowser);

$sessionBrowserOverlay.addEventListener("click", (e) => {
  if (e.target === $sessionBrowserOverlay) closeSessionBrowser();
});

$sessionSearch.addEventListener("input", () => {
  state.sessionBrowserFilter = $sessionSearch.value;
  renderSessionBrowser();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.sessionBrowserOpen) {
    closeSessionBrowser();
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────────
updateStatus();
renderMessages();
renderTabs();
connect();
