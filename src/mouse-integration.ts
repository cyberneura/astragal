// Mouse integration の ON / OFF (CYBERNEURA-DEV-1262)。
//
// 状態はアプリ全体で 1 つで、Rust (`mouse_integration.rs`) が持つ。タブバーのボタン・
// トレイメニュー・アプリメニュー (macOS の View) のどこから切り替えても、Rust が
// `mouse-integration-changed` を全ウインドウへ送り、ここで全タブに反映する。
// マウスレポートの止め方は `mouse-gate.ts`。

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { IDisposable, Terminal } from "xterm";
import { MouseGate } from "./mouse-gate";

const CHANGED_EVENT = "mouse-integration-changed";

let enabled = true;
const gates = new Set<MouseGate>();
let button: HTMLButtonElement | null = null;

/** タブの端末を ON / OFF の対象にする。open() の後に呼ぶ */
export function attachMouseIntegration(terminal: Terminal): IDisposable {
  // xterm の非公開の CoreMouseService。形が想定と違えば MouseGate.attach が null を返す
  const service = (terminal as unknown as { _core?: { coreMouseService?: unknown } })._core?.coreMouseService;
  const gate = MouseGate.attach(service, enabled);
  if (!gate) {
    console.warn("astragal: mouse integration toggle is unavailable (xterm internals changed)");
    return { dispose() {} };
  }
  gates.add(gate);
  return {
    dispose() {
      gates.delete(gate);
      gate.dispose();
    },
  };
}

function apply(next: boolean): void {
  enabled = next;
  gates.forEach((gate) => gate.setEnabled(next));
  renderButton();
}

function renderButton(): void {
  if (!button) {
    return;
  }
  button.setAttribute("aria-pressed", String(enabled));
  button.classList.toggle("off", !enabled);
  button.title = enabled
    ? "Mouse integration: on (apps receive clicks). Click to turn off and select text with the mouse"
    : "Mouse integration: off (drag selects text). Click to turn on";
}

const MOUSE_ICON =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3">' +
  '<rect x="4" y="1.5" width="8" height="13" rx="4"/><path d="M8 1.5v4.5M4 6h8"/>' +
  '<path class="mouse-off-slash" d="M2 14L14 2"/></svg>';

/**
 * 状態を Rust から読み、変更の通知を購読する。ボタンがあれば (main のタブバー) 切り替えに使う。
 * 吹き出し (small) はボタンを持たないが、状態は同じものに従う
 */
export async function initMouseIntegration(toggle: HTMLButtonElement | null): Promise<void> {
  button = toggle;
  if (button) {
    button.innerHTML = MOUSE_ICON;
    button.addEventListener("click", () => {
      invoke("set_mouse_integration", { enabled: !enabled }).catch(console.error);
    });
  }
  // 素の listen() ではなくウインドウの listen を使うのは他の購読と揃えるため。
  // Rust は emit (全ターゲット) で送るので、どちらでも届く
  await getCurrentWebviewWindow().listen<boolean>(CHANGED_EVENT, ({ payload }) => apply(payload));
  try {
    apply(await invoke<boolean>("mouse_integration"));
  } catch (e) {
    console.error("Failed to read the mouse integration state:", e);
    renderButton();
  }
}
