import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { AppConfig, Session } from "../terminal";
import { primaryModifierHeld, shortcutLabel } from "../platform";
import { createProtocol, type ChatAgent } from "./beckwell";
import type { ChatHost, ChatProtocol, Item, PermissionDecision, PermissionItem, QuestionItem } from "./beckwell/types";
import { isExternalLink, LINK_ATTRIBUTE, renderMarkdown } from "./beckwell/markdown";
import { handleCopyClick } from "./beckwell/copy";
import { chatPrompt, pasteCommand, terminalInputText } from "./context";
import { initChatTooltips } from "./tooltips";
import { canDispatch, createQueued, mergeUp, rowsFor, takeNext, type QueuedMessage } from "./queue";
import { shouldFollowBottom, type ScrollMetrics } from "./scroll";

export interface AgentChatConfig {
  enabled: boolean;
  provider: ChatAgent;
  context_turns: number;
  blacklist: string[];
  auto_paste: boolean;
}
interface Conversation {
  session: Session;
  provider: ChatAgent;
  cwd: string;
  items: Item[];
  process: number | null;
  protocol: ChatProtocol | null;
  agentSessionId: string | null;
  ready: boolean;
  busy: boolean;
  starting: boolean;
  stopped: boolean;
  draft: string;
  usage: string;
  revision: number | null;
  interrupted: boolean;
  command: string | null;
  turns: number;
  autoPaste: boolean;
  followDirectory: boolean;
  // Messages sent while busy, dispatched in order when the agent is idle.
  queue: QueuedMessage[];
  // Set by Stop and New chat so the queue does not start on its own.
  queueHeld: boolean;
  // The turn started by the last dispatch, until its result arrives. Protocols report
  // a turn that never started (failed write, rejected turn/start) only by going idle
  // without a result, so the idle callback checks this.
  inFlight: InFlight | null;
}
interface InFlight { started: boolean; fail(error?: unknown): void }
const conversations = new Map<number, Conversation>();
let config: AppConfig;
let currentSession: () => Session | undefined;
let pane: HTMLElement;
let toggle: HTMLButtonElement;
let log: HTMLElement;
let status: HTMLElement;
let preview: HTMLPreElement;
let contextLabel: HTMLElement;
let input: HTMLTextAreaElement;
let send: HTMLButtonElement;
let stop: HTMLButtonElement;
let provider: HTMLSelectElement;
let turns: HTMLInputElement;
let autoPaste: HTMLInputElement;
let cwd: HTMLInputElement;
let followDirectory: HTMLInputElement;
let followLabel: HTMLLabelElement;
let queueBox: HTMLElement;
let queueCount: HTMLElement;
let queueState: HTMLElement;
let queueResume: HTMLButtonElement;
let queueList: HTMLElement;
let queueRendered: Conversation | undefined;
const queueRows = new Map<number, { node: HTMLElement; index: HTMLElement; text: HTMLTextAreaElement; merge: HTMLButtonElement }>();
let visible = false;
let resizing = false;
let generation = 0;
let nextId = 0;
let rendered: Conversation | undefined;
// Whether new output scrolls the log to the end (scroll.ts). Stops when the user scrolls up and resumes
// at the bottom. The position is recorded on every scroll so the decision uses the position before new
// items were appended (measuring after would make the reader look further from the end).
let followBottom = true;
let lastScroll: ScrollMetrics = { scrollTop: 0, scrollHeight: 0, clientHeight: 0 };
function readScroll(): ScrollMetrics {
  return { scrollTop: log.scrollTop, scrollHeight: log.scrollHeight, clientHeight: log.clientHeight };
}
let scheduled = false;
const rows = new Map<Item, { node: HTMLElement; signature: string }>();

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}
function button(text: string, name: string, onClick: () => void): HTMLButtonElement {
  const node = el("button", "chat-button", text);
  node.type = "button";
  node.dataset.annotate = name;
  node.addEventListener("click", onClick);
  return node;
}
function icon(name: string): HTMLElement {
  const node = el("span", `codicon codicon-${name}`);
  node.setAttribute("aria-hidden", "true");
  return node;
}
function iconButton(label: string, glyph: string, name: string, onClick: () => void): HTMLButtonElement {
  const node = button("", name, onClick);
  node.classList.add("chat-icon-button");
  node.title = label;
  node.setAttribute("aria-label", label);
  node.append(icon(glyph));
  return node;
}
function active(): Conversation | undefined { const session = currentSession?.(); return session && conversations.get(session.id); }
function note(c: Conversation, text: string, error = false): void {
  c.items.push({ kind: "note", text, level: error ? "error" : "info" });
  scheduleRender();
}
function scheduleRender(): void {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => { scheduled = false; render(); });
}

