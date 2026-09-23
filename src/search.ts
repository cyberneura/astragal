import type { Terminal } from "xterm";
import { SearchAddon } from "xterm-addon-search";
import type { ISearchOptions } from "xterm-addon-search";
import { IS_WINDOWS, shortcutLabel } from "./platform";
import type { Session } from "./terminal";

// ── Terminal Search (Cmd+F) ──────────────────────────────────────────────────
//
// ウインドウに検索バーを 1 つだけ置き、アクティブなタブのターミナルを検索する。
// タブを切り替えると、前のタブの強調を消して新しいタブで同じ語を検索し直す。
// ウインドウごとに別の JS コンテキストで動くので、状態はモジュール変数で持つ。

/**
 * 強調の上限。これを超えると件数は「上限+」としか言えない (resultIndex が -1 で届く)。
 */
const HIGHLIGHT_LIMIT = 1000;

/** 色は #RRGGBB でなければならない (addon の制約) */
const SEARCH_OPTIONS: ISearchOptions = {
  decorations: {
    matchBackground: "#5a4a14",
    activeMatchBackground: "#c77d00",
    // オーバービュールーラーは使っていない (overviewRulerWidth 未設定) が、型の上で必須
    matchOverviewRuler: "#ffd23f",
    activeMatchColorOverviewRuler: "#ff9f0a",
  },
};

/**
 * ターミナルに検索の addon を載せる。
 *
 * xterm-addon-search 0.13 は各行のテキストを最大 15 秒キャッシュし、捨てるのはカーソルが
 * 動いた時 (onCursorMove) とリサイズの時だけ。コマンドの出力の後にプロンプトが前と同じ
 * 位置 (最下行の同じ桁) へ戻ると、出力が増えたのにカーソルは「動いていない」ので、
 * キャッシュが古いまま残り、新しい出力が検索に掛からない (実測で確認した)。
 * 書き込みのたびに捨てる。非公開のメソッドなので、無ければ何もしない
 * (xterm-addon-search は deprecated で 0.13.0 が最後。@xterm/addon-search へ移る時に見直す)。
 */
export function createSearchAddon(terminal: Terminal): SearchAddon {
  const search = new SearchAddon({ highlightLimit: HIGHLIGHT_LIMIT });
  terminal.loadAddon(search);
  const internals = search as unknown as { _destroyLinesCache?: () => void };
  terminal.onWriteParsed(() => internals._destroyLinesCache?.());
  return search;
}

let bar: HTMLElement;
let input: HTMLInputElement;
let count: HTMLElement;
let getActiveSession: () => Session | undefined;
/** 強調を載せているセッション。タブを切り替えた時に、こちらの強調を消す */
let searchedSession: Session | null = null;
/** 件数の購読を済ませたセッション。1 セッションにつき 1 回だけ購読する */
const subscribed = new WeakSet<Session>();

function button(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "search-button";
  el.textContent = label;
  el.title = title;
  el.setAttribute("aria-label", title);
  // 押してもフォーカスを入力欄から奪わない。奪うと Enter / Esc が効かなくなる
  el.addEventListener("mousedown", (e) => e.preventDefault());
  el.addEventListener("click", onClick);
  return el;
}

export function initSearch(container: HTMLElement, activeSession: () => Session | undefined): void {
  getActiveSession = activeSession;

  bar = document.createElement("div");
  bar.id = "search-bar";
  bar.hidden = true;

  input = document.createElement("input");
  input.type = "text";
  input.className = "search-input";
  input.placeholder = IS_WINDOWS ? "Find (Enter / Shift+Enter)" : "Find";
  input.spellcheck = false;
  input.autocomplete = "off";
  input.setAttribute("aria-label", "Find in terminal");

  count = document.createElement("span");
  count.className = "search-count";
  count.setAttribute("aria-live", "polite");

  bar.append(
    input,
    count,
    button("↑", `Previous match (${shortcutLabel("⇧⌘G", "Shift+F3")})`, () => findInTerminal(-1)),
    button("↓", `Next match (${shortcutLabel("⌘G", "F3")})`, () => findInTerminal(1)),
    button("×", "Close (Esc)", closeSearch),
  );
  container.appendChild(bar);

  input.addEventListener("input", () => runSearch(true));
  input.addEventListener("keydown", handleInputKeydown);
}

