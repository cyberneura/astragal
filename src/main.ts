import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { WebLinksAddon } from "xterm-addon-web-links";

// ── Types ────────────────────────────────────────────────────────────────────

interface TerminalTab {
  id: number;
  terminal: Terminal;
  fitAddon: FitAddon;
  element: HTMLDivElement;
}

// ── State ────────────────────────────────────────────────────────────────────

let tabs: TerminalTab[] = [];
let activeTabId: number | null = null;
let nextTabId = 0;
let pendingData: Map<number, string[]> = new Map();

// ── DOM Elements ─────────────────────────────────────────────────────────────

const tabContainer = document.getElementById("tabs")!;
const terminalsContainer = document.getElementById("terminals")!;
const newTabButton = document.getElementById("new-tab")!;

// ── Terminal setup ───────────────────────────────────────────────────────────

function createTerminalElement(): HTMLDivElement {
  const div = document.createElement("div");
  div.className = "terminal-container";
  div.style.display = "none";
  terminalsContainer.appendChild(div);
  return div;
}

function createTabButton(tabId: number): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "tab-button";
  btn.textContent = `zsh ${tabId + 1}`;
  btn.dataset.tabId = String(tabId);
  btn.addEventListener("click", () => switchToTab(tabId));

  // Close button
  const close = document.createElement("span");
  close.className = "tab-close";
  close.textContent = "×";
  close.addEventListener("click", (e) => {
    e.stopPropagation();
    closeTab(tabId);
  });
  btn.appendChild(close);

  // Insert before the new-tab button
  tabContainer.appendChild(btn);
  return btn;
}

