import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { Session } from "./terminal";

// ── Drop to Remote (scp) ─────────────────────────────────────────────────────
//
// アクティブなタブが ssh で繋いでいる時、ウインドウへドロップしたファイルを scp で
// そのホストへ送る (CYBERNEURA-DEV-1177)。ssh かどうか・接続先・scp の引数は Rust
// (remote_drop.rs) が pty の前面のプロセスから決める。ここは見た目と確認だけ。
//
// - ドラッグが入った時に接続先を問い合わせ、ssh の時だけドロップゾーンを出す
// - ドロップしても送らず、確認ダイアログで接続先・ファイル・送り先のディレクトリを見せる
// - 送る時は、確認した接続の key を Rust に渡す。確認の間に ssh を抜けた・繋ぎ直した
//   時は Rust が断る (表示用の接続先は -o HostName などの違いを含まないので比べない)
//
// ssh でないタブへのドロップは何もしない (従来どおり)。
// 検索バーと同じくウインドウに 1 つで、状態はモジュール変数で持つ。

interface DropTarget {
  label: string;
  /** 接続の同一性を比べる値 (Rust の SshTarget::identity)。送る時にそのまま返す */
  key: string;
}

/** ダイアログに並べるファイル名の数。超えた分は件数だけ出す */
const LISTED_FILES_MAX = 5;
/** 送り終えてからダイアログを閉じるまでの時間 */
const DONE_CLOSE_MS = 1200;

let getActiveSession: () => Session | undefined;
let zone: HTMLElement;
let zoneLabel: HTMLElement;
let dialog: HTMLElement;
let dialogTitle: HTMLElement;
let fileList: HTMLElement;
let dirInput: HTMLInputElement;
let note: HTMLElement;
let copyButton: HTMLButtonElement;
let cancelButton: HTMLButtonElement;

/** ドラッグごとの番号。問い合わせの応答が、次のドラッグの後に届いたら捨てる */
let dragSeq = 0;
/** 確認中の送り先。ダイアログを閉じたら null */
let pending: { tabId: number; key: string; paths: string[] } | null = null;
let busy = false;

export async function initRemoteDrop(
  container: HTMLElement,
  activeSession: () => Session | undefined,
): Promise<void> {
  getActiveSession = activeSession;
  buildZone(container);
  buildDialog(container);
  try {
    await getCurrentWebview().onDragDropEvent(({ payload }) => {
      switch (payload.type) {
        case "enter":
          void showZoneIfRemote(++dragSeq);
          break;
        case "leave":
          dragSeq++;
          zone.hidden = true;
          break;
        case "drop":
          dragSeq++;
          zone.hidden = true;
          void confirmDrop(payload.paths);
          break;
      }
    });
  } catch (e) {
    // 受け取れなくてもターミナルは使えるので、初期化は止めない
    console.error("Failed to subscribe to drag-and-drop events:", e);
  }
}

function buildZone(container: HTMLElement): void {
  zone = document.createElement("div");
  zone.id = "drop-zone";
  zone.hidden = true;
  zoneLabel = document.createElement("div");
  zoneLabel.className = "drop-zone-label";
  zone.appendChild(zoneLabel);
  container.appendChild(zone);
}

