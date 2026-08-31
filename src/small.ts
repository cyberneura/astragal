import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { WebLinksAddon } from "xterm-addon-web-links";

// ── State ──────────────────────────────────────────────────────────────────

let terminal: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let tabId: number | null = null;

// ── DOM Elements ───────────────────────────────────────────────────────────

const terminalsContainer = document.getElementById("terminals")!;

// ── Terminal setup ─────────────────────────────────────────────────────────

async function createTerminal() {
  const element = document.createElement("div");
  element.className = "terminal-container";
  terminalsContainer.appendChild(element);

  terminal = new Terminal({
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

  fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new WebLinksAddon());
  terminal.open(element);

  // Create pty on backend
  try {
    tabId = await invoke<number>("create_terminal");
  } catch (e) {
    console.error("Failed to create terminal:", e);
  }

  // Handle input
  terminal.onData((data) => {
    const encoded = btoa(data);
    invoke("write_stdin", { tabId, data: encoded }).catch(console.error);
  });

  // Handle resize
  terminal.onResize(() => {
    fitAddon?.fit();
    if (terminal && tabId !== null) {
      invoke("resize_terminal", {
        tabId,
        rows: terminal.rows,
        cols: terminal.cols,
      }).catch(console.error);
    }
  });

  // Focus the terminal after a small delay
  setTimeout(() => terminal?.focus(), 50);
}

// ── Event Listeners ────────────────────────────────────────────────────────

async function setupEventListeners() {
  await listen<{ tab_id: number; data: string }>("terminal-output", (event) => {
    const { tab_id, data } = event.payload;
    if (tab_id === tabId && terminal) {
      const decoded = atob(data);
      terminal.write(decoded);
    }
  });

  await listen<{ tab_id: number }>("terminal-exit", (event) => {
    const { tab_id } = event.payload;
    if (tab_id === tabId && terminal) {
      terminal.write("\r\n\x1b[33m[Process exited]\x1b[0m\r\n");
    }
  });
}

// ── Init ──────────────────────────────────────────────────────────────────

window.addEventListener("load", async () => {
  await setupEventListeners();
  createTerminal();
});

// Handle window resize
window.addEventListener("resize", () => {
  const fa = fitAddon;
  if (fa) {
    setTimeout(() => fa.fit(), 10);
  }
});