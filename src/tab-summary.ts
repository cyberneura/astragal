import { invoke } from "@tauri-apps/api/core";
import type { IDisposable, Terminal } from "xterm";

// ── タブ名と要約の自動生成 (tab_summary.enabled) ───────────────────────────────
//
// 出力のあったタブの末尾の行を Rust (tab_summary.rs) に渡し、LLM に名前と要約を
// 作らせる。名前はタブのラベルに、要約はツールチップかタブバーの下の 2 行に出す
// (tab_summary.display)。
//
// - 送るのは「出力が止まってから IDLE_MS 経った」タブだけ。出力が流れ続けている間に
//   送っても、すぐ古くなる上に CLI の起動が積み上がる
// - 同じタブは interval_seconds に 1 回まで。前回と同じテキストなら送らない
// - 生成はこのウインドウで同時に 1 つだけ。CLI の provider は 1 回で数秒〜数十秒かかり、
//   タブの数だけ並べて起動すると重くなる (main と small の間は Rust の CLI_LOCK で直列化する)
// - 名前の幅と他のタブとの重複は Rust 側で揃える (他のタブの今の名前を一緒に渡す)
//
// 設定が無効なら何もしない (イベントの購読もしない)。

export interface TabSummaryConfig {
  enabled: boolean;
  display: "tooltip" | "bar";
  interval_seconds: number;
}

/** tabs.ts が持つタブのうち、ここで使うもの */
export interface SummaryTarget {
  id: number;
  terminal: Terminal;
  /** 今タブに出ている名前 */
  title: () => string;
  /** 生成した名前と要約を反映する */
  apply: (title: string, summary: string) => void;
}

interface TabSummary {
  title: string;
  summary: string;
}

interface TrackedTab {
  target: SummaryTarget;
  writes: IDisposable;
  /** 前回送ってから出力があったか */
  dirty: boolean;
  /** 前回送った時刻 (ms)。0 は未送信 */
  lastRun: number;
  /** 前回送ったテキスト。変わっていなければ送らない */
  lastContent: string;
  summary: string;
  timer: number | undefined;
}

/** 出力が止まってから送るまでの待ち時間 */
const IDLE_MS = 5_000;
/** 送る行数 (通常バッファの末尾から) */
const CONTENT_LINES = 120;

let config: TabSummaryConfig | undefined;
const tracked = new Map<number, TrackedTab>();
/** 生成待ちのタブ id (古い順) */
const queue: number[] = [];
let running = false;
let bar: HTMLElement | undefined;
let getActiveId: () => number | null = () => null;

export function isTabSummaryEnabled(): boolean {
  return config !== undefined;
}

export function displaysInTooltip(): boolean {
  return config?.display === "tooltip";
}

/**
 * @param barAfter display が bar の時、要約の行をこの要素 (タブバー) の直後に置く
 */
export function initTabSummary(
  settings: TabSummaryConfig,
  barAfter: HTMLElement | null,
  activeId: () => number | null,
): void {
  if (!settings.enabled) {
    return;
  }
  config = settings;
  getActiveId = activeId;
  if (settings.display === "bar" && barAfter) {
    // 要約の有無で高さが変わるとターミナルの行数が動くので、行は常に置いておく
    bar = document.createElement("div");
    bar.id = "tab-summary-bar";
    bar.setAttribute("aria-live", "polite");
    barAfter.insertAdjacentElement("afterend", bar);
    showInBar("");
  }
}

/** タブを追跡し始める。出力が止まったら生成を予約する */
export function trackTab(target: SummaryTarget): void {
  if (!config) {
    return;
  }
  const tab: TrackedTab = {
    target,
    writes: target.terminal.onWriteParsed(() => markDirty(tab)),
    dirty: false,
    lastRun: 0,
    lastContent: "",
    summary: "",
    timer: undefined,
  };
  tracked.set(target.id, tab);
}