export async function initAgentChat(appConfig: AppConfig, getSession: () => Session | undefined): Promise<void> {
  if (!appConfig.agent_chat.enabled) return;
  config = appConfig;
  currentSession = getSession;
  pane = document.getElementById("agent-chat")!;
  toggle = document.getElementById("chat-toggle") as HTMLButtonElement;
  toggle.replaceChildren(icon("comment-discussion"));
  toggle.setAttribute("aria-label", "Toggle agent chat");
  toggle.title = "Open agent chat";
  toggle.hidden = false;
  toggle.addEventListener("click", () => { void setVisible(!visible); });
  const header = el("header", "chat-header");
  const title = el("div", "chat-heading");
  title.setAttribute("data-tauri-drag-region", "");
  const contextRow = el("div", "chat-context-row");
  provider = el("select", "chat-select");
  provider.setAttribute("aria-label", "Agent provider");
  provider.dataset.annotate = "chat-provider";
  for (const [value, text] of [["claude", "Claude Code"], ["codex", "Codex"]]) {
    const option = el("option", "", text); option.value = value; provider.append(option);
  }
  provider.addEventListener("change", () => { const c = active(); if (c) { c.provider = provider.value as ChatAgent; c.followDirectory = false; void restart(c); } });
  const turnsLabel = el("label", "chat-control");
  turnsLabel.title = "Terminal turns to share (0–20; 0 disables sharing)";
  turnsLabel.append(icon("history"));
  turns = el("input", "chat-turns"); turns.type = "number"; turns.min = "0"; turns.max = "20";
  turns.setAttribute("aria-label", "Turns");
  turns.dataset.annotate = "chat-turns";
  turns.addEventListener("change", () => {
    const c = active(); if (!c) return;
    c.turns = Math.max(0, Math.min(20, Math.floor(Number(turns.value) || 0))); turns.value = String(c.turns); renderContext(c);
  });
  turnsLabel.append(turns);
  const dragSpace = el("div", "chat-drag-space");
  dragSpace.setAttribute("data-tauri-drag-region", "");
  const newChat = iconButton("New chat", "add", "chat-restart", () => { const c = active(); if (c) void restart(c); });
  const close = iconButton("Close chat", "close", "chat-close", () => { void setVisible(false); });
  title.append(provider, dragSpace, newChat, close);
  const location = el("div", "chat-directory");
  cwd = el("input", ""); cwd.dataset.annotate = "chat-directory";
  cwd.setAttribute("aria-label", "Agent working directory");
  cwd.spellcheck = false;
  cwd.addEventListener("change", () => { const c = active(); if (c && cwd.value !== c.cwd) { c.cwd = cwd.value; void restart(c); } });
  followDirectory = el("input", "");
  followDirectory.type = "checkbox";
  followDirectory.setAttribute("role", "switch");
  followDirectory.setAttribute("aria-label", "Follow terminal directory");
  followDirectory.dataset.annotate = "chat-follow-directory";
  followDirectory.addEventListener("change", () => {
    const c = active();
    if (!c) return;
    c.followDirectory = followDirectory.checked && !!c.protocol?.supportsWorkingDirectory;
    syncDirectory(c);
    render();
  });
  followLabel = el("label", "chat-follow chat-switch");
  followLabel.append(followDirectory, icon("link"));
  location.append(cwd, followLabel);
  const sharing = el("details", "chat-context");
  contextLabel = el("summary", "", "Terminal context"); contextLabel.dataset.annotate = "chat-context-preview";
  preview = el("pre", ""); sharing.append(contextLabel, preview);
  log = el("div", "chat-log"); log.setAttribute("aria-label", "Agent conversation");
  log.addEventListener("scroll", () => {
    const metrics = readScroll();
    followBottom = shouldFollowBottom(followBottom, lastScroll, metrics);
    lastScroll = metrics;
  }, { passive: true });
  log.addEventListener("click", (event) => {
    if (handleCopyClick(event)) return;
    const link = (event.target as Element).closest(`[${LINK_ATTRIBUTE}]`);
    const href = link?.getAttribute(LINK_ATTRIBUTE);
    if (href && isExternalLink(href)) { event.preventDefault(); void openUrl(href).catch((e) => { const c = active(); if (c) note(c, String(e), true); }); }
  });
  status = el("div", "chat-status"); status.setAttribute("role", "status");
  const form = el("form", "chat-composer");
  queueBox = el("div", "chat-queue"); queueBox.dataset.annotate = "chat-queue"; queueBox.hidden = true;
  const queueHeader = el("div", "chat-queue-header");
  queueCount = el("span", "chat-queue-count");
  queueState = el("span", "chat-queue-state");
  queueResume = button("Resume", "chat-queue-resume", () => { const c = active(); if (c) { c.queueHeld = false; pump(c); render(); } });
  queueResume.title = "Send the queued messages in order when the agent is idle";
  queueHeader.append(queueCount, queueState, queueResume);
  queueList = el("div", "chat-queue-list"); queueList.setAttribute("aria-label", "Queued messages");
  queueBox.append(queueHeader, queueList);
  input = el("textarea", "chat-input"); input.placeholder = "Ask about this terminal…"; input.rows = 3;
  input.setAttribute("aria-label", "Message to agent"); input.dataset.annotate = "chat-input";
  input.addEventListener("input", () => { const c = active(); if (c) c.draft = input.value; });
  let composing = false;
  input.addEventListener("compositionstart", () => { composing = true; });
  input.addEventListener("compositionend", () => { composing = false; });
  input.addEventListener("keydown", (e) => {
    // WebKit は変換確定時に isComposing が false でも keyCode 229 を返す。
    if (composing || e.isComposing || e.keyCode === 229 || e.repeat) return;
    if (e.key !== "Enter" || !primaryModifierHeld(e) || e.shiftKey || e.altKey) return;
    e.preventDefault();
    void submit();
  });
  send = iconButton("Send", "send", "chat-send", () => { void submit(); });
  send.title = shortcutLabel("Send (⌘Enter)", "Send (Ctrl+Enter)");
  stop = iconButton("Stop", "debug-stop", "chat-stop", () => { const c = active(); if (c) void interrupt(c); });
  autoPaste = el("input", ""); autoPaste.type = "checkbox"; autoPaste.dataset.annotate = "chat-auto-paste";
  autoPaste.addEventListener("change", () => { const c = active(); if (c) c.autoPaste = autoPaste.checked; });
  autoPaste.setAttribute("aria-label", "Auto-paste");
  autoPaste.setAttribute("role", "switch");
  const pasteLabel = el("label", "chat-control chat-switch"); pasteLabel.append(autoPaste, icon("terminal"));
  pasteLabel.title = "Auto-paste: paste a suggested command only into an unchanged, empty shell prompt. Never press Enter.";
  const controls = el("div", "chat-toolbar"); controls.append(pasteLabel, status, stop, send);
  form.append(queueBox, input, controls); form.addEventListener("submit", (e) => { e.preventDefault(); void submit(); });
  contextRow.append(sharing, turnsLabel);
  header.append(title, location, contextRow);
  pane.append(header, log, form);
  initChatTooltips([pane, toggle]);
  // Chat's text editing shortcuts must not resize, clear, or close terminal tabs.
  pane.addEventListener("keydown", (e) => e.stopPropagation());
  const reset = await invoke<{ highestId: number; generation: number }>("agent_reset");
  nextId = reset.highestId; generation = reset.generation;
  const win = getCurrentWebviewWindow();
  await win.listen<{ id: number; line: string }>("agent_event", ({ payload }) => {
    const c = byProcess(payload.id); if (!c) return;
    try { c.protocol?.handleMessage(JSON.parse(payload.line)); } catch (e) { note(c, `Invalid agent message: ${String(e)}`, true); }
    scheduleRender();
  });
  await win.listen<{ id: number; line: string }>("agent_stderr", ({ payload }) => { const c = byProcess(payload.id); if (c) note(c, payload.line, true); });
  await win.listen<{ id: number; code: number | null }>("agent_exit", ({ payload }) => {
    const c = byProcess(payload.id); if (!c) return;
    c.ready = false; c.busy = false; c.stopped = true; c.inFlight = null;
    note(c, `Agent exited (${payload.code ?? "unknown status"}). Use New chat to reconnect.`, true);
  });
  setInterval(() => {
    const c = active();
    if (!visible || !c) return;
    syncDirectory(c);
    renderDirectory(c);
    renderContext(c);
  }, 500);
}
function byProcess(id: number): Conversation | undefined { return [...conversations.values()].find((c) => c.process === id); }

