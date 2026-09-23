// ── Platform ─────────────────────────────────────────────────────────────────
//
// 配布先は macOS と Windows の 2 つだけなので、Windows (WebView2) かどうかだけを見る。
// WebView2 の UA は "Windows NT" を含む。それ以外は macOS として扱う。

export const IS_WINDOWS = navigator.userAgent.includes("Windows");

/**
 * アプリのショートカットと URL のクリックに使う修飾キー。macOS は Cmd、Windows は Ctrl。
 * Windows でタブやフォントを操作するショートカットは、シェルのキー (Ctrl+W 等) と
 * ぶつからないよう Ctrl+Shift にしている (tabs.ts)。
 */
export function primaryModifierHeld(e: KeyboardEvent | MouseEvent): boolean {
  return IS_WINDOWS ? e.ctrlKey : e.metaKey;
}

/** ツールチップ等に出すショートカットの表記 */
export function shortcutLabel(mac: string, windows: string): string {
  return IS_WINDOWS ? windows : mac;
}

/** CSS から OS ごとの見た目を切り替えられるよう、html に印を付ける */
export function applyPlatformClass(): void {
  document.documentElement.classList.toggle("platform-windows", IS_WINDOWS);
}
