import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { initAgentChat, syncAgentChat } from "../src/chat/pane";
import { TerminalContext } from "../src/chat/context";
const osc = (s: string) => `\x1b]133;${s}\x07`;
const context = new TerminalContext();
context.feed(new TextEncoder().encode(["pnpm build\nBuild completed successfully.", "echo $API_KEY\nprivate-example", "git status --short\n M src/main.ts"].map((text) => `${osc("A")}$ ${text}${osc("C")}${osc("D")}`).join("") + osc("A")));
const sessions = [1, 2].map((id) => ({ id, context: id === 1 ? context : new TerminalContext(), terminal: { modes: { bracketedPasteMode: true }, options: {}, focus() {}, buffer: { active: { type: "normal" } }, paste(value: string) { (window as any).pastes.push({ id, value }); document.getElementById("pasted")!.textContent = value; } }, exited: false }));
(window as any).sessions = sessions;
let active = 0;
(window as any).requests = [];
(window as any).pastes = []; (window as any).sent = []; (window as any).stops = [];
(window as any).changeDirectory = (path: string) => { context.feed(new TextEncoder().encode(`\x1b]7;file://${path}\x07`)); };
(window as any).changeTerminal = () => { context.input(); };
mockWindows("main");
function message(id: number, data: unknown) { return emit("agent_event", { id, line: JSON.stringify(data) }); }
mockIPC(async (cmd, args: any) => {
  if (cmd === "agent_reset") return { highestId: 0, generation: 1 };
  if (cmd === "agent_start") return { cwd: args.cwd };
  if (cmd === "agent_stop") { (window as any).stops.push(args.id); return; }
  if (cmd !== "agent_write") return;
  const data = JSON.parse(args.line);
  (window as any).requests.push(data);
  if (data.type === "control_request") return;
  if (data.type === "user") {
    (window as any).sent.push(data.message.content);
    setTimeout(async () => {
      const reply = (window as any).agentReply ?? "The build passed. You have one changed file.\n\nReview the change with:\n```astragal-terminal\ngit diff -- src/main.ts\n```\n\n<img src=x onerror=alert(1)>";
      await message(args.id, { type: "assistant", message: { content: [{ type: "text", text: reply }] } });
      await message(args.id, { type: "result", subtype: "success", result: reply, duration_ms: 500, num_turns: 1 });
    }, 700);
  }
  if (data.method === "initialize") setTimeout(() => message(args.id, { id: data.id, result: {} }), 0);
  if (data.method === "thread/start") setTimeout(() => message(args.id, { id: data.id, result: { thread: { id: "thread-test" }, model: "Codex", cwd: "/tmp" } }), 0);
  if (data.method === "turn/start") {
    (window as any).sent.push(JSON.stringify(data.params));
    setTimeout(async () => {
      await message(args.id, { id: data.id, result: { turn: { id: "turn-test" } } });
      await message(args.id, { method: "item/completed", params: { threadId: "thread-test", item: { type: "agentMessage", id: "text-test", text: "Codex is connected." } } });
      await message(args.id, { method: "turn/completed", params: { threadId: "thread-test", turn: { id: "turn-test", status: "completed" } } });
    }, 100);
  }
}, { shouldMockEvents: true });
await initAgentChat({ agent_chat: { enabled: true, provider: "claude", context_turns: 3, blacklist: [], auto_paste: true }, home_directory: "/tmp" } as any, () => sessions[active] as any);
document.getElementById("other-tab")!.onclick = () => { active = 1 - active; syncAgentChat(); };
(window as any).ready = true;
