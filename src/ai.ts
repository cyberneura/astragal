import { invoke } from "@tauri-apps/api/core";
import type { Session } from "./terminal";

// ── Ask AI (Cmd+I) ───────────────────────────────────────────────────────────
//
// やりたいことを書いて Enter を押すと、シェルコマンドを 1 行作ってバーに表示する。
// もう一度 Enter を押すと、それをバーを開いたタブのプロンプトに貼り付ける。
// **どちらの段階でも pty に Enter は送らない** — 実行するかはユーザーが見て決める。
// 改行や制御文字を含む応答は Rust 側 (ai.rs の parse_reply) で弾いてある。
//
// 貼り付ける前に一度見せるのは、貼り付け先がシェルのプロンプトとは限らないため。
// 代替バッファでない (= vim 等の全画面アプリでない) ことしか確かめられず、対話中の
// プログラムや代替画面を使わない設定の vim には、そのままキー入力として届く。
//
// 対象のタブと選択テキストはバーを開いた時点で決める。タブが切り替わったらバーを
// 閉じる (`syncAiWithActiveTab`)。別のタブの選択を送ったり、見えていないタブへ
// 貼り付けたりしないため。
//
// 設定の ai.enabled が false の時はバーを作らず、Cmd+I も何もしない。
// 検索バーと同じくウインドウに 1 つで、状態はモジュール変数で持つ。

type Suggestion = { kind: "command"; text: string } | { kind: "message"; text: string };

let bar: HTMLElement | undefined;
let input: HTMLInputElement;
let note: HTMLElement;
let getActiveSession: () => Session | undefined;
/** バーを開いたタブ。依頼の文脈も貼り付け先もこのタブ */
let target: Session | null = null;
/** バーを開いた時の選択。依頼と一緒に送る (送ることはバーに表示する) */
let selection = "";
/** 表示中の提案と、それを作った依頼文。依頼文を書き換えたら提案は捨てる */
let proposal: { request: string; command: string } | null = null;
/** 送信中の依頼の番号。閉じたり送り直したりした後に古い応答が届いても捨てる */
let requestSeq = 0;
let busy = false;

export function initAi(
  container: HTMLElement,
  enabled: boolean,
  activeSession: () => Session | undefined,
): void {
  if (!enabled) {
    return;
  }
  getActiveSession = activeSession;

  bar = document.createElement("div");
  bar.id = "ai-bar";
  bar.hidden = true;

  input = document.createElement("input");
  input.type = "text";
  input.className = "ai-input";
  input.placeholder = "Describe a command (Enter to ask, Esc to close)";
  input.spellcheck = false;
  input.autocomplete = "off";
  input.setAttribute("aria-label", "Ask AI for a shell command");

  note = document.createElement("div");
  note.className = "ai-note";
  note.setAttribute("aria-live", "polite");

  bar.append(input, note);
  container.appendChild(bar);

  input.addEventListener("keydown", handleKeydown);
  input.addEventListener("input", () => {
    if (proposal && input.value.trim() !== proposal.request) {
      proposal = null;
      showIntro();
    }
  });
}

export function isAiOpen(): boolean {
  return bar !== undefined && !bar.hidden;
}

/** バーを開く。開いた時点のタブと選択 (あれば) を、この依頼の対象にする */
export function openAi(): void {
  if (!bar) {
    return;
  }
  if (bar.hidden) {
    const session = getActiveSession();
    if (!session) {
      return;
    }
    target = session;
    selection = session.terminal.getSelection();
    proposal = null;
    bar.hidden = false;
    showIntro();
  }
  input.focus();
  input.select();
}

export function closeAi(): void {
  if (!bar || bar.hidden) {
    return;
  }
  bar.hidden = true;
  requestSeq++;
  setBusy(false);
  target = null;
  selection = "";
  proposal = null;
  showNote("", false);
  getActiveSession()?.terminal.focus();
}

/** アクティブなタブが変わった時に呼ぶ。バーを開いたタブでなくなったら閉じる */
export function syncAiWithActiveTab(): void {
  if (isAiOpen() && getActiveSession() !== target) {
    closeAi();
  }
}

function handleKeydown(e: KeyboardEvent): void {
  // IME の変換確定の Enter / Esc は依頼の操作ではない
  if (e.isComposing) {
    return;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    closeAi();
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (proposal && input.value.trim() === proposal.request) {
      insertProposal();
    } else {
      void ask();
    }
  }
}

async function ask(): Promise<void> {
  const request = input.value.trim();
  if (!request || busy || !target) {
    return;
  }
  const seq = ++requestSeq;
  proposal = null;
  setBusy(true);
  showNote("Asking…", false);
  try {
    const suggestion = await invoke<Suggestion>("ai_suggest_command", {
      request,
      selection: selection || null,
    });
    if (seq !== requestSeq) {
      return;
    }
    if (suggestion.kind === "message") {
      showNote(suggestion.text, true);
      return;
    }
    proposal = { request, command: suggestion.text };
    showNote(`${suggestion.text}\nEnter to type this into the prompt (it will not run)`, false);
  } catch (error) {
    if (seq === requestSeq) {
      showNote(String(error), true);
    }
  } finally {
    if (seq === requestSeq) {
      setBusy(false);
    }
  }
}

function insertProposal(): void {
  const session = target;
  if (!proposal || !session) {
    return;
  }
  if (session !== getActiveSession()) {
    // syncAiWithActiveTab で閉じているはずだが、見えていないタブには入れない
    closeAi();
    return;
  }
  if (session.exited) {
    showNote("The shell in this tab has exited.", true);
    return;
  }
  // vim / less 等の表示中に打ち込むと、そのアプリへのキー操作になる
  if (session.terminal.buffer.active.type === "alternate") {
    showNote("A full-screen program is running in this tab, so nothing was typed in.", true);
    return;
  }
  // 貼り付けとして送る。シェルが bracketed paste を有効にしていれば、1 文字ずつの
  // キー入力ではなく文字列として受け取るので、キーバインドに化けない。
  // カーソル位置に入るだけで、入力途中の行は消さない (Ctrl+U 等で消すと、シェルの
  // キーバインド次第で別の動きになる)
  session.userInteracted = true;
  session.terminal.paste(proposal.command);
  input.value = "";
  closeAi();
}

function showIntro(): void {
  showNote(selection ? "The selected text will be sent with your request." : "", false);
}

function setBusy(value: boolean): void {
  busy = value;
  bar?.classList.toggle("busy", value);
}

function showNote(text: string, isError: boolean): void {
  note.textContent = text;
  note.hidden = text === "";
  note.classList.toggle("error", isError);
}
