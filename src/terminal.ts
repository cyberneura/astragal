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
  terminal: { close_on_exit: boolean };
  theme: Record<string, string>;
  shell_name: string;
  config_path: string;
  warning: string | null;
}

export interface Session {
  id: number;
  terminal: Terminal;
  fitAddon: FitAddon;
  closeOnExit: boolean;
  /** このタブで一度でもユーザーの入力を受けたか。終了時に閉じるかの判定に使う */
  userInteracted: boolean;
  /** シェルが終了した時に呼ぶ。setSessionExitHandler で登録する */
  onExit?: () => void;
}

const DEFAULT_THEME: ITheme = {
  // タブバーと同じ色。ウインドウ全体をこの色で塗って継ぎ目を無くす
  background: "#111111",
  foreground: "#e6e6e6",
  cursor: "#ffffff",
  selectionBackground: "#3a4a6b",
  // black は罫線やコメントに使われる。#111 の上で潰れない程度に浮かせる
  black: "#4d4d4d",
  red: "#ff5f5a",
  green: "#38e07b",
  yellow: "#ffd23f",
  blue: "#4fa8ff",
  magenta: "#ff6ac1",
  cyan: "#34e2e2",
  white: "#d8d8d8",
  brightBlack: "#6f6f6f",
  brightRed: "#ff8a85",
  brightGreen: "#6bff9e",
  brightYellow: "#ffe066",
  brightBlue: "#7cc4ff",
  brightMagenta: "#ff96d8",
  brightCyan: "#66f4f4",
  brightWhite: "#ffffff",
};

// ── State ────────────────────────────────────────────────────────────────────

const sessions = new Map<number, Session>();
/** create_terminal が id を返すより先に届いた出力の置き場 */
const pendingOutput = new Map<number, Uint8Array[]>();
/** 同上。すぐ終了するコマンドだと、登録より先に終了が届く */
const pendingExit = new Set<number>();
/**
 * 明示的に閉じたタブ。閉じた後にも pty の後始末で出力と終了イベントが届くので、
 * 「まだ登録されていない」と区別して捨てるために持つ。
 * 消さずに残す (id は再利用されないので、閉じたタブ 1 つにつき数値 1 個で済む)。
 */
const closedSessions = new Set<number>();
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
  return config.theme.background ?? DEFAULT_THEME.background ?? "#111111";
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
    const session = sessions.get(payload.tab_id);
    if (session) {
      // pty の読み出し境界でマルチバイト文字が分断されるので、文字列では
      // なくバイト列で渡す (xterm 内蔵の UTF-8 デコーダが跨いで処理する)。
      session.terminal.write(decodeBase64(payload.data));
      return;
    }
    if (closedSessions.has(payload.tab_id)) {
      return;
    }
    const bytes = decodeBase64(payload.data);
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
      handleExit(session);
      return;
    }
    if (closedSessions.has(payload.tab_id)) {
      return;
    }
    pendingExit.add(payload.tab_id);
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
  const session: Session = {
    id,
    terminal,
    fitAddon,
    closeOnExit: config.terminal.close_on_exit,
    userInteracted: false,
  };
  sessions.set(id, session);

  const queued = pendingOutput.get(id);
  if (queued) {
    pendingOutput.delete(id);
    queued.forEach((bytes) => terminal.write(bytes));
  }
  // 出力を流し切ってから終了を出す (順序が入れ替わらないように)
  if (pendingExit.delete(id)) {
    handleExit(session);
  }

  terminal.onData((data) => writeStdin(id, new TextEncoder().encode(data)));
  terminal.onBinary((data) => writeStdin(id, binaryStringToBytes(data)));

  // 「ユーザーが使ったタブか」を覚える。onData では代用できない。rc ファイルが投げる
  // 端末問い合わせ (\x1b[6n 等) への自動応答でも発火してしまうため。
  terminal.onKey(() => {
    session.userInteracted = true;
  });
  terminal.textarea?.addEventListener("paste", () => {
    session.userInteracted = true;
  });
  terminal.onResize(({ cols, rows }) => {
    invoke("resize_terminal", { tabId: id, rows, cols }).catch(console.error);
  });

  return session;
}

/**
 * シェルが終了した時の分岐。
 *
 * 一度も入力を受けていないタブは、close_on_exit が有効でも閉じない。shell.command /
 * shell.args の設定を誤るとシェルは起動して即終了するが、タブごと消すとシェルが出した
 * エラーも [Process exited] も残らず、空のウインドウだけになって GUI からは設定ミスを
 * 診断できない。判定を経過時間ではなく入力の有無にしているのは、初期化に時間のかかる
 * シェルが失敗した場合も拾うため。exit や Ctrl+D で閉じる動線は入力を伴うので、
 * この条件には掛からない。
 */
function handleExit(session: Session): void {
  if (!session.closeOnExit || !session.userInteracted) {
    writeExitNotice(session, session.closeOnExit);
    return;
  }
  session.onExit?.();
}

function writeExitNotice(session: Session, keptOpen: boolean): void {
  // 「入力を受けていないから残した」とは書かない。検知しているのは onKey と paste で、
  // IME 変換やマウスレポートは onData にしか流れず、拾えていないため。
  const notice = keptOpen
    ? "[Process exited; keeping this tab open so the output stays readable]"
    : "[Process exited]";
  session.terminal.write(`\r\n\x1b[33m${notice}\x1b[0m\r\n`);
}

/**
 * シェルが終了した時の後始末を登録する。
 *
 * 登録より先に終了が届くことはある (すぐ終わるコマンド) が、その時点ではまだ誰も入力
 * できていないので handleExit はタブを残す枝に入り、ここで拾い直す必要はない。
 * 閉じる条件を入力の有無以外に変えるなら、取りこぼしの回収がここに要る。
 */
export function setSessionExitHandler(session: Session, onExit: () => void): void {
  session.onExit = onExit;
}

export async function closeSession(session: Session): Promise<void> {
  sessions.delete(session.id);
  pendingOutput.delete(session.id);
  pendingExit.delete(session.id);
  closedSessions.add(session.id);
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
