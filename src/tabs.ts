import {
  closeSession,
  fitSession,
  setSessionExitHandler,
  showStartupError,
  startSession,
  writeConfigWarning,
} from "./terminal";
import type { AppConfig, Session } from "./terminal";

// ── Types ────────────────────────────────────────────────────────────────────

interface TerminalTab {
  session: Session;
  element: HTMLDivElement;
  button: HTMLButtonElement;
}

export interface TabElements {
  tabContainer: HTMLElement;
  terminalsContainer: HTMLElement;
  newTabButton: HTMLElement;
}

// ── State ────────────────────────────────────────────────────────────────────
//
// ウインドウごとに別の JS コンテキストで動くので、モジュール変数で持つ。

let tabs: TerminalTab[] = [];
let activeTabId: number | null = null;
/** タブ名の連番。閉じても戻さない (同じ名前のタブが 2 つ並ばないように) */
let nextTabNumber = 1;
let elements: TabElements;
let appConfig: AppConfig;

// ── Tabs ─────────────────────────────────────────────────────────────────────

function createTabButton(tabId: number, label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "tab-button";
  button.textContent = label;
  button.dataset.tabId = String(tabId);
  button.addEventListener("click", () => switchToTab(tabId));

  const close = document.createElement("span");
  close.className = "tab-close";
  close.textContent = "×";
  close.addEventListener("click", (e) => {
    e.stopPropagation();
    closeTab(tabId);
  });
  button.appendChild(close);

  elements.tabContainer.appendChild(button);
  return button;
}

export async function createTab(): Promise<void> {
  clearEmptyNotice();

  const element = document.createElement("div");
  element.className = "terminal-container";
  elements.terminalsContainer.appendChild(element);

  let session: Session;
  try {
    session = await startSession(element, appConfig);
  } catch (e) {
    console.error("Failed to create terminal:", e);
    element.remove();
    showStartupError(elements.terminalsContainer, e);
    return;
  }

  const button = createTabButton(session.id, `${appConfig.shell_name} ${nextTabNumber++}`);
  tabs.push({ session, element, button });
  // startSession を待っている間に、残っていたタブが自動で閉じて通知が出ることがある。
  // タブが載る以上、その通知は消す。
  clearEmptyNotice();
  setSessionExitHandler(session, () => {
    closeTab(session.id);
    // 自動で閉じた結果ウインドウが空になると、シェルの出力ごと消えて何が起きたのか
    // 分からない。閉じる判定 (入力の有無) をどう組んでも、判定を外した時に無言の
    // 空ウインドウが残ることは避けられないので、痕跡はここで必ず残す。
    // closeTab は tabs から外すところまで同期で終わるので、ここで数を見てよい。
    if (tabs.length === 0) {
      showEmptyNotice();
    }
  });
  switchToTab(session.id);
}

/** 最後のタブが自動で閉じた時に、空のウインドウへ出しておく説明 */
let emptyNotice: HTMLElement | null = null;

function showEmptyNotice(): void {
  if (emptyNotice) {
    return;
  }
  const box = document.createElement("pre");
  box.className = "empty-notice";
  box.textContent =
    "The shell exited and its tab closed.\n" +
    "Press Cmd+T for a new tab, or set terminal.close_on_exit to false in the " +
    "config file to keep tabs open after the shell exits.";
  elements.terminalsContainer.appendChild(box);
  emptyNotice = box;
}

function clearEmptyNotice(): void {
  emptyNotice?.remove();
  emptyNotice = null;
}

function switchToTab(tabId: number) {
  // 閉じられた直後の id で呼ばれることがある。素通しすると全タブが
  // 非表示のまま残る。
  if (!tabs.some((tab) => tab.session.id === tabId)) {
    return;
  }
  tabs.forEach((tab) => {
    const isActive = tab.session.id === tabId;
    tab.element.style.display = isActive ? "block" : "none";
    tab.button.classList.toggle("active", isActive);
    if (!isActive) {
      return;
    }
    activeTabId = tabId;
    fitLater(tab, true);
  });
}

/**
 * レイアウトが確定してからターミナルを表示サイズに合わせる (直後は要素のサイズが
 * まだ確定していない)。待っている間にシェルが終了してタブが閉じられることがあるので、
 * dispose 済みの Terminal には触らない。
 */
function fitLater(tab: TerminalTab, focus = false): void {
  setTimeout(() => {
    if (!tabs.includes(tab)) {
      return;
    }
    fitSession(tab.session);
    if (focus) {
      tab.session.terminal.focus();
    }
  }, 10);
}

async function closeTab(tabId: number) {
  const index = tabs.findIndex((tab) => tab.session.id === tabId);
  if (index === -1) {
    return;
  }

  const tab = tabs[index];
  const wasActive = activeTabId === tabId;
  tab.element.remove();
  tab.button.remove();
  tabs.splice(index, 1);

  // 裏のタブを閉じただけならアクティブは動かさない。切り替えてしまうと、
  // 以降のキー入力が別のシェルに飛ぶ。
  //
  // 切り替えは close_terminal の往復を待つ前に済ませる。待っている間ウインドウが
  // 空になり、その隙にユーザーが選んだタブを、待機後の切り替えが上書きしてしまう。
  if (wasActive) {
    if (tabs.length > 0) {
      switchToTab(tabs[Math.min(index, tabs.length - 1)].session.id);
    } else {
      activeTabId = null;
    }
  }

  await closeSession(tab.session);
}

function activeTab(): TerminalTab | undefined {
  return tabs.find((tab) => tab.session.id === activeTabId);
}

function setFontSize(size: number) {
  const tab = activeTab();
  if (!tab) {
    return;
  }
  tab.session.terminal.options.fontSize = size;
  fitLater(tab);
}

// ── Keyboard Shortcuts ───────────────────────────────────────────────────────

function handleKeydown(e: KeyboardEvent) {
  // Ctrl は pty に通す。Ctrl+W (直前の単語を削除) や Ctrl+N (履歴を次へ) は
  // シェルの日常的なキーバインドで、奪うとタブごとシェルが消える。
  if (!e.metaKey) {
    return;
  }
  const fontSize = activeTab()?.session.terminal.options.fontSize ?? appConfig.font.size;

  if (e.key === "t" || e.key === "n") {
    e.preventDefault();
    createTab();
  } else if (e.key === "w") {
    e.preventDefault();
    if (activeTabId !== null) closeTab(activeTabId);
  } else if (e.key >= "1" && e.key <= "9") {
    e.preventDefault();
    const index = parseInt(e.key) - 1;
    if (index < tabs.length) switchToTab(tabs[index].session.id);
  } else if (e.key === "=" || e.key === "+") {
    e.preventDefault();
    setFontSize(Math.min(fontSize + 1, 32));
  } else if (e.key === "-") {
    e.preventDefault();
    setFontSize(Math.max(fontSize - 1, 8));
  } else if (e.key === "0") {
    e.preventDefault();
    setFontSize(appConfig.font.size);
  }
}

// ── Init ─────────────────────────────────────────────────────────────────────

export async function initTabs(ui: TabElements, config: AppConfig): Promise<void> {
  elements = ui;
  appConfig = config;

  ui.newTabButton.addEventListener("click", () => createTab());
  document.addEventListener("keydown", handleKeydown);
  window.addEventListener("resize", () => {
    const tab = activeTab();
    if (tab) {
      fitLater(tab);
    }
  });

  await createTab();
  const tab = activeTab();
  if (tab) {
    writeConfigWarning(tab.session, config);
  }
}
