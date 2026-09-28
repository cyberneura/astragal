import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

window.addEventListener("load", async () => {
  try {
    document.getElementById("licenses-text")!.textContent =
      await invoke<string>("third_party_notices");
  } catch (e) {
    console.error("astragal: failed to load the third-party notices", e);
  }
  // about.ts と同じ理由で、DOM を埋めてからウインドウを出してもらう。
  invoke("licenses_window_ready").catch((e: unknown) => {
    console.error("astragal: failed to show the licenses window", e);
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      void getCurrentWebviewWindow().close();
    }
  });
});
