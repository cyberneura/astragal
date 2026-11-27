import { applyTerminalBackground, loadConfig, showStartupError } from "./terminal";
import { initAgentChat } from "./chat/pane";
import { getActiveSession, initTabs } from "./tabs";
import { initCommandSuggest } from "./command-suggest";
import { applyPlatformClass } from "./platform";
import { initMouseIntegration } from "./mouse-integration";

applyPlatformClass();

const terminalsContainer = document.getElementById("terminals")!;

window.addEventListener("load", async () => {
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
    // ↓ のコマンド提案は main だけ (OSC 133 の境界を入れるのは main の zsh だけ)
    initCommandSuggest(terminalsContainer, config.command_suggest, config.agent_chat.blacklist, getActiveSession);
    // タブより先に状態を読む必要は無い (後から届いた状態は開いているタブ全部に反映する)。
    // 失敗してもタブとチャットは動かしたいので、待たずに続ける
    initMouseIntegration(document.getElementById("mouse-toggle") as HTMLButtonElement).catch(console.error);
    await initAgentChat(config, getActiveSession);
  } catch (e) {
    showStartupError(terminalsContainer, e);
  }
});
