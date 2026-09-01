import { fitSession, loadConfig, startSession, writeConfigWarning } from "./terminal";
import type { Session } from "./terminal";

let session: Session | null = null;

const terminalsContainer = document.getElementById("terminals")!;

window.addEventListener("load", async () => {
  const config = await loadConfig();

  const element = document.createElement("div");
  element.className = "terminal-container";
  terminalsContainer.appendChild(element);

  try {
    session = await startSession(element, config);
  } catch (e) {
    console.error("Failed to create terminal:", e);
    return;
  }
  writeConfigWarning(session, config);
  fitSession(session);
  session.terminal.focus();
});

window.addEventListener("resize", () => {
  const current = session;
  if (current) {
    setTimeout(() => fitSession(current), 10);
  }
});
