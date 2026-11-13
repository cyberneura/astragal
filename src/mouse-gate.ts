// マウスレポートの門番 (CYBERNEURA-DEV-1262)。Tauri に依存しない部分で、tests/ から直接読む。
//
// xterm 5 にはマウスレポートを止める公開 API が無い。アプリ (vim / tmux 等) が DECSET 1000 等を
// 送ると、xterm の CoreMouseService.activeProtocol が NONE 以外になり、クリックやドラッグが
// pty へ送られ、範囲選択ができなくなる (Shift / Option を押した時だけ選択になる)。
//
// OFF の間は activeProtocol の setter を横取りし、アプリが要求したプロトコルを覚えるだけで
// xterm には渡さない。ON に戻したら覚えておいたプロトコルを入れ直す (vim 等はマウスを要求した
// ままのつもりでいるため)。
//
// 「xterm に一度渡してから onProtocolChange で NONE に戻す」方式は採らなかった。xterm 自身の
// リスナーが先に動き、SelectionService.disable() が選択範囲を消してしまう。tmux のように
// モードを送り直すアプリだと、OFF にして選択している最中に選択が消える。
//
// DECSET / DECRST を CSI ハンドラで横取りする方式も採らなかった。`\x1b[?1049;1000h` のように
// マウス以外のモードと混ざったシーケンスを、マウスの分だけ捨てて残りを同じ位置で処理させる
// 手段が無く、代替バッファへの切り替えと出力の順序がずれるため。

const NONE = "NONE";
const PROPERTY = "activeProtocol";

type Accessor = { get: () => string; set: (name: string) => void };

/** service の prototype から activeProtocol の getter / setter を探す。無ければ null */
function findAccessor(service: object): Accessor | null {
  for (let proto = Object.getPrototypeOf(service); proto; proto = Object.getPrototypeOf(proto)) {
    const desc = Object.getOwnPropertyDescriptor(proto, PROPERTY);
    if (desc) {
      return desc.get && desc.set ? { get: desc.get, set: desc.set } : null;
    }
  }
  return null;
}

export class MouseGate {
  /** アプリが最後に要求したプロトコル。OFF の間も更新し続ける */
  private requested: string;
  private enabled: boolean;
  private readonly service: object;
  private readonly accessor: Accessor;

  /**
   * xterm の CoreMouseService (`terminal._core.coreMouseService`) を包む。
   * 想定した形 (prototype の activeProtocol アクセサ) でなければ null を返す
   */
  static attach(service: unknown, enabled: boolean): MouseGate | null {
    if (typeof service !== "object" || service === null || Object.prototype.hasOwnProperty.call(service, PROPERTY)) {
      return null;
    }
    const accessor = findAccessor(service);
    return accessor ? new MouseGate(service, accessor, enabled) : null;
  }

  // parameter property は node の --experimental-strip-types (tests/) で読めないので使わない
  private constructor(service: object, accessor: Accessor, enabled: boolean) {
    this.service = service;
    this.accessor = accessor;
    this.enabled = enabled;
    this.requested = this.current();
    // インスタンスに同名のアクセサを置き、prototype のものを隠す。InputHandler の DECSET /
    // DECRST も CoreMouseService.reset() も `this.activeProtocol = ...` で書くので、全部ここを通る
    Object.defineProperty(service, PROPERTY, {
      configurable: true,
      enumerable: false,
      get: () => this.current(),
      set: (name: string) => {
        this.requested = name;
        if (this.enabled) {
          this.write(name);
        }
        // OFF の間は xterm に渡さない (NONE のまま。選択範囲にも触れない)
      },
    });
    this.apply();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.apply();
  }

  /** 横取りをやめる (タブを閉じる時。端末ごと破棄するのでプロトコルは戻さない) */
  dispose(): void {
    delete (this.service as Record<string, unknown>)[PROPERTY];
  }

  private current(): string {
    return this.accessor.get.call(this.service);
  }

  private write(name: string): void {
    this.accessor.set.call(this.service, name);
  }

  private apply(): void {
    const target = this.enabled ? this.requested : NONE;
    if (this.current() !== target) {
      this.write(target);
    }
  }
}