async function setVisible(open: boolean): Promise<void> {
  if (resizing) return;
  resizing = true;
  try {
    await invoke("set_chat_open", { open });
    visible = open; pane.hidden = !open;
    document.getElementById("workspace")!.classList.toggle("chat-open", open);
    toggle.setAttribute("aria-expanded", String(open));
    toggle.title = open ? "Close agent chat" : "Open agent chat";
    if (open) { syncAgentChat(); input.focus(); }
    window.dispatchEvent(new Event("resize"));
  } catch (e) { toggle.title = `Could not resize the chat pane: ${String(e)}`; }
  finally { resizing = false; }
}

export function syncAgentChat(): void {
  if (!visible || !config) return;
  const session = currentSession();
  if (session && !conversations.has(session.id)) {
    const c: Conversation = {
      session, provider: config.agent_chat.provider, cwd: session.context.workingDirectory ?? config.home_directory,
      items: [], process: null, protocol: null, agentSessionId: null, ready: false, busy: false, starting: false, stopped: false,
      draft: "", usage: "", revision: null, interrupted: false, command: null,
      turns: Math.max(0, Math.min(20, config.agent_chat.context_turns)), autoPaste: config.agent_chat.auto_paste, followDirectory: false,
      queue: [], queueHeld: false, inFlight: null,
    };
    conversations.set(session.id, c); void start(c);
  }
  render();
}
export function closeAgentChat(session: Session): void {
  const c = conversations.get(session.id); if (!c) return;
  conversations.delete(session.id); c.stopped = true;
  if (c.process !== null) void invoke("agent_stop", { id: c.process }).catch(console.error);
  scheduleRender();
}
async function restart(c: Conversation, resume: string | null = null): Promise<void> {
  if (c.starting) return;
  c.starting = true; c.queueHeld = true; scheduleRender();
  c.stopped = true; c.ready = false; c.busy = false; c.command = null; c.revision = null; c.inFlight = null;
  const old = c.process; c.process = null;
  if (old !== null) {
    try { await invoke("agent_stop", { id: old }); } catch (e) { c.starting = false; note(c, String(e), true); return; }
  }
  if (!resume) { c.items = []; c.usage = ""; c.agentSessionId = null; }
  rendered = undefined; c.stopped = false;
  await start(c, resume);
}
async function start(c: Conversation, resume: string | null = null): Promise<void> {
  c.starting = true; c.ready = false;
  const id = ++nextId; c.process = id;
  const live = () => c.process === id && !c.stopped && conversations.has(c.session.id);
  const host: ChatHost = {
    get items() { return c.items; },
    push(item) { if (!live()) return; c.items.push(item); if (item.kind === "result") c.inFlight = null; if (item.kind === "result" && /^(success|completed)\b/.test(item.summary)) queueMicrotask(() => { if (live()) complete(c, item.finalText); }); scheduleRender(); },
    note(text, level) { if (!live()) return; note(c, text, level === "error"); },
    scrollToBottom: scheduleRender,
    async write(payload) {
      if (!live()) return false;
      try { await invoke("agent_write", { id, line: JSON.stringify(payload) }); return live(); }
      catch (e) { if (live()) { c.ready = false; c.busy = false; note(c, String(e), true); } return false; }
    },
    setBusy(busy) { if (!live()) return; c.busy = busy; if (!busy) afterIdle(c); scheduleRender(); },
    turnStarted() { if (live() && c.inFlight) c.inFlight.started = true; },
    setReady(ready) { if (!live()) return; c.ready = ready; if (ready) afterIdle(c); scheduleRender(); },
    setSession(session) { if (!live()) return; c.agentSessionId = session?.sessionId || null; if (session) note(c, `${session.model} · ${session.detail}`); },
    setUsage(usage) { if (!live()) return; c.usage = usage ?? ""; scheduleRender(); },
    setWorkingDirectory(value) { if (!live()) return; c.cwd = value; scheduleRender(); },
    setCommands() {}, setModels() {},
    clear() { if (!live()) return; c.items = []; rendered = undefined; scheduleRender(); },
    restart(message) { if (!live()) return; note(c, message); void restart(c, c.agentSessionId); },
    interruptFailed(message) { if (!live()) return; note(c, message, true); },
  };
  c.protocol = createProtocol(c.provider, host, { resume, replayHistory: false, async readClaudeSessions() { return ""; } });
  try {
    await invoke("agent_start", { id, generation, agent: c.provider, cwd: c.cwd });
    if (c.stopped || !conversations.has(c.session.id)) { await invoke("agent_stop", { id }); return; }
    c.protocol.start();
  } catch (e) { note(c, `${String(e)}. Install and sign in to ${c.provider === "claude" ? "Claude Code" : "Codex"}, then choose New chat.`, true); }
  finally { c.starting = false; scheduleRender(); }
}

