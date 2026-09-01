import {
  closeSession,
  fitSession,
  loadConfig,
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

// ── State ────────────────────────────────────────────────────────────────────

let tabs: TerminalTab[] = [];
let activeTabId: number | null = null;
let appConfig: AppConfig | null = null;

// ── DOM Elements ─────────────────────────────────────────────────────────────

const tabContainer = document.getElementById("tabs")!;
const terminalsContainer = document.getElementById("terminals")!;
const newTabButton = document.getElementById("new-tab")!;

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

  tabContainer.appendChild(button);
  return button;
}

async function createTab(): Promise<void> {
  const config = appConfig;
  if (!config) {
    return;
  }

  const element = document.createElement("div");
  element.className = "terminal-container";
  terminalsContainer.appendChild(element);

  let session: Session;
  try {
    session = await startSession(element, config);
  } catch (e) {
    console.error("Failed to create terminal:", e);
    element.remove();
    return;
  }

  const button = createTabButton(session.id, `${config.shell_name} ${tabs.length + 1}`);
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

document.addEventListener("keydown", (e) => {
  const meta = e.metaKey || e.ctrlKey;
  if (!meta) {
    return;
  }
  const tab = activeTab();
  const fontSize = tab?.session.terminal.options.fontSize ?? 13;

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
    setFontSize(appConfig?.font.size ?? 13);
  }
});

// ── Init ─────────────────────────────────────────────────────────────────────

newTabButton.addEventListener("click", () => createTab());

window.addEventListener("load", async () => {
  appConfig = await loadConfig();
  await createTab();
  const tab = activeTab();
  if (tab) {
    writeConfigWarning(tab.session, appConfig);
  }
});

window.addEventListener("resize", () => {
  const tab = activeTab();
  if (tab) {
    setTimeout(() => fitSession(tab.session), 10);
  }
});