function buildDialog(container: HTMLElement): void {
  dialog = document.createElement("div");
  dialog.id = "drop-dialog";
  dialog.hidden = true;
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");

  const panel = document.createElement("div");
  panel.className = "drop-panel";

  dialogTitle = document.createElement("div");
  dialogTitle.className = "drop-title";

  fileList = document.createElement("ul");
  fileList.className = "drop-files";

  const dirLabel = document.createElement("label");
  dirLabel.className = "drop-dir";
  dirLabel.textContent = "Remote directory";
  dirInput = document.createElement("input");
  dirInput.type = "text";
  dirInput.className = "drop-dir-input";
  dirInput.spellcheck = false;
  dirInput.autocomplete = "off";
  dirLabel.appendChild(dirInput);

  note = document.createElement("div");
  note.className = "drop-note";
  note.setAttribute("aria-live", "polite");

  const buttons = document.createElement("div");
  buttons.className = "drop-buttons";
  cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "drop-button";
  cancelButton.textContent = "Cancel";
  copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.className = "drop-button primary";
  copyButton.textContent = "Copy";
  buttons.append(cancelButton, copyButton);

  panel.append(dialogTitle, fileList, dirLabel, note, buttons);
  dialog.appendChild(panel);
  container.appendChild(dialog);

  cancelButton.addEventListener("click", closeDialog);
  copyButton.addEventListener("click", () => void upload());
  dialog.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeDialog();
    } else if (e.key === "Enter" && !e.isComposing && e.target === dirInput) {
      e.preventDefault();
      void upload();
    }
  });
}

async function remoteTarget(tabId: number): Promise<DropTarget | null> {
  try {
    return await invoke<DropTarget | null>("remote_drop_target", { tabId });
  } catch (e) {
    console.error("Failed to inspect the tab for drag-and-drop:", e);
    return null;
  }
}

async function showZoneIfRemote(seq: number): Promise<void> {
  const session = getActiveSession();
  if (!session || pending) {
    return;
  }
  const target = await remoteTarget(session.id);
  if (!target || seq !== dragSeq) {
    return;
  }
  zoneLabel.textContent = `Drop to copy to ${target.label}`;
  zone.hidden = false;
}

async function confirmDrop(paths: string[]): Promise<void> {
  const session = getActiveSession();
  if (!session || pending || paths.length === 0) {
    return;
  }
  // ドロップした時点の接続先で確かめ直す (ドラッグ中に ssh を抜けていることがある)
  const target = await remoteTarget(session.id);
  if (!target) {
    return;
  }
  pending = { tabId: session.id, key: target.key, paths };
  const count = paths.length === 1 ? "1 item" : `${paths.length} items`;
  dialogTitle.textContent = `Copy ${count} to ${target.label}?`;
  fileList.replaceChildren(
    ...paths.slice(0, LISTED_FILES_MAX).map((path) => {
      const item = document.createElement("li");
      item.textContent = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
      item.title = path;
      return item;
    }),
  );
  if (paths.length > LISTED_FILES_MAX) {
    const more = document.createElement("li");
    more.className = "more";
    more.textContent = `and ${paths.length - LISTED_FILES_MAX} more`;
    fileList.appendChild(more);
  }
  dirInput.value = "~";
  setNote("Copied with scp. Needs key or agent authentication (passwords cannot be entered).");
  setBusy(false);
  dialog.hidden = false;
  dirInput.focus();
  dirInput.select();
}

async function upload(): Promise<void> {
  if (!pending || busy) {
    return;
  }
  const request = pending;
  setBusy(true);
  setNote("Copying…");
  try {
    await invoke("remote_drop_upload", {
      tabId: request.tabId,
      expected: request.key,
      paths: request.paths,
      remoteDir: dirInput.value,
    });
    if (pending !== request) {
      return;
    }
    setNote("Copied.");
    setTimeout(() => {
      if (pending === request) {
        closeDialog();
      }
    }, DONE_CLOSE_MS);
  } catch (e) {
    if (pending !== request) {
      return;
    }
    setBusy(false);
    setNote(String(e), true);
  }
}

function setBusy(value: boolean): void {
  busy = value;
  copyButton.disabled = value;
  dirInput.disabled = value;
}

function setNote(text: string, error = false): void {
  note.textContent = text;
  note.classList.toggle("error", error);
}

/** 閉じる。送っている途中でも閉じられる (scp は止めず、結果は捨てる) */
function closeDialog(): void {
  pending = null;
  busy = false;
  dialog.hidden = true;
  getActiveSession()?.terminal.focus();
}
