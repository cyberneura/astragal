import {
  closeSession,
  fitSession,
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
  switchToTab(session.id);
}

function switchToTab(tabId: number) {
  tabs.forEach((tab) => {
    const isActive = tab.session.id === tabId;
    tab.element.style.display = isActive ? "block" : "none";
    tab.button.classList.toggle("active", isActive);
    if (!isActive) {
      return;
    }
    activeTabId = tabId;
    // 表示直後は要素のサイズが確定していないため、レイアウト後に合わせる。
    setTimeout(() => {
      fitSession(tab.session);
      tab.session.terminal.focus();
    }, 10);
  });
}

async function closeTab(tabId: number) {
  const index = tabs.findIndex((tab) => tab.session.id === tabId);
  if (index === -1) {
    return;
  }

  const tab = tabs[index];
  tab.element.remove();
  tab.button.remove();
  tabs.splice(index, 1);
  await closeSession(tab.session);

  if (tabs.length > 0) {
    switchToTab(tabs[Math.min(index, tabs.length - 1)].session.id);
  } else {
    activeTabId = null;
  }
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
  setTimeout(() => fitSession(tab.session), 10);
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
      setTimeout(() => fitSession(tab.session), 10);
    }
  });

  await createTab();
  const tab = activeTab();
  if (tab) {
    writeConfigWarning(tab.session, config);
  }
}