async function submit(): Promise<void> {
  const c = active(); if (!c || !input.value.trim()) return;
  const request = input.value.trim();
  // While the agent is answering (or starting), queue instead of sending. Also queue
  // behind messages still waiting so a new message never overtakes them.
  if (c.busy || (c.starting && !c.stopped) || (c.queue.length > 0 && !c.queueHeld)) {
    if (!c.queue.length) c.queueHeld = false;
    c.queue.push(createQueued(request));
    c.draft = ""; input.value = "";
    pump(c);
    render();
    return;
  }
  if (!c.ready) return;
  const sending = dispatch(c, request);
  if (!sending) { render(); return; }
  // Clear and resume before awaiting: the user may type the next message, switch
  // tabs, or press Stop while the request is being written.
  c.draft = ""; input.value = "";
  c.queueHeld = false;
  render();
  await sending;
}
// Starts one message as a new turn. Returns null if it could not be started.
// `onFailed` runs only if the write fails for the same agent process.
function dispatch(c: Conversation, request: string, onFailed?: () => void): Promise<void> | null {
  if (!c.ready || c.busy || !c.protocol) return null;
  syncDirectory(c);
  if (c.followDirectory && (!c.session.context.workingDirectory || c.session.exited)) {
    note(c, "Waiting for a local terminal directory. Turn off Follow to use a fixed directory.", true);
    return null;
  }
  const protocol = c.protocol;
  const process = c.process;
  const context = c.session.context.snapshot(c.turns, config.agent_chat.blacklist);
  c.revision = c.session.context.revision; c.command = null; c.interrupted = false;
  c.items.push({ kind: "user", text: request });
  // The user just sent this: show it and the answer even if they had scrolled up
  if (c === rendered) followBottom = true;
  note(c, `Shared ${context.turns.length} completed turns; ${context.excluded} excluded.`);
  c.busy = true;
  scheduleRender();
  // A failed turn holds the rest of the queue: later instructions usually depend on
  // it. Only a message the agent never accepted goes back to the queue (onFailed);
  // one that started may already have run commands and must not be resent.
  const record: InFlight = {
    started: false,
    fail(error?: unknown) {
      if (c.inFlight !== record || c.stopped || c.protocol !== protocol || c.process !== process) return;
      c.inFlight = null; c.busy = false; c.queueHeld = true;
      if (error !== undefined) note(c, String(error), true);
      if (!record.started) onFailed?.();
      scheduleRender();
    },
  };
  c.inFlight = record;
  return protocol.send(chatPrompt(request, context), protocol.supportsWorkingDirectory ? { cwd: c.cwd } : undefined)
    .then(() => {}, (e) => record.fail(e));
}
// A macrotask, not a microtask: Claude reports idle before it pushes the result, and
// the result's writeback (`complete`) runs in a microtask that must finish before the
// next queued message resets the turn's revision.
function afterIdle(c: Conversation): void {
  const record = c.inFlight;
  if (!record && !c.queue.length) return;
  setTimeout(() => {
    // Idle without a result: the turn was rejected, could not be written, or failed
    // (e.g. a Codex error notification). `fail` re-queues only the first two.
    if (record && c.inFlight === record && !c.busy) record.fail();
    pump(c);
  }, 0);
}
function pump(c: Conversation): void {
  if (!conversations.has(c.session.id)) return;
  if (!canDispatch({ queued: c.queue.length, held: c.queueHeld, busy: c.busy, ready: c.ready, running: c.process !== null && !c.stopped, starting: c.starting })) return;
  const request = takeNext(c.queue);
  scheduleRender();
  if (request === null) return;
  // Keep a message that was not sent and wait for Resume instead of retrying in a loop.
  const restore = () => { c.queue.unshift(createQueued(request)); c.queueHeld = true; scheduleRender(); };
  if (!dispatch(c, request, restore)) restore();
}
async function interrupt(c: Conversation): Promise<void> {
  const protocol = c.protocol;
  const process = c.process;
  const live = () => !c.stopped && c.protocol === protocol && c.process === process;
  if (!protocol || !live()) return;
  c.interrupted = true; c.command = null; c.revision = null;
  // Stop is usually pressed to change direction; do not let queued messages start by themselves.
  c.queueHeld = true;
  for (const item of c.items) {
    if (!live()) return;
    if (item.kind === "permission" && !item.decision) await respondPermission(c, item, "deny");
    if (item.kind === "question" && !item.decision) await answerQuestion(c, item, null);
  }
  if (!live()) return;
  const interrupted = await protocol.interrupt();
  if (!live()) return;
  if (!interrupted) note(c, "Could not interrupt the agent. Use New chat to stop its process.", true);
  scheduleRender();
}
async function respondPermission(c: Conversation, item: PermissionItem, decision: PermissionDecision): Promise<void> {
  if (c.stopped || !c.protocol || !c.items.includes(item) || item.decision) return;
  item.decision = decision;
  scheduleRender();
  await c.protocol.respondPermission(item, decision);
  scheduleRender();
}
async function answerQuestion(c: Conversation, item: QuestionItem, answers: Record<string, string> | null): Promise<void> {
  if (c.stopped || !c.protocol?.answerQuestion || !c.items.includes(item) || item.decision) return;
  item.decision = answers ? "answered" : "declined";
  item.answers = answers ?? {};
  scheduleRender();
  await c.protocol.answerQuestion(item, answers);
  scheduleRender();
}
function complete(c: Conversation, finalText?: string): void {
  if (c.interrupted || c.stopped || c.revision === null) return;
  c.command = pasteCommand(finalText ?? "");
  if (c.command && c.autoPaste && visible && active() === c) paste(c);
  scheduleRender();
}
function paste(c: Conversation): void {
  const { session } = c;
  if (!c.command) return;
  if (!visible || active() !== c || session.exited || session.terminal.buffer.active.type !== "normal"
      || !session.context.atPrompt || session.context.dirty || session.context.revision !== c.revision) {
    c.command = null; c.revision = null;
    note(c, "Auto-paste skipped because the terminal changed. Use the code block's Insert into terminal button when ready.");
    return;
  }
  const command = c.command; c.command = null; c.revision = null;
  session.userInteracted = true;
  session.context.input();
  session.terminal.paste(command);
  note(c, "Command pasted into the terminal. Review it and press Enter to run.");
}

