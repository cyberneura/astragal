import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Terminal } from "xterm";
import type { ITheme } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { Unicode11Addon } from "xterm-addon-unicode11";
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
  // タブバーと同じ色。ウインドウ全体をこの色で塗って継ぎ目を無くす
  background: "#181825",
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
/** 同上。すぐ終了するコマンドだと、登録より先に終了が届く */
const pendingExit = new Set<number>();
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

/** ターミナルを作れなかった時に、真っ白なウインドウではなく理由を出す */
export function showStartupError(container: HTMLElement, error: unknown): void {
  const box = document.createElement("pre");
  box.className = "startup-error";
  box.textContent = `Failed to start the terminal:\n${String(error)}`;
  container.appendChild(box);
}

/** 実際に描画されるターミナルの背景色 */
function terminalBackground(config: AppConfig): string {
  return config.theme.background ?? DEFAULT_THEME.background ?? "#181825";
}

/**
 * ウインドウ全体をターミナルと同じ色で塗る。fit の端数やスクロールバーの溝が
 * 別の色で浮かないようにするため。
 */
export function applyTerminalBackground(config: AppConfig): void {
  document.documentElement.style.setProperty(
    "--terminal-background",
    terminalBackground(config),
  );
}

export function setupPtyEvents(): Promise<void> {
  if (!ptyEvents) {
    ptyEvents = registerPtyEvents();
  }
  return ptyEvents;
}

async function registerPtyEvents(): Promise<void> {
  // 受信対象をこの webview に限定する。素の listen() は target を Any で登録し、
  // tauri 側は Any のリスナーには emit_to の絞り込みを無視して配送するため、
  // もう一方のウインドウの出力まで届いて pendingOutput に溜まり続ける。
  const self = getCurrentWebviewWindow();

  await self.listen<{ tab_id: number; data: string }>("terminal-output", ({ payload }) => {
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

  await self.listen<{ tab_id: number }>("terminal-exit", ({ payload }) => {
    const session = sessions.get(payload.tab_id);
    if (session) {
      writeExitNotice(session);
    } else {
      pendingExit.add(payload.tab_id);
    }
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
    // terminal.unicode は proposed API 扱いで、これが無いと getter が throw する
    allowProposedApi: true,
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new WebLinksAddon());

  // xterm's built-in width table is Unicode 6, where emoji are one cell wide. The glyph the font
  // draws is two cells wide, so it gets clipped down the middle and everything after it on the
  // line sits one column off from where the shell thinks it is. Unicode 11 widths fix both.
  // activeVersion only accepts a version that has been registered, so this must follow loadAddon.
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = "11";

  terminal.open(element);

  const id = await invoke<number>("create_terminal");
  const session: Session = { id, terminal, fitAddon };
  sessions.set(id, session);

  const queued = pendingOutput.get(id);
  if (queued) {
    pendingOutput.delete(id);
    queued.forEach((bytes) => terminal.write(bytes));
  }
  // 出力を流し切ってから終了を出す (順序が入れ替わらないように)
  if (pendingExit.delete(id)) {
    writeExitNotice(session);
  }

  terminal.onData((data) => writeStdin(id, new TextEncoder().encode(data)));
  terminal.onBinary((data) => writeStdin(id, binaryStringToBytes(data)));
  terminal.onResize(({ cols, rows }) => {
    invoke("resize_terminal", { tabId: id, rows, cols }).catch(console.error);
  });

  return session;
}

function writeExitNotice(session: Session): void {
  session.terminal.write("\r\n\x1b[33m[Process exited]\x1b[0m\r\n");
}

export async function closeSession(session: Session): Promise<void> {
  sessions.delete(session.id);
  pendingOutput.delete(session.id);
  pendingExit.delete(session.id);
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