async function createTab(): Promise<number> {
  const tabId = nextTabId++;
  const element = createTerminalElement();
  createTabButton(tabId);

  const terminal = new Terminal({
    cursorBlink: true,
    cursorStyle: "block",
    fontSize: 13,
    fontFamily: "'SF Mono', 'Fira Code', 'JetBrains Mono', Menlo, monospace",
    theme: {
      background: "#1e1e2e",
      foreground: "#cdd6f4",
      cursor: "#f5e0dc",
      selectionBackground: "#585b70",
      black: "#45475a",
      red: "#f38ba8",
      green: "#a6e3a1",
      yellow: "#f9e2af",
      blue: "#89b4fa",
      magenta: "#f5c2e7",
      cyan: "#94e2d5",
      white: "#bac2de",
      brightBlack: "#585b70",
      brightRed: "#f38ba8",
      brightGreen: "#a6e3a1",
      brightYellow: "#f9e2af",
      brightBlue: "#89b4fa",
      brightMagenta: "#f5c2e7",
      brightCyan: "#94e2d5",
      brightWhite: "#a6adc8",
    },
    allowTransparency: true,
    smoothScrollDuration: 0,
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new WebLinksAddon());
  terminal.open(element);

  const tab: TerminalTab = { id: tabId, terminal, fitAddon, element };
  tabs.push(tab);

  // Create pty on backend
  try {
    await invoke("create_terminal");
  } catch (e) {
    console.error("Failed to create terminal:", e);
  }

  // Send any pending data
  if (pendingData.has(tabId)) {
    const data = pendingData.get(tabId)!;
    data.forEach((d) => terminal.write(d));
    pendingData.delete(tabId);
  }

  // Handle input
  terminal.onData((data) => {
    const encoded = btoa(data);
    invoke("write_stdin", { tabId, data: encoded }).catch(console.error);
  });

  // Handle resize
  terminal.onResize(() => {
    fitAddon.fit();
  });

  // Focus the terminal after a small delay (needed for xterm to initialize)
  setTimeout(() => terminal.focus(), 50);

  switchToTab(tabId);
  return tabId;
}

function switchToTab(tabId: number) {
  tabs.forEach((t) => {
    const isActive = t.id === tabId;
    t.element.style.display = isActive ? "block" : "none";
    const btn = tabContainer.querySelector(`[data-tab-id="${t.id}"]`);
    btn?.classList.toggle("active", isActive);
    if (isActive) {
      activeTabId = tabId;
      setTimeout(() => {
        t.fitAddon.fit();
        t.terminal.focus();
      }, 10);
    }
  });
}

async function closeTab(tabId: number) {
  const idx = tabs.findIndex((t) => t.id === tabId);
  if (idx === -1) return;

  const tab = tabs[idx];
  tab.terminal.dispose();
  tab.element.remove();
  const btn = tabContainer.querySelector(`[data-tab-id="${tabId}"]`);
  btn?.remove();
  tabs.splice(idx, 1);

  await invoke("close_terminal", { tabId }).catch(console.error);

  if (tabs.length > 0) {
    const nextTab = tabs[Math.min(idx, tabs.length - 1)];
    switchToTab(nextTab.id);
  } else {
    activeTabId = null;
  }
}

// ── Event Listeners ──────────────────────────────────────────────────────────

async function setupEventListeners() {
  // Listen for terminal output from backend
  await listen<{ tab_id: number; data: string }>("terminal-output", (event) => {
    const { tab_id, data } = event.payload;
    const decoded = atob(data);
    const tab = tabs.find((t) => t.id === tab_id);
    if (tab) {
      tab.terminal.write(decoded);
    } else {
      // Queue data for this tab if it hasn't been created yet
      if (!pendingData.has(tab_id)) {
        pendingData.set(tab_id, []);
      }
      pendingData.get(tab_id)!.push(decoded);
    }
  });

  // Listen for terminal exit
  await listen<{ tab_id: number }>("terminal-exit", (event) => {
    const { tab_id } = event.payload;
    const tab = tabs.find((t) => t.id === tab_id);
    if (tab) {
      tab.terminal.write("\r\n\x1b[33m[Process exited]\x1b[0m\r\n");
    }
  });
}

// ── Keyboard Shortcuts ───────────────────────────────────────────────────────

document.addEventListener("keydown", (e) => {
  const meta = e.metaKey || e.ctrlKey;

  if (meta && e.key === "t") {
    e.preventDefault();
    createTab();
  } else if (meta && e.key === "w") {
    e.preventDefault();
    if (activeTabId !== null) closeTab(activeTabId);
  } else if (meta && e.key === "n") {
    e.preventDefault();
    createTab();
  } else if (meta && e.key >= "1" && e.key <= "9") {
    e.preventDefault();
    const idx = parseInt(e.key) - 1;
    if (idx < tabs.length) switchToTab(tabs[idx].id);
  } else if (meta && (e.key === "=" || e.key === "+")) {
    e.preventDefault();
    // Zoom in
    const active = tabs.find((t) => t.id === activeTabId);
    if (active) {
      const size = Math.min(active.terminal.options.fontSize! + 1, 32);
      active.terminal.options.fontSize = size;
      setTimeout(() => active.fitAddon.fit(), 10);
    }
  } else if (meta && e.key === "-") {
    e.preventDefault();
    // Zoom out
    const active = tabs.find((t) => t.id === activeTabId);
    if (active) {
      const size = Math.max(active.terminal.options.fontSize! - 1, 8);
      active.terminal.options.fontSize = size;
      setTimeout(() => active.fitAddon.fit(), 10);
    }
  } else if (meta && e.key === "0") {
    e.preventDefault();
    const active = tabs.find((t) => t.id === activeTabId);
    if (active) {
      active.terminal.options.fontSize = 13;
      setTimeout(() => active.fitAddon.fit(), 10);
    }
  }
});

// ── Init ─────────────────────────────────────────────────────────────────────

newTabButton.addEventListener("click", () => createTab());

window.addEventListener("load", async () => {
  await setupEventListeners();
  createTab();
});

// Handle window resize for all terminals
window.addEventListener("resize", () => {
  tabs.forEach((t) => {
    if (t.element.style.display !== "none") {
      setTimeout(() => t.fitAddon.fit(), 10);
    }
  });
});