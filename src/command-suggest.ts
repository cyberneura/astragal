import { invoke } from "@tauri-apps/api/core";
import type { Session } from "./terminal";
import { canPaste, canSuggest } from "./command-suggest-state";

// ── 次に打つコマンドの提案 (↓ キー、CYBERNEURA-DEV-1393) ─────────────────────
//
// シェルの空のプロンプトで ↓ を押すと、直近の完了したコマンドと出力を provider へ送り、
// 返ってきた 1 行のコマンドをプロンプトに貼り付ける。**Enter は送らない** — 実行するかは
// ユーザーが見て決める。改行や制御文字を含む応答は Rust 側 (command_suggest.rs の
// parse_reply) で弾いてある。
//
// ↓ を横取りするのは、OSC 133 でプロンプトにいると分かっていて (shell_integration.rs が
// 入れる main の zsh だけ)、そのプロンプトでまだ何も打っていない時だけ。↑ で履歴を
// 遡ったり文字を打ったりした後の ↓ は、そのままシェルへ渡す (履歴を戻る操作)。
// 代替バッファ (vim 等) の表示中も渡す。
//
// 応答を待つ間にユーザーが打ったり、プロンプトを離れたり、タブを切り替えたり (戻っても)、
// IME の変換を始めたり、端末からフォーカスを外したりしたら応答は捨てる
// (TerminalContext の revision と、タブ切り替え時の cancelCommandSuggest で見分ける)。
//
// main ウインドウだけで使う (main.ts から init する)。OSC 133 の境界を入れるのは main の zsh だけ。
// 設定の command_suggest.enabled が false の時はキーを横取りしない。
//
// 分からないこと: zsh が `print -z` や zle-line-init で編集バッファに行を入れても xterm への
// 入力は起きないので、その行は「空のプロンプト」に見える (提案はその行のカーソル位置に入る)。
// 逆にプロンプトの描画中の端末問い合わせへの自動応答は入力に数えるので、そのプロンプトでは
// ↓ を横取りしない (安全側)。

export interface CommandSuggestConfig {
  enabled: boolean;
  context_turns: number;
}

let config: CommandSuggestConfig;
let blacklist: string[] = [];
let getActiveSession: () => Session | undefined;
let status: HTMLElement;
let statusTimer: number | undefined;
/** 送信中の依頼。同じタブで ↓ を重ねて押しても 1 本だけにする */
let pending: { session: Session; seq: number } | null = null;
let requestSeq = 0;
/** IME の変換中か。textarea の compositionstart / end で持つ */
let composing = false;

export function initCommandSuggest(
  container: HTMLElement,
  suggestConfig: CommandSuggestConfig,
  agentChatBlacklist: string[],
  activeSession: () => Session | undefined,
): void {
  if (!suggestConfig.enabled) {
    return;
  }
  config = suggestConfig;
  blacklist = agentChatBlacklist;
  getActiveSession = activeSession;

  status = document.createElement("div");
  status.id = "command-suggest-status";
  status.hidden = true;
  status.setAttribute("aria-live", "polite");
  container.appendChild(status);

  // xterm のリスナーは textarea に付いているので、capture で先に受けて止める
  document.addEventListener("keydown", handleKeydown, true);
  document.addEventListener("compositionstart", () => { composing = true; }, true);
  document.addEventListener("compositionend", () => { composing = false; }, true);
}

/** 送信中の提案を捨てる。タブを切り替えた時に呼ぶ (戻ってきても古い提案を貼らない) */
export function cancelCommandSuggest(): void {
  if (pending === null) {
    return;
  }
  pending = null;
  requestSeq++;
  hideStatus();
}

function handleKeydown(e: KeyboardEvent): void {
  if (e.key !== "ArrowDown" || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) {
    return;
  }
  // WebKit は変換中のキーを keyCode 229 で送る
  if (composing || e.isComposing || e.keyCode === 229) {
    return;
  }
  const session = getActiveSession();
  if (!session || e.target !== session.terminal.textarea) {
    return;
  }
  const context = session.context;
  if (!canSuggest({
    exited: session.exited,
    alternateBuffer: session.terminal.buffer.active.type === "alternate",
    atPrompt: context.atPrompt,
    dirty: context.dirty,
  })) {
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  if (pending?.session === session) {
    return;
  }
  void requestSuggestion(session);
}

async function requestSuggestion(session: Session): Promise<void> {
  const context = session.context;
  const revision = context.revision;
  const seq = ++requestSeq;
  pending = { session, seq };
  const shared = context.snapshot(config.context_turns, blacklist);
  showStatus("Suggesting the next command…", false);
  try {
    const command = await invoke<string | null>("command_suggest_generate", {
      cwd: context.workingDirectory,
      turns: shared.turns,
    });
    if (seq !== requestSeq) {
      return;
    }
    const pasteable = !composing && document.activeElement === session.terminal.textarea && canPaste({
      active: session === getActiveSession(),
      exited: session.exited,
      alternateBuffer: session.terminal.buffer.active.type === "alternate",
      atPrompt: context.atPrompt,
      dirty: context.dirty,
      revision: context.revision,
    }, revision);
    if (!pasteable) {
      // 待つ間に打った・プロンプトを離れた・タブを切り替えた。黙って捨てる
      hideStatus();
      return;
    }
    if (!command) {
      showStatus("No suggestion.", false, 2000);
      return;
    }
    hideStatus();
    session.userInteracted = true;
    // 貼り付けとして送る (bracketed paste ならキーバインドに化けない)。Enter は送らない
    session.terminal.paste(command);
  } catch (error) {
    if (seq === requestSeq) {
      showStatus(`Command suggestion failed: ${String(error)}`, true, 6000);
    }
  } finally {
    if (pending?.seq === seq) {
      pending = null;
    }
  }
}

function showStatus(text: string, isError: boolean, hideAfterMs?: number): void {
  window.clearTimeout(statusTimer);
  status.textContent = text;
  status.classList.toggle("error", isError);
  status.hidden = false;
  if (hideAfterMs !== undefined) {
    statusTimer = window.setTimeout(hideStatus, hideAfterMs);
  }
}

function hideStatus(): void {
  window.clearTimeout(statusTimer);
  status.hidden = true;
}