function insertCode(c: Conversation, text: string): void {
  const { session } = c;
  if (!visible || active() !== c || session.exited || session.terminal.buffer.active.type !== "normal") {
    note(c, "Return to this terminal's normal screen before inserting code.", true);
    return;
  }
  const bracketed = session.terminal.modes.bracketedPasteMode && !session.terminal.options.ignoreBracketedPasteMode;
  const result = terminalInputText(text, bracketed);
  if (result.error) { note(c, result.error, true); return; }
  if (!result.text) return;
  c.command = null; c.revision = null;
  session.userInteracted = true;
  session.context.input();
  session.terminal.paste(result.text);
  session.terminal.focus();
}

// Only update the next turn. A running agent keeps the directory it started with.
function syncDirectory(c: Conversation): void {
  if (!c.followDirectory || !c.protocol?.supportsWorkingDirectory || c.busy || c.starting || c.session.exited) return;
  const directory = c.session.context.workingDirectory;
  if (directory && directory !== c.cwd) {
    c.cwd = directory;
    c.command = null;
    c.revision = null;
  }
}

function renderDirectory(c: Conversation): void {
  const supported = !!c.protocol?.supportsWorkingDirectory;
  followDirectory.disabled = !supported || c.starting;
  followDirectory.checked = c.followDirectory;
  followLabel.title = !supported
    ? "Directory following is available with Codex. Claude Code uses a fixed directory."
    : !c.session.context.workingDirectory
      ? "Waiting for a local terminal directory."
      : "Follow this terminal's directory for the next message, keeping the conversation. Running work is not moved.";
  cwd.disabled = c.starting || c.followDirectory;
  if (document.activeElement !== cwd || c.followDirectory) cwd.value = c.cwd;
  cwd.title = c.followDirectory ? `${c.cwd} — follows terminal on the next message` : c.cwd;
}

