import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "xterm";
import type { ITheme } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { WebLinksAddon } from "xterm-addon-web-links";

// ── Types ────────────────────────────────────────────────────────────────────

export interface AppConfig {
  font: { family: string; size: number };
  theme: Record<string, string>;
  shell_name: string;
  config_path: string;
  warning: string | null;
}

export interface Session {
  id: number;
  terminal: Terminal;
  fitAddon: FitAddon;
}

const DEFAULT_THEME: ITheme = {
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
};

// ── State ────────────────────────────────────────────────────────────────────

const sessions = new Map<number, Session>();
/** create_terminal が id を返すより先に届いた出力の置き場 */
const pendingOutput = new Map<number, Uint8Array[]>();
let ptyEvents: Promise<void> | null = null;

// ── Encoding ─────────────────────────────────────────────────────────────────
//
// pty との受け渡しは base64 で、中身は UTF-8 のバイト列。atob の結果を
// そのまま write / btoa に渡すと「1 バイト = 1 文字」の binary string を
// UTF-16 の文字列として扱うことになり、非 ASCII が壊れる (入力側は
// U+00FF 超で btoa が例外を投げる)。必ずバイト列を経由すること。

function decodeBase64(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** xterm の onBinary が渡す「1 バイト = 1 文字」の文字列をバイト列に戻す */
function binaryStringToBytes(data: string): Uint8Array {
  const bytes = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    bytes[i] = data.charCodeAt(i) & 0xff;
  }
  return bytes;
}

// ── Session ──────────────────────────────────────────────────────────────────

export function loadConfig(): Promise<AppConfig> {
  return invoke<AppConfig>("get_config");
}

export function setupPtyEvents(): Promise<void> {
  if (!ptyEvents) {
    ptyEvents = registerPtyEvents();
  }
  return ptyEvents;
}

async function registerPtyEvents(): Promise<void> {
  await listen<{ tab_id: number; data: string }>("terminal-output", ({ payload }) => {
    const bytes = decodeBase64(payload.data);
    const session = sessions.get(payload.tab_id);
    if (session) {
      // pty の読み出し境界でマルチバイト文字が分断されるので、文字列では
      // なくバイト列で渡す (xterm 内蔵の UTF-8 デコーダが跨いで処理する)。
      session.terminal.write(bytes);
      return;
    }
    const queued = pendingOutput.get(payload.tab_id);
    if (queued) {
      queued.push(bytes);
    } else {
      pendingOutput.set(payload.tab_id, [bytes]);
    }
  });

  await listen<{ tab_id: number }>("terminal-exit", ({ payload }) => {
    sessions.get(payload.tab_id)?.terminal.write("\r\n\x1b[33m[Process exited]\x1b[0m\r\n");
  });
}

export async function startSession(
  element: HTMLElement,
  config: AppConfig,
): Promise<Session> {
  await setupPtyEvents();

  const terminal = new Terminal({
    cursorBlink: true,
    cursorStyle: "block",
    fontFamily: config.font.family,
    fontSize: config.font.size,
    theme: { ...DEFAULT_THEME, ...config.theme } as ITheme,
    allowTransparency: true,
    smoothScrollDuration: 0,
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new WebLinksAddon());
  terminal.open(element);

  const id = await invoke<number>("create_terminal");
  const session: Session = { id, terminal, fitAddon };
  sessions.set(id, session);

  const queued = pendingOutput.get(id);
  if (queued) {
    pendingOutput.delete(id);
    queued.forEach((bytes) => terminal.write(bytes));
  }

  terminal.onData((data) => writeStdin(id, new TextEncoder().encode(data)));
  terminal.onBinary((data) => writeStdin(id, binaryStringToBytes(data)));
  terminal.onResize(({ cols, rows }) => {
    invoke("resize_terminal", { tabId: id, rows, cols }).catch(console.error);
  });

  return session;
}

export async function closeSession(session: Session): Promise<void> {
  sessions.delete(session.id);
  pendingOutput.delete(session.id);
  session.terminal.dispose();
  await invoke("close_terminal", { tabId: session.id }).catch(console.error);
}

/** 表示サイズに合わせる。行数・桁数が変われば onResize 経由で pty も追従する */
export function fitSession(session: Session): void {
  session.fitAddon.fit();
}

export function writeConfigWarning(session: Session, config: AppConfig): void {
  if (!config.warning) {
    return;
  }
  session.terminal.write(
    `\x1b[33mastragal: ${config.warning.replace(/\n/g, "\r\n")}\x1b[0m\r\n` +
      `\x1b[90m(${config.config_path})\x1b[0m\r\n`,
  );
}

function writeStdin(id: number, bytes: Uint8Array): void {
  invoke("write_stdin", { tabId: id, data: encodeBase64(bytes) }).catch(console.error);
}
