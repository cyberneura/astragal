import { applyTerminalBackground, loadConfig, showStartupError } from "./terminal";
import { initAgentChat } from "./chat/pane";
import { getActiveSession, initTabs } from "./tabs";
import { applyPlatformClass } from "./platform";

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
    await initAgentChat(config, getActiveSession);
  } catch (e) {
    showStartupError(terminalsContainer, e);
  }
});