function renderContext(c: Conversation): void {
  const context = c.session.context.snapshot(c.turns, config.agent_chat.blacklist);
  contextLabel.textContent = c.turns === 0 ? "Sharing off" : !context.available ? "No shell context" : `${context.turns.length} shared · ${context.excluded} excluded`;
  preview.textContent = context.turns.length ? context.turns.join("\n\n──── next turn ────\n\n") : "No completed terminal turns will be sent.";
}
function render(): void {
  if (!pane || !visible) return;
  const c = active();
  if (rendered !== c) {
    rendered = c; rows.clear(); log.replaceChildren(); input.value = c?.draft ?? ""; followBottom = true;
    if (c) { provider.value = c.provider; turns.value = String(c.turns); autoPaste.checked = c.autoPaste; cwd.value = c.cwd; }
  }
  const queueing = !!c && (c.busy || (c.starting && !c.stopped) || (c.queue.length > 0 && !c.queueHeld));
  send.disabled = !c || (!c.ready && !queueing);
  const sendLabel = queueing ? shortcutLabel("Queue (⌘Enter) — sent when the agent is idle", "Queue (Ctrl+Enter) — sent when the agent is idle") : shortcutLabel("Send (⌘Enter)", "Send (Ctrl+Enter)");
  // Only touch the title when it changes; the tooltip helper observes title mutations.
  if (send.getAttribute("aria-label") !== (queueing ? "Queue" : "Send")) {
    send.title = sendLabel; send.setAttribute("aria-label", queueing ? "Queue" : "Send");
    input.placeholder = queueing ? "Queue a message for when the agent is idle…" : "Ask about this terminal…";
  }
  renderQueue(c);
  stop.disabled = !c?.busy;
  provider.disabled = !c || c.starting;
  cwd.disabled = !c || c.starting || c.followDirectory;
  followDirectory.disabled = !c || c.starting || !c.protocol?.supportsWorkingDirectory;
  input.disabled = !c;
  if (!c) { status.textContent = "Open a terminal tab to start a chat."; return; }
  syncDirectory(c);
  renderDirectory(c);
  renderContext(c);
  status.textContent = `${c.starting ? "Starting agent…" : c.busy ? "Working…" : c.ready ? "Ready" : "Disconnected"}${c.usage ? ` · ${c.usage}` : ""}`;
  const follow = followBottom;
  for (const item of c.items) {
    let row = rows.get(item);
    if (!row) { const node = el("article", `chat-item chat-${item.kind}`); log.append(node); row = { node, signature: "" }; rows.set(item, row); }
    // Thinking is shown only as an animated indicator, so its text deltas must not re-render it
    // (re-rendering restarts the animation on every delta).
    const signature = item.kind === "thinking" ? `thinking:${thinkingActive(c, item)}` : JSON.stringify(item);
    if (row.signature === signature) continue;
    row.signature = signature;
    renderItem(c, item, row.node);
  }
  if (follow) {
    log.scrollTop = log.scrollHeight;
    // Scroll events are coalesced per frame, so remember where we sent the log; an upward move made in the
    // same frame is then still seen as a decrease from here.
    lastScroll = readScroll();
  }
}
// A thinking block is shown while it streams in the current, active turn. A stream left open by a turn that
// ended without closing it (process exit) must not animate forever, hence the busy check; and it must not come
// back when the next turn makes the conversation busy again, hence only items after the last user message.
function thinkingActive(c: Conversation, item: Item & { kind: "thinking" }): boolean {
  if (!item.streaming || !c.busy) return false;
  for (let i = c.items.length - 1; i >= 0; i--) {
    if (c.items[i] === item) return true;
    if (c.items[i].kind === "user") return false;
  }
  return false;
}
function renderItem(c: Conversation, item: Item, node: HTMLElement): void {
  const expanded = node.querySelector("details")?.open ?? false;
  node.replaceChildren();
  if (item.kind === "user" || item.kind === "text") {
    node.append(el("div", "chat-role", item.kind === "user" ? "You" : c.provider === "claude" ? "Claude" : "Codex"));
    const body = el("div", "chat-markdown"); body.innerHTML = renderMarkdown(item.text); node.append(body);
    if (item.kind === "text" && !item.streaming) {
      for (const block of body.querySelectorAll<HTMLElement>(".code-block")) {
        const pre = block.querySelector(":scope > pre");
        if (!pre) continue;
        const insert = iconButton("Insert into terminal (without Enter)", "terminal", "chat-insert-code", () => insertCode(c, pre.textContent ?? ""));
        insert.classList.add("terminal-code");
        block.append(insert);
      }
    }
  } else if (item.kind === "thinking") {
    // Like Beckwell's activity line: a twinkling sparkle and the label waving one character at a time.
    // Once thinking is over the row is hidden; the reasoning text itself is not shown.
    node.hidden = !thinkingActive(c, item);
    if (node.hidden) return;
    const label = "Thinking…";
    const line = el("div", "chat-thinking-activity"); line.setAttribute("role", "status"); line.setAttribute("aria-label", label);
    const sparkle = el("span", "chat-sparkle", "✦"); sparkle.setAttribute("aria-hidden", "true");
    const text = el("span", ""); text.setAttribute("aria-hidden", "true");
    Array.from(label).forEach((char, index) => {
      const wave = el("span", "chat-wave", char === " " ? "\u00a0" : char);
      wave.style.animationDelay = `${index * 70}ms`;
      text.append(wave);
    });
    line.append(sparkle, text); node.append(line);
  } else if (item.kind === "tool_use") {
    const details = el("details", ""); details.open = expanded;
    const title = `${item.name}${item.isError ? " · failed" : item.result === null ? " · running" : ""}`;
    details.append(el("summary", "", title), el("pre", "", `${JSON.stringify(item.input, null, 2)}\n${item.result ?? ""}`)); node.append(details);
  } else if (item.kind === "permission") {
    node.append(el("strong", "", `Permission: ${item.toolName}`), el("pre", "", item.description), el("pre", "", JSON.stringify(item.input, null, 2)));
    if (item.decision) node.append(el("p", "", item.decision));
    else for (const decision of ["allow", "deny"] as const) node.append(button(decision === "allow" ? "Allow" : "Deny", `chat-permission-${decision}`, () => { void respondPermission(c, item, decision); }));
  } else if (item.kind === "question") renderQuestion(c, item, node);
  else if (item.kind === "result") node.append(el("small", "", item.summary));
  else { node.append(el("p", item.level === "error" ? "chat-error" : "", item.text)); }
}
function renderQuestion(c: Conversation, item: QuestionItem, node: HTMLElement): void {
  node.append(el("strong", "", item.title));
  if (item.decision) { node.append(el("pre", "", item.decision === "declined" ? "Declined" : JSON.stringify(item.answers))); return; }
  const answers = new Map<string, HTMLInputElement>();
  for (const question of item.questions) {
    const label = el("label", "chat-question", question.question);
    const answer = el("input", ""); answer.dataset.annotate = "chat-question-answer";
    answer.type = question.kind === "number" ? "number" : "text";
    answer.placeholder = question.placeholder;
    answer.required = true;
    if (question.min !== null) answer.min = String(question.min);
    if (question.max !== null) answer.max = String(question.max);
    if (question.step !== null) answer.step = String(question.step);
    label.append(answer); answers.set(question.question, answer);
    for (const option of question.options) {
      const choice = button(option.label, "chat-question-option", () => { answer.value = question.multiSelect && answer.value ? `${answer.value}, ${option.label}` : option.label; });
      choice.title = option.description; label.append(choice);
    }
    node.append(label);
  }
  node.append(button("Answer", "chat-answer", () => {
    if ([...answers.values()].some((answer) => !answer.reportValidity())) return;
    void answerQuestion(c, item, Object.fromEntries([...answers].map(([key, value]) => [key, value.value]))); }), button("Decline", "chat-decline", () => { void answerQuestion(c, item, null); }));
}

