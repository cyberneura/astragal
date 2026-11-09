# Beckwell chat engine

Astragal vendors the local chat protocol engine from Cyberneura's Beckwell,
revision `d9c5c3456cd1bf3fdedb7f050a28e6cc33560983` (Beckwell 0.37.0).
Beckwell declares the MIT license in its README and package.json. The source is
copied into this repository so building Astragal does not require access to the
Beckwell repository.

- `src/chat/beckwell/`: Claude stream-json, Codex app-server JSON-RPC, common chat
  items, questions, history decoding, sanitized Markdown and code copying.
- `src-tauri/src/agent_process.rs`: adapted process supervision, JSON pipe relay,
  generation IDs, graceful termination and exit cleanup.
- `src/chat/pane.ts`: Astragal's DOM renderer and terminal integration. Beckwell's
  Svelte UI is not required. Tool approvals, questions, reasoning, streaming text,
  Markdown and usage information use its common chat items.

Local adaptations: Codex identifies the client as Astragal and advertises working
directory support through `ChatProtocol.supportsWorkingDirectory`. Its `send`
accepts an optional `cwd`, sent with `turn/start` on the existing thread; the host
directory is updated only when that request succeeds. This uses the installed
app-server's `TurnStartParams.cwd` override for the current and subsequent turns.
Claude does not advertise runtime directory changes and does not mark the
connection ready if initialization cannot be written. The Rust launcher
supports local agents only, uses Astragal's configured login shell, scopes events
and commands to `main`, and does not enable Chrome integration or bypass
permissions. History selection, remote targets and persistent attachments are not
exposed in this UI. The upstream parsers retain their history support.

Result items additionally expose `finalText` for terminal writeback. Claude uses
the successful result's text. Codex excludes commentary/partial-answer phases and
uses the last completed answer; when phase is absent, later tool/reasoning activity
invalidates that candidate. The pane records approval/question decisions before
writing responses, and the protocols restore pending decisions on write failure.
Codex process recovery after Stop resumes the existing thread and keeps the visible
transcript. `ProtocolOptions.replayHistory: false` suppresses server history replay
when the host already retains those items; explicit New chat starts a fresh thread.

When updating the vendored files, preserve these adaptations, run `pnpm test:chat`
and `pnpm build`, and exercise both providers. The optional live tests
`node tests/agent-smoke.mjs claude` and `node tests/agent-smoke.mjs codex` send a
synthetic connectivity request using the installed CLI's login. They require
normal access to the login credentials and network. They do not send repository
or terminal contents.
Add `--follow-directory` to the Codex live test to check a second turn in a new
temporary directory while retaining the previous turn's marker. No tools or file
reads are requested.

`tests/chat-harness.html` runs the actual pane with mocked Tauri IPC under Vite.
It supplies synthetic safe and excluded turns, exercises both protocols, and
exposes sent messages and paste operations for browser assertions. It is not
included in production build inputs. Native window resizing must be verified in
Tauri separately.
