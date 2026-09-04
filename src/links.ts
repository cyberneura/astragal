import { openUrl } from "@tauri-apps/plugin-opener";
import type { IDisposable, ILink, ILinkProvider, Terminal } from "xterm";
import { WebLinksAddon } from "xterm-addon-web-links";

// ── Cmd キーの押下状態 ────────────────────────────────────────────────────────
//
// macOS の Terminal.app / iTerm2 に合わせて、Cmd を押している間だけ URL をリンクとして
// 扱う。押していない間は下線もポインタカーソルも出さないので、見た目と「クリックで
// 開けるかどうか」が一致する。素のクリックとドラッグは選択のまま残る。
//
// 押下状態は webview ごとに 1 つで足りるのでモジュールに置く。ウインドウ (main /
// small) は別々の webview なので、それぞれが自分の分を持つ。

type MetaHeldListener = (held: boolean) => void;

let metaHeld = false;
let watchingMetaKey = false;
const metaHeldListeners = new Set<MetaHeldListener>();

function setMetaHeld(held: boolean): void {
  if (metaHeld === held) {
    return;
  }
  metaHeld = held;
  metaHeldListeners.forEach((listener) => listener(held));
}

function watchMetaKey(): void {
  if (watchingMetaKey) {
    return;
  }
  watchingMetaKey = true;

  // xterm は入力用の textarea でキーイベントを止めるので、bubble では取りこぼす。
  // mousemove も見るのは、Cmd を押したままウインドウの外から入ってきた場合に
  // keydown が届かないため。
  const sync = (event: KeyboardEvent | MouseEvent): void => setMetaHeld(event.metaKey);
  window.addEventListener("keydown", sync, true);
  window.addEventListener("keyup", sync, true);
  window.addEventListener("mousemove", sync, true);

  // Cmd+Tab や Cmd+H でアプリを離れると keyup は届かない。押しっぱなしの扱いで
  // 戻ってくると、Cmd を離しているのにクリックでリンクが開いてしまう。
  window.addEventListener("blur", () => setMetaHeld(false));
}

// ── リンクの提供 ─────────────────────────────────────────────────────────────

/**
 * WebLinksAddon が作るリンクプロバイダをそのまま使い、装飾だけ Cmd で切り替える。
 *
 * URL の検出と、ソフトラップで複数行に折り返された URL の連結は addon 側の
 * LinkComputer が行う (折り返しの前後の行を連結してから正規表現を掛け、複数行に
 * またがる範囲を返す)。ここでその処理を書き直さないための構成。
 */
class MetaKeyLinkProvider implements ILinkProvider {
  private _links: ILink[] = [];

  constructor(private readonly _inner: ILinkProvider) {}

  public provideLinks(y: number, callback: (links: ILink[] | undefined) => void): void {
    this._inner.provideLinks(y, (links) => {
      this._links = links ?? [];
      this._links.forEach((link) => {
        link.decorations = { underline: metaHeld, pointerCursor: metaHeld };
      });
      callback(links);
    });
  }

  /**
   * ホバー中のリンクの装飾を今の Cmd の状態に合わせる。xterm はホバー中のリンクの
   * decorations をアクセサに差し替えて監視しているので (Linkifier2)、後から書き換える
   * とその場で下線とカーソルに反映される。ホバー中でないリンクへの代入は何も起こさない。
   */
  public syncDecorations(held: boolean): void {
    this._links.forEach((link) => {
      if (link.decorations) {
        link.decorations.underline = held;
        link.decorations.pointerCursor = held;
      }
    });
  }
}

/**
 * WebLinksAddon が登録するリンクプロバイダを取り出す。
 *
 * addon はプロバイダを公開していない (typings が WebLinksAddon しか出していない) ため、
 * activate している間だけ terminal の registerLinkProvider を差し替えて受け取る。
 * activate は同期なので、差し替えは呼び出しの間だけで閉じる。
 */
function createWebLinkProvider(
  terminal: Terminal,
  handler: (event: MouseEvent, uri: string) => void,
): ILinkProvider {
  let provider: ILinkProvider | undefined;
  const capture = terminal as Terminal & {
    registerLinkProvider: (registered: ILinkProvider) => IDisposable;
  };

  capture.registerLinkProvider = (registered: ILinkProvider): IDisposable => {
    provider = registered;
    return { dispose: () => {} };
  };
  try {
    new WebLinksAddon(handler).activate(terminal);
  } finally {
    // 自分が足した own property を消すと、クラスの実装が再び見えるようになる
    delete (capture as Partial<Terminal>).registerLinkProvider;
  }

  if (!provider) {
    throw new Error("WebLinksAddon registered no link provider");
  }
  return provider;
}

/**
 * Cmd+左クリックで既定のブラウザへ渡す。
 *
 * xterm の既定のハンドラは window.open を使うが、WKWebView は新規ウインドウの生成要求を
 * 受けるデリゲートが無いと null を返す。Tauri はそのデリゲートを既定では設定しないため、
 * この webview では window.open では何も開かない。opener プラグインを通す。
 */
function openLink(event: MouseEvent, uri: string): void {
  if (!event.metaKey || event.button !== 0) {
    return;
  }
  openUrl(uri).catch((error: unknown) => {
    console.error(`astragal: could not open ${uri}`, error);
  });
}

/**
 * ターミナルに URL のリンクを組み込む。戻り値を dispose すると解除される。
 */
export function enableLinks(terminal: Terminal): IDisposable {
  watchMetaKey();

  // OSC 8 のハイパーリンク (ls --hyperlink や gh が出すもの) も同じ扱いにする。xterm の
  // 既定のハンドラは confirm() を出してから window.open を呼ぶので、この webview では
  // 確認だけ出て何も開かない。こちらの装飾は xterm が常に付ける仕様で、Cmd では切れない。
  terminal.options.linkHandler = { activate: openLink };

  const provider = new MetaKeyLinkProvider(createWebLinkProvider(terminal, openLink));
  const registration = terminal.registerLinkProvider(provider);
  const listener: MetaHeldListener = (held) => provider.syncDecorations(held);
  metaHeldListeners.add(listener);

  return {
    dispose: () => {
      metaHeldListeners.delete(listener);
      registration.dispose();
      terminal.options.linkHandler = null;
    },
  };
}