function renderQueue(c: Conversation | undefined): void {
  if (queueRendered !== c) { queueRendered = c; queueRows.clear(); queueList.replaceChildren(); }
  const queue = c?.queue ?? [];
  queueBox.hidden = queue.length === 0;
  if (!c || !queue.length) { queueRows.clear(); queueList.replaceChildren(); return; }
  queueCount.textContent = `Queued (${queue.length})`;
  queueState.textContent = c.queueHeld ? "held" : "sent in order when the agent is idle";
  queueState.classList.toggle("held", c.queueHeld);
  queueResume.hidden = !c.queueHeld;
  const ids = new Set(queue.map((entry) => entry.id));
  for (const [id, row] of queueRows) if (!ids.has(id)) { row.node.remove(); queueRows.delete(id); }
  let previous: HTMLElement | null = null;
  queue.forEach((entry, index) => {
    let row = queueRows.get(entry.id);
    if (!row) row = queueRow(c, entry);
    // Only move rows that are out of place so a focused textarea keeps focus.
    const expected: ChildNode | null = previous ? previous.nextSibling : queueList.firstChild;
    if (expected !== row.node) queueList.insertBefore(row.node, expected);
    previous = row.node;
    row.index.textContent = String(index + 1);
    row.text.setAttribute("aria-label", `Queued message ${index + 1}`);
    row.merge.disabled = index === 0;
    if (document.activeElement !== row.text && row.text.value !== entry.text) row.text.value = entry.text;
    row.text.rows = rowsFor(row.text.value);
  });
}
function queueRow(c: Conversation, entry: QueuedMessage): { node: HTMLElement; index: HTMLElement; text: HTMLTextAreaElement; merge: HTMLButtonElement } {
  const node = el("div", "chat-queue-item");
  const index = el("span", "chat-queue-index"); index.setAttribute("aria-hidden", "true");
  const text = el("textarea", "chat-queue-text"); text.spellcheck = false; text.value = entry.text;
  text.dataset.annotate = "chat-queue-text";
  text.addEventListener("input", () => { entry.text = text.value; text.rows = rowsFor(text.value); });
  const position = () => c.queue.indexOf(entry);
  const merge = iconButton("Append to the message above", "arrow-up", "chat-queue-merge", () => {
    if (mergeUp(c.queue, position())) render();
  });
  const remove = iconButton("Remove from queue", "close", "chat-queue-remove", () => {
    const at = position(); if (at >= 0) { c.queue.splice(at, 1); render(); }
  });
  node.append(index, text, merge, remove);
  const row = { node, index, text, merge };
  queueRows.set(entry.id, row);
  return row;
}
