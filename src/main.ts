import { applyTerminalBackground, loadConfig, showStartupError } from "./terminal";
import { initTabs } from "./tabs";

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
  } catch (e) {
    showStartupError(terminalsContainer, e);
  }
});
