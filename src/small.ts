import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { applyTerminalBackground, loadConfig, showStartupError } from "./terminal";
import { initTabs } from "./tabs";
import { applyPlatformClass } from "./platform";

applyPlatformClass();

const terminalsContainer = document.getElementById("terminals")!;
const arrow = document.getElementById("arrow")!;

/**
 * 吹き出しのツノをトレイアイコンに合わせる (位置は Rust が実測する)。
 *
 * macOS はメニューバーの下に出るのでツノは上辺。Windows でタスクバーが下端にある時は
 * アイコンの上に出るので、ツノを下辺に付けて下向きにする (`side: "above"`)。
 *
 * イベントは show() より前に送られるが、webview への配送は非同期なので
 * 表示より遅れて届くことがある。前回の位置に出してから飛ぶのを避けるため、
 * ツノは値が届くまで描かず、隠れた時点で消す。
 */
async function trackAnchor(): Promise<void> {
  // 素の listen() は target を Any で登録してしまい、emit_to の絞り込みが効かない
  await getCurrentWebviewWindow().listen<{ arrow_x: number; side: "below" | "above" }>(
    "small-window-anchor",
    ({ payload }) => {
      document.documentElement.style.setProperty("--arrow-x", `${payload.arrow_x}px`);
      document.documentElement.classList.toggle("popover-above", payload.side === "above");
      arrow.classList.add("anchored");
    },
  );

  // 起動直後、購読より先に表示された回のイベントは取りこぼしている。
  // 表示中なら送り直してもらう。
  await invoke("request_small_anchor");

  // 隠れたことを検知できない環境では、次の表示で位置が届くまで前回のツノが
  // 残るだけなので、取れなくても実害は無い。
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      arrow.classList.remove("anchored");
    }
  });
}

window.addEventListener("load", async () => {
  // ツノはターミナルの起動に必須ではないので、失敗しても初期化は続ける。
  // 位置が二度と届かなくなるため、この時だけは既定位置のツノを出しておく。
  try {
    await trackAnchor();
  } catch (e) {
    console.error("Failed to subscribe to the anchor event:", e);
    arrow.classList.add("anchored");
  }

  try {
    const config = await loadConfig();
    applyTerminalBackground(config);
    await initTabs(
      {
        tabContainer: document.getElementById("tabs")!,
        terminalsContainer,
        newTabButton: document.getElementById("new-tab")!,
      },
      config,
    );
  } catch (e) {
    showStartupError(terminalsContainer, e);
  }
});