export function untrackTab(id: number): void {
  const tab = tracked.get(id);
  if (!tab) {
    return;
  }
  tab.writes.dispose();
  window.clearTimeout(tab.timer);
  tracked.delete(id);
  const index = queue.indexOf(id);
  if (index !== -1) {
    queue.splice(index, 1);
  }
}

/** アクティブなタブが変わった時に呼ぶ。バーの表示をそのタブの要約にする */
export function syncTabSummaryWithActiveTab(): void {
  if (!bar) {
    return;
  }
  const id = getActiveId();
  showInBar(id === null ? "" : (tracked.get(id)?.summary ?? ""));
}

function markDirty(tab: TrackedTab): void {
  tab.dirty = true;
  // 待ち行列に入った後に出力が再開したら、また止まるまで待ち直す
  const index = queue.indexOf(tab.target.id);
  if (index !== -1) {
    queue.splice(index, 1);
  }
  schedule(tab, IDLE_MS);
}

function schedule(tab: TrackedTab, delay: number): void {
  window.clearTimeout(tab.timer);
  tab.timer = window.setTimeout(() => onIdle(tab), delay);
}

function onIdle(tab: TrackedTab): void {
  if (!config || tracked.get(tab.target.id) !== tab || !tab.dirty) {
    return;
  }
  const wait = tab.lastRun + config.interval_seconds * 1000 - Date.now();
  if (wait > 0) {
    // 間隔が空くまで待つ。その間の出力は dirty のまま残り、待った後にまとめて送る
    schedule(tab, wait);
    return;
  }
  if (!queue.includes(tab.target.id)) {
    queue.push(tab.target.id);
  }
  void drain();
}

async function drain(): Promise<void> {
  if (running) {
    return;
  }
  running = true;
  try {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      const tab = tracked.get(id);
      if (tab) {
        await generate(tab);
      }
    }
  } finally {
    running = false;
  }
}

async function generate(tab: TrackedTab): Promise<void> {
  tab.dirty = false;
  const content = recentText(tab.target.terminal);
  if (!content || content === tab.lastContent) {
    return;
  }
  tab.lastRun = Date.now();
  tab.lastContent = content;
  const otherTitles = [...tracked.values()]
    .filter((other) => other !== tab)
    .map((other) => other.target.title());
  try {
    const result = await invoke<TabSummary>("tab_summary_generate", { content, otherTitles });
    // 待っている間にタブが閉じられていたら捨てる
    if (tracked.get(tab.target.id) !== tab) {
      return;
    }
    tab.summary = result.summary;
    tab.target.apply(result.title, result.summary);
  } catch (error) {
    if (tracked.get(tab.target.id) !== tab) {
      return;
    }
    // 同じ中身でも次の出力の後に送り直す (ログインし直した・設定を直した後に、失敗の表示が残り続けないように)
    tab.lastContent = "";
    // 名前は変えずに、失敗した理由を要約の場所に出す (CLI が見つからない等に気付けるように)
    console.error("astragal: could not summarize the tab", error);
    tab.summary = `Could not summarize this tab: ${String(error)}`;
    tab.target.apply(tab.target.title(), tab.summary);
  }
  if (tab.target.id === getActiveId()) {
    syncTabSummaryWithActiveTab();
  }
}

/**
 * 通常バッファの末尾 CONTENT_LINES 行。vim 等の全画面アプリの表示中でも、
 * その前にシェルで打った内容のほうがタブの用途をよく表すので通常バッファを読む。
 */
function recentText(terminal: Terminal): string {
  const buffer = terminal.buffer.normal;
  const lines: string[] = [];
  const end = buffer.length;
  for (let y = Math.max(0, end - CONTENT_LINES); y < end; y++) {
    lines.push(buffer.getLine(y)?.translateToString(true) ?? "");
  }
  return lines.join("\n").trim();
}

function showInBar(summary: string): void {
  if (!bar) {
    return;
  }
  bar.textContent = summary || "No summary yet";
  bar.classList.toggle("empty", summary === "");
  // 2 行に収まらない分はツールチップで読む
  bar.title = summary;
}