function handleInputKeydown(e: KeyboardEvent): void {
  // IME の変換確定の Enter / Esc は検索の操作ではない
  if (e.isComposing) {
    return;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    closeSearch();
  } else if (e.key === "Enter") {
    e.preventDefault();
    findInTerminal(e.shiftKey ? -1 : 1);
  }
}

export function isSearchOpen(): boolean {
  return bar !== undefined && !bar.hidden;
}

/**
 * 検索バーを開いて入力欄にフォーカスする。既に開いていれば入力欄を選択し直す
 * (もう一度 Cmd+F を押せばそのまま次の語を打てる)。
 *
 * 閉じた状態から開く時、ターミナルに 1 行の選択があればそれを検索語にする。
 */
export function openSearch(): void {
  if (!bar) {
    return;
  }
  if (bar.hidden) {
    const selection = getActiveSession()?.terminal.getSelection() ?? "";
    if (selection && !selection.includes("\n")) {
      input.value = selection;
    }
    bar.hidden = false;
    runSearch(true);
  }
  input.focus();
  input.select();
}

/**
 * 検索バーを閉じ、強調を消してターミナルへフォーカスを戻す。
 *
 * 今の一致の選択はあえて残す。見つけた箇所をそのまま Cmd+C でコピーできるように
 * するためで、ターミナル (iTerm2 / VSCode) の検索と同じ動き。
 */
export function closeSearch(): void {
  if (!bar || bar.hidden) {
    return;
  }
  bar.hidden = true;
  clearSearchedSession();
  count.textContent = "";
  getActiveSession()?.terminal.focus();
}

/**
 * 次 (1) / 前 (-1) の一致へ移る。検索バーが閉じていても、前回の検索語が残っていれば
 * バーを開いて検索する (Cmd+G の動き)。
 */
export function findInTerminal(direction: 1 | -1): void {
  if (!bar || !input.value) {
    return;
  }
  if (bar.hidden) {
    bar.hidden = false;
  }
  runSearch(false, direction);
}

/**
 * アクティブなタブが変わった時に呼ぶ。前のタブの強調を消し、検索バーが開いていれば
 * 新しいタブで同じ語を検索し直す。
 */
export function syncSearchWithActiveTab(): void {
  if (!bar) {
    return;
  }
  const session = getActiveSession();
  if (searchedSession && searchedSession !== session) {
    clearSearchedSession();
  }
  if (bar.hidden) {
    return;
  }
  if (session) {
    runSearch(true);
  } else {
    count.textContent = "";
  }
}

function clearSearchedSession(): void {
  searchedSession?.search.clearDecorations();
  searchedSession = null;
}

/**
 * @param incremental 入力のたびの検索。今の一致が語に合い続ける限りそこに留まる
 * @param direction 1 で下 (新しい出力) へ、-1 で上 (古い出力) へ
 */
function runSearch(incremental: boolean, direction: 1 | -1 = 1): void {
  const session = getActiveSession();
  if (!session) {
    return;
  }
  subscribeResults(session);
  searchedSession = session;

  const term = input.value;
  if (!term) {
    // addon は空の語で呼ぶと強調と選択を消すだけで、件数のイベントは送らない
    session.search.clearDecorations();
    session.terminal.clearSelection();
    showCount(session, -1, 0, false);
    return;
  }
  const options = { ...SEARCH_OPTIONS, incremental };
  if (direction === 1) {
    session.search.findNext(term, options);
  } else {
    session.search.findPrevious(term, options);
  }
}

function subscribeResults(session: Session): void {
  if (subscribed.has(session)) {
    return;
  }
  subscribed.add(session);
  // 出力が増えると addon が自分で検索し直してイベントを送ってくるので、件数は
  // こちらから数え直さずにイベントだけで更新する
  session.search.onDidChangeResults(({ resultIndex, resultCount }) => {
    showCount(session, resultIndex, resultCount, true);
  });
}

function showCount(session: Session, index: number, total: number, searched: boolean): void {
  // 裏のタブの addon から遅れて届いた件数で、表の表示を上書きしない
  if (session !== getActiveSession() || bar.hidden) {
    return;
  }
  bar.classList.toggle("no-results", searched && total === 0);
  if (!searched) {
    count.textContent = "";
  } else if (total === 0) {
    count.textContent = "No results";
  } else if (index >= 0) {
    count.textContent = `${index + 1} of ${total}`;
  } else if (total >= HIGHLIGHT_LIMIT) {
    count.textContent = `${HIGHLIGHT_LIMIT}+ matches`;
  } else {
    count.textContent = `${total} matches`;
  }
}
