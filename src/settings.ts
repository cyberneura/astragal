// The Settings window (CYBERNEURA-DEV-1297). Edits ~/.config/astragal/config.yaml through
// the settings_* commands in src-tauri/src/settings.rs.
//
// - Shows the values in the local file, never the values merged from
//   config_override_command. Keys the command overrides are read-only here, and the Rust
//   side keeps the file's value for them when saving.
// - API keys never come to the webview. The secret fields only say whether a key is set,
//   and send "keep" / "set" / "clear" back.
// - Saving rewrites the whole file from the form (comments are lost; the first save keeps
//   <name>.bak). Open Config File and Edit as Text stay available as escape hatches.
// - Astragal reads its config once at startup, so saved settings apply after a restart.
import { invoke } from "@tauri-apps/api/core";
import {
  formatMap,
  getPath,
  isOverridden,
  OP_READ_EXAMPLE,
  overrideYamlSnippet,
  parseLines,
  parseMap,
  recordShortcut,
  setPath,
} from "./settings-fields.ts";

type Config = Record<string, unknown>;

interface SecretState {
  in_file: boolean;
  overridden: boolean;
}

interface ResolvedWindow {
  width: number;
  height: number;
  hide_on_blur: boolean;
}

interface Snapshot {
  path: string;
  error: string | null;
  config: Config | null;
  defaults: Config;
  window_defaults: { main: ResolvedWindow; small: ResolvedWindow };
  override_command: string;
  overridden: string[];
  ai_api_key: SecretState;
  tab_summary_api_key: SecretState;
  has_comments: boolean;
  min_interval_seconds: number;
  max_context_turns: number;
}

type SecretChange = { action: "keep" } | { action: "set"; value: string } | { action: "clear" };

interface FieldError {
  path: string;
  message: string;
}

type SaveError = { kind: "invalid"; errors: FieldError[] } | { kind: "failed"; message: string };

interface SaveOutcome {
  backup: string | null;
}

type FieldKind =
  | "text"
  | "optional-text"
  | "float"
  | "integer"
  | "optional-number"
  | "checkbox"
  | "window-bool"
  | "select"
  | "lines"
  | "env"
  | "theme"
  | "hotkey"
  | "secret";

interface FieldSpec {
  path: string;
  label: string;
  help: string;
  kind: FieldKind;
  options?: Array<[string, string]>;
  placeholder?: string;
}

interface Section {
  title: string;
  note?: string;
  fields: FieldSpec[];
}

const IS_MAC = navigator.userAgent.includes("Mac");

const SECTIONS: Section[] = [
  {
    title: "Font",
    fields: [
      {
        path: "font.family",
        label: "Font family",
        help: "CSS font-family list, tried from left to right. Keep a CJK font in the fallbacks.",
        kind: "text",
      },
      { path: "font.size", label: "Font size", help: "In points.", kind: "float" },
    ],
  },
  {
    title: "Shell",
    fields: [
      {
        path: "shell.command",
        label: "Command",
        help: IS_MAC
          ? "The shell to start. Empty uses $SHELL, then /bin/zsh."
          : "The shell to start. Empty uses powershell.exe.",
        kind: "optional-text",
        placeholder: "Default",
      },
      {
        path: "shell.args",
        label: "Arguments",
        help: "One per line. The default -l starts a login shell so PATH includes Homebrew and the like.",
        kind: "lines",
      },
      {
        path: "shell.env",
        label: "Environment",
        help: "Extra environment variables, one NAME=value per line.",
        kind: "env",
        placeholder: "LANG=ja_JP.UTF-8",
      },
    ],
  },
  {
    title: "Terminal",
    fields: [
      {
        path: "terminal.close_on_exit",
        label: "Close the tab when the shell exits",
        help: "Turn off to keep the tab open so the output can still be read and copied.",
        kind: "checkbox",
      },
    ],
  },
  {
    title: "Windows",
    fields: [
      { path: "window.main.width", label: "Main window width", help: "Empty uses the default.", kind: "optional-number" },
      { path: "window.main.height", label: "Main window height", help: "Empty uses the default.", kind: "optional-number" },
      {
        path: "window.main.hide_on_blur",
        label: "Hide the main window when it loses focus",
        help: "Off by default.",
        kind: "window-bool",
      },
      {
        path: "window.small.width",
        label: "Small window width",
        help: "The popover that drops down from the menu bar icon.",
        kind: "optional-number",
      },
      { path: "window.small.height", label: "Small window height", help: "Empty uses the default.", kind: "optional-number" },
      {
        path: "window.small.hide_on_blur",
        label: "Hide the small window when it loses focus",
        help: "On by default.",
        kind: "window-bool",
      },
    ],
  },
  {
    title: "Global hotkeys",
    note: "Click a field and press the keys. Backspace disables the hotkey, Escape cancels.",
    fields: [
      { path: "hotkeys.window", label: "Show the main window", help: "Works from any app.", kind: "hotkey" },
      { path: "hotkeys.small_window", label: "Show the small window", help: "Works from any app.", kind: "hotkey" },
    ],
  },
  {
    title: "Theme",
    fields: [
      {
        path: "theme",
        label: "Colors",
        help: "xterm theme keys, one name: value per line (background, foreground, cursor, red…). Only these override the default theme.",
        kind: "theme",
        placeholder: "background: #111111",
      },
    ],
  },
  {
    title: "Ask AI",
    note: "Cmd+I (Ctrl+Shift+I on Windows) asks Claude for a shell command and types it into the prompt for you to review. It never runs anything.",
    fields: [
      { path: "ai.enabled", label: "Enable Ask AI", help: "Sends your request, the OS and shell names, and the selected text to Anthropic.", kind: "checkbox" },
      { path: "ai.api_key", label: "Anthropic API key", help: "Empty uses the ANTHROPIC_API_KEY environment variable.", kind: "secret" },
      { path: "ai.model", label: "Model", help: "Claude model ID.", kind: "text" },
      { path: "ai.effort", label: "Effort", help: 'Sent as output_config.effort. Leave empty for models without effort (claude-haiku-4-5).', kind: "text" },
    ],
  },
  {
    title: "Tab names and summaries",
    note: "When on, the last ~120 lines of each tab that printed something are sent to the provider.",
    fields: [
      { path: "tab_summary.enabled", label: "Name and summarize tabs", help: "Off by default.", kind: "checkbox" },
      {
        path: "tab_summary.provider",
        label: "Provider",
        help: "CLI providers use your subscription; fm runs on the Mac; openai / anthropic need an API key.",
        kind: "select",
        options: [
          ["claude-code", "Claude Code CLI"],
          ["codex", "Codex CLI"],
          ["fm", "Apple Foundation Models (on-device)"],
          ["openai", "OpenAI API"],
          ["anthropic", "Anthropic API"],
        ],
      },
      {
        path: "tab_summary.display",
        label: "Show the summary as",
        help: "A tooltip on the tab, or two lines under the tab bar.",
        kind: "select",
        options: [
          ["tooltip", "Tooltip"],
          ["bar", "Bar under the tabs"],
        ],
      },
      { path: "tab_summary.model", label: "Model", help: "Empty uses the provider's default.", kind: "text", placeholder: "Default" },
      { path: "tab_summary.command", label: "CLI command", help: "Path or name of claude / codex / fm. Empty uses the usual name.", kind: "text", placeholder: "Default" },
      { path: "tab_summary.api_key", label: "API key (openai / anthropic)", help: "Empty uses OPENAI_API_KEY, or for anthropic the Ask AI key / ANTHROPIC_API_KEY.", kind: "secret" },
      { path: "tab_summary.interval_seconds", label: "Minimum interval (seconds)", help: "The shortest time between two updates of the same tab.", kind: "integer" },
    ],
  },
  {
    title: "Agent chat",
    note: "The chat pane of the main window, using your Claude Code / Codex CLI login.",
    fields: [
      { path: "agent_chat.enabled", label: "Enable agent chat", help: "Nothing is sent until you submit a message.", kind: "checkbox" },
      {
        path: "agent_chat.provider",
        label: "Provider",
        help: "The CLI the chat starts.",
        kind: "select",
        options: [
          ["claude", "Claude Code"],
          ["codex", "Codex"],
        ],
      },
      { path: "agent_chat.context_turns", label: "Commands to include", help: "Completed commands sent with each message (0-20).", kind: "integer" },
      { path: "agent_chat.blacklist", label: "Blacklist", help: "One case-insensitive text per line. Commands containing it are never sent.", kind: "lines" },
      { path: "agent_chat.auto_paste", label: "Paste suggested commands", help: "Types the agent's command into the prompt. Never presses Enter.", kind: "checkbox" },
    ],
  },
];

const OVERRIDE_PATH = "config_override_command";

// ── State ────────────────────────────────────────────────────────────────────

let snapshot: Snapshot;
let draft: Config = {};
let overrideCommand = "";
const secretChanges: Record<string, SecretChange> = {};
/** Per-field errors found while typing (they block saving). */
const inputErrors = new Map<string, string>();
/** Per-field errors returned by the last save. Cleared when the field changes. */
const saveErrors = new Map<string, string>();
const fieldRenderers = new Map<string, () => void>();
let commentsConfirmed = false;
let dirty = false;

const root = document.getElementById("settings")!;
const statusLine = document.getElementById("settings-status")!;

// ── Small DOM helpers ────────────────────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of children) node.append(child);
  return node;
}

function button(label: string, onClick: () => void, className = ""): HTMLButtonElement {
  const node = el("button", { type: "button", textContent: label, className });
  node.addEventListener("click", onClick);
  return node;
}

function copyButton(text: () => string): HTMLButtonElement {
  const node = button("Copy", () => {
    navigator.clipboard
      .writeText(text())
      .then(() => {
        node.textContent = "Copied";
        setTimeout(() => (node.textContent = "Copy"), 1500);
      })
      .catch(() => {
        node.textContent = "Copy failed";
      });
  });
  return node;
}

function setStatus(text: string, kind: "info" | "error" | "ok" = "info"): void {
  statusLine.textContent = text;
  statusLine.dataset.kind = kind;
}

/** A modal yes/no question. window.confirm is not reliable in every webview. */
function ask(message: string, confirmLabel: string): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = el("dialog", { className: "settings-dialog" });
    const done = (answer: boolean) => {
      dialog.close();
      dialog.remove();
      resolve(answer);
    };
    dialog.append(
      el("p", { textContent: message }),
      el("div", { className: "settings-dialog-buttons" }, [
        button("Cancel", () => done(false)),
        button(confirmLabel, () => done(true), "primary"),
      ]),
    );
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      done(false);
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}

// ── Values ───────────────────────────────────────────────────────────────────

function defaultValue(path: string): unknown {
  if (path.startsWith("window.")) return null;
  if (path.startsWith("hotkeys.")) return getPath(snapshot.defaults, path);
  return structuredClone(getPath(snapshot.defaults, path));
}

function windowDefault(path: string): ResolvedWindow[keyof ResolvedWindow] {
  const [, which, key] = path.split(".") as [string, "main" | "small", keyof ResolvedWindow];
  return snapshot.window_defaults[which][key];
}

function markChanged(path: string): void {
  dirty = true;
  saveErrors.delete(path);
  updateSaveButton();
}

function locked(path: string): boolean {
  return isOverridden(path, snapshot.overridden);
}

// ── Fields ───────────────────────────────────────────────────────────────────

function renderField(spec: FieldSpec): HTMLElement {
  const row = el("div", { className: "field" });
  const control = el("div", { className: "field-control" });
  const error = el("p", { className: "field-error" });
  const isLocked = locked(spec.path);
  const labelText = el("span", { className: "field-label", textContent: spec.label });
  const header = el("div", { className: "field-header" }, [labelText]);
  if (spec.kind !== "secret") {
    const reset = button("Default", () => {
      setPath(draft, spec.path, defaultValue(spec.path));
      inputErrors.delete(spec.path);
      markChanged(spec.path);
      rerender();
    }, "link");
    reset.title = "Reset to the default value";
    reset.disabled = isLocked;
    header.append(reset);
  }
  row.append(header, el("p", { className: "field-help", textContent: spec.help }), control, error);
  // The secret field explains the override itself (no file value is shown there)
  if (isLocked && spec.kind !== "secret") {
    row.classList.add("locked");
    row.append(
      el("p", {
        className: "field-locked",
        textContent:
          "Overridden by 1Password (config_override_command). The value shown is the one in the config file; change the override to change it.",
      }),
    );
  }

  const rerender = () => {
    control.replaceChildren(buildControl(spec, isLocked, () => showError()));
    showError();
  };
  const showError = () => {
    const message = inputErrors.get(spec.path) ?? saveErrors.get(spec.path) ?? "";
    error.textContent = message;
    row.classList.toggle("invalid", message !== "");
  };
  fieldRenderers.set(spec.path, rerender);
  rerender();
  return row;
}

function buildControl(spec: FieldSpec, isLocked: boolean, refreshError: () => void): HTMLElement {
  const value = getPath(draft, spec.path);
  const update = (next: unknown, error?: string) => {
    if (error) {
      inputErrors.set(spec.path, error);
    } else {
      inputErrors.delete(spec.path);
      setPath(draft, spec.path, next);
    }
    markChanged(spec.path);
    refreshError();
  };

  switch (spec.kind) {
    case "text":
    case "optional-text": {
      const input = el("input", {
        type: "text",
        value: (value as string | null) ?? "",
        placeholder: spec.placeholder ?? "",
        disabled: isLocked,
        spellcheck: false,
      });
      input.addEventListener("input", () => {
        const text = input.value;
        update(spec.kind === "optional-text" && text.trim() === "" ? null : text);
      });
      return input;
    }
    case "float":
    case "integer":
    case "optional-number": {
      const input = el("input", {
        type: "number",
        value: value === null || value === undefined ? "" : String(value),
        step: spec.kind === "integer" ? "1" : "any",
        disabled: isLocked,
      });
      if (spec.kind === "optional-number") {
        input.placeholder = `Default (${windowDefault(spec.path)})`;
      }
      input.addEventListener("input", () => {
        const text = input.value.trim();
        if (text === "") {
          if (spec.kind === "optional-number") return update(null);
          return update(null, "Enter a number.");
        }
        const number = Number(text);
        if (!Number.isFinite(number)) return update(null, "Enter a number.");
        if (spec.kind === "integer" && !Number.isInteger(number)) return update(null, "Enter a whole number.");
        const problem = numberProblem(spec.path, number);
        update(number, problem);
      });
      return input;
    }
    case "checkbox":
    case "window-bool": {
      const checked = spec.kind === "window-bool" ? ((value as boolean | null) ?? (windowDefault(spec.path) as boolean)) : Boolean(value);
      const input = el("input", { type: "checkbox", checked, disabled: isLocked });
      input.addEventListener("change", () => {
        if (spec.kind === "window-bool") {
          // The default differs per window; write a value only when it differs from it
          update(input.checked === windowDefault(spec.path) ? null : input.checked);
        } else {
          update(input.checked);
        }
      });
      return el("label", { className: "checkbox" }, [input, "On"]);
    }
    case "select": {
      const select = el("select", { disabled: isLocked });
      for (const [optionValue, label] of spec.options ?? []) {
        select.append(el("option", { value: optionValue, textContent: label, selected: optionValue === value }));
      }
      select.addEventListener("change", () => update(select.value));
      return select;
    }
    case "lines": {
      const area = el("textarea", {
        value: ((value as string[] | undefined) ?? []).join("\n"),
        rows: 3,
        disabled: isLocked,
        spellcheck: false,
      });
      area.addEventListener("input", () => update(parseLines(area.value)));
      return area;
    }
    case "env":
    case "theme": {
      const separator = spec.kind === "env" ? "=" : ":";
      const area = el("textarea", {
        value: formatMap((value as Record<string, string> | undefined) ?? {}, separator),
        rows: 4,
        placeholder: spec.placeholder ?? "",
        disabled: isLocked,
        spellcheck: false,
      });
      area.addEventListener("input", () => {
        const parsed = parseMap(area.value, separator);
        if (parsed.ok) update(parsed.value);
        else update(null, parsed.message);
      });
      return area;
    }
    case "hotkey":
      return hotkeyControl(spec, isLocked, update);
    case "secret":
      return secretControl(spec);
  }
}

function numberProblem(path: string, value: number): string | undefined {
  if (path === "tab_summary.interval_seconds" && value < snapshot.min_interval_seconds) {
    return `Must be at least ${snapshot.min_interval_seconds} seconds.`;
  }
  if (path === "agent_chat.context_turns" && (value < 0 || value > snapshot.max_context_turns)) {
    return `Must be between 0 and ${snapshot.max_context_turns}.`;
  }
  if ((path === "font.size" || path.startsWith("window.")) && value <= 0) {
    return "Must be greater than 0.";
  }
  return undefined;
}

function hotkeyControl(
  spec: FieldSpec,
  isLocked: boolean,
  update: (next: unknown, error?: string) => void,
): HTMLElement {
  const current = () => ((getPath(draft, spec.path) as string | null) ?? "").trim();
  const shown = () => current() || "Disabled";
  const input = el("input", {
    type: "text",
    readOnly: true,
    value: shown(),
    disabled: isLocked,
    className: "hotkey",
  });
  input.addEventListener("focus", () => {
    input.value = "Press keys…";
  });
  input.addEventListener("blur", () => {
    // Leaving the field drops a rejected key press; the recorded value stays as it was
    if (inputErrors.has(spec.path)) update(getPath(draft, spec.path));
    input.value = shown();
  });
  input.addEventListener("keydown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const result = recordShortcut(event);
    switch (result.kind) {
      case "pending":
        return;
      case "cancel":
        input.blur();
        return;
      case "clear":
        update("");
        input.value = shown();
        input.blur();
        return;
      case "error":
        update(getPath(draft, spec.path), result.message);
        return;
      case "shortcut":
        update(result.value);
        input.value = shown();
        input.blur();
        return;
    }
  });
  const disable = button("Disable", () => {
    update("");
    input.value = shown();
  });
  disable.disabled = isLocked;
  return el("div", { className: "row" }, [input, disable]);
}

function secretControl(spec: FieldSpec): HTMLElement {
  const state = spec.path === "ai.api_key" ? snapshot.ai_api_key : snapshot.tab_summary_api_key;
  const box = el("div", { className: "secret" });
  if (state.overridden) {
    box.append(
      el("p", {
        className: "secret-status",
        textContent: "Provided by 1Password (config_override_command). Change it there; it is never written to this file.",
      }),
    );
    return box;
  }

  const status = el("p", { className: "secret-status" });
  const describe = () => {
    const change = secretChanges[spec.path] ?? { action: "keep" };
    status.textContent =
      change.action === "set"
        ? "A new key will be saved in the config file."
        : change.action === "clear"
          ? "The key will be removed from the config file."
          : state.in_file
            ? "A key is written in the config file (not shown)."
            : "Not set in the config file.";
  };
  const setChange = (change: SecretChange) => {
    secretChanges[spec.path] = change;
    markChanged(spec.path);
    describe();
  };

  // Keep what the user chose and typed when the form is redrawn (after a rejected save)
  const pending = secretChanges[spec.path];
  const useDirect = state.in_file || pending?.action === "set";
  const name = `secret-${spec.path}`;
  const viaOp = el("input", { type: "radio", name, checked: !useDirect });
  const direct = el("input", { type: "radio", name, checked: useDirect });

  const opPanel = el("div", { className: "secret-panel" }, [
    el("p", { textContent: "1. Save this YAML in a 1Password item (for example as a text field or note):" }),
    el("div", { className: "row" }, [
      el("pre", { textContent: overrideYamlSnippet(spec.path) }),
      copyButton(() => overrideYamlSnippet(spec.path)),
    ]),
    el("p", { textContent: "If other settings come from 1Password too, put them in the same YAML." }),
    el("p", { textContent: "2. Set config_override_command (at the bottom of this window) to read it:" }),
    el("div", { className: "row" }, [
      el("code", { textContent: OP_READ_EXAMPLE }),
      copyButton(() => OP_READ_EXAMPLE),
      button("Use this command", () => {
        if (!overrideCommand.trim()) {
          overrideCommand = OP_READ_EXAMPLE;
          markChanged(OVERRIDE_PATH);
          fieldRenderers.get(OVERRIDE_PATH)?.();
        }
        document.getElementById("override-command")?.focus();
      }),
    ]),
  ]);
  if (state.in_file) {
    opPanel.append(
      el("div", { className: "row" }, [
        el("span", { textContent: "The key written in the config file stays until you remove it." }),
        button("Remove from file", () => setChange({ action: "clear" })),
      ]),
    );
  }

  const keyInput = el("input", {
    type: "password",
    value: pending?.action === "set" ? pending.value : "",
    placeholder: state.in_file ? "Leave empty to keep the current key" : "Paste the API key",
    autocomplete: "off",
    spellcheck: false,
  });
  keyInput.addEventListener("input", () =>
    setChange(keyInput.value.trim() ? { action: "set", value: keyInput.value } : { action: "keep" }),
  );
  const directPanel = el("div", { className: "secret-panel" }, [
    el("p", { textContent: "The key is saved in plain text in the config file." }),
    el("div", { className: "row" }, [
      keyInput,
      ...(state.in_file ? [button("Remove from file", () => {
        keyInput.value = "";
        setChange({ action: "clear" });
      })] : []),
    ]),
  ]);

  const sync = () => {
    opPanel.hidden = !viaOp.checked;
    directPanel.hidden = !direct.checked;
    // Switching to 1Password discards a key typed into the direct field
    if (viaOp.checked && secretChanges[spec.path]?.action === "set") {
      keyInput.value = "";
      setChange({ action: "keep" });
    }
  };
  viaOp.addEventListener("change", sync);
  direct.addEventListener("change", sync);
  box.append(
    status,
    el("label", { className: "radio" }, [viaOp, "Get it from 1Password (recommended)"]),
    el("label", { className: "radio" }, [direct, "Enter it directly"]),
    opPanel,
    directPanel,
  );
  describe();
  sync();
  return box;
}

function renderOverrideCommand(): HTMLElement {
  const row = el("div", { className: "field" });
  const control = el("div", { className: "field-control" });
  const result = el("p", { className: "field-help" });
  const error = el("p", { className: "field-error" });
  row.append(
    el("div", { className: "field-header" }, [el("span", { className: "field-label", textContent: "Command" })]),
    el("p", {
      className: "field-help",
      textContent:
        "Runs at startup (without a shell); its stdout must be YAML, which is merged over this file. Use it to keep API keys in 1Password.",
    }),
    control,
    result,
    error,
  );
  const render = () => {
    const input = el("input", {
      type: "text",
      id: "override-command",
      value: overrideCommand,
      placeholder: OP_READ_EXAMPLE,
      spellcheck: false,
    });
    input.addEventListener("input", () => {
      overrideCommand = input.value;
      markChanged(OVERRIDE_PATH);
      error.textContent = "";
    });
    const test = button("Test", async () => {
      test.disabled = true;
      result.textContent = "Running… (1Password may ask for approval)";
      try {
        const count = await invoke<number>("settings_test_override", { command: input.value });
        result.textContent = `OK: it overrides ${count} key${count === 1 ? "" : "s"}. Values are not shown.`;
      } catch (e) {
        result.textContent = `Failed: ${String(e)}`;
      } finally {
        test.disabled = false;
      }
    });
    control.replaceChildren(el("div", { className: "row" }, [input, test]));
    error.textContent = saveErrors.get(OVERRIDE_PATH) ?? "";
  };
  fieldRenderers.set(OVERRIDE_PATH, render);
  render();
  return row;
}

// ── Pages ────────────────────────────────────────────────────────────────────

const saveButton = document.getElementById("settings-save") as HTMLButtonElement;
const revertButton = document.getElementById("settings-revert") as HTMLButtonElement;
const textButton = document.getElementById("settings-text") as HTMLButtonElement;

function updateSaveButton(): void {
  saveButton.disabled = snapshot.error !== null || inputErrors.size > 0 || !dirty;
  revertButton.disabled = !dirty;
  if (inputErrors.size > 0) setStatus("Fix the highlighted fields to save.", "error");
  else if (dirty) setStatus("Unsaved changes.");
}

function renderForm(): void {
  fieldRenderers.clear();
  const page = el("div", { className: "settings-form" });
  page.append(
    el("p", { className: "settings-path" }, [
      "Editing ",
      el("code", { textContent: snapshot.path }),
      ". Changes apply the next time Astragal starts.",
    ]),
  );
  for (const section of SECTIONS) {
    const block = el("section", {}, [el("h2", { textContent: section.title })]);
    if (section.note) block.append(el("p", { className: "section-note", textContent: section.note }));
    for (const field of section.fields) block.append(renderField(field));
    page.append(block);
  }
  page.append(
    el("section", {}, [
      el("h2", { textContent: "1Password (config_override_command)" }),
      renderOverrideCommand(),
    ]),
  );
  root.replaceChildren(page);
}

function renderUnreadable(): void {
  root.replaceChildren(
    el("div", { className: "settings-unreadable" }, [
      el("h2", { textContent: "The config file cannot be read" }),
      el("pre", { textContent: snapshot.error ?? "" }),
      el("p", {
        textContent:
          "Settings only edits a file it can read, so nothing in it is lost. Fix the file with Edit as Text or Open Config File, then come back.",
      }),
    ]),
  );
}

async function renderTextEditor(): Promise<void> {
  let text: string;
  try {
    text = await invoke<string>("settings_read_text");
  } catch (e) {
    setStatus(String(e), "error");
    return;
  }
  const area = el("textarea", { value: text, className: "settings-text", spellcheck: false });
  const message = el("p", { className: "field-error" });
  const save = button("Save Text", async () => {
    try {
      const outcome = await invoke<SaveOutcome>("settings_save_text", { text: area.value });
      await reload();
      announceSaved(outcome);
    } catch (e) {
      message.textContent = describeSaveError(e);
    }
  }, "primary");
  root.replaceChildren(
    el("div", { className: "settings-text-page" }, [
      el("p", {
        className: "section-note",
        textContent:
          "The file as it is, comments included. API keys written in the file are visible here. Unknown keys are not accepted.",
      }),
      area,
      message,
      el("div", { className: "row" }, [button("Back to the Form", () => void reload()), save]),
    ]),
  );
  saveButton.disabled = true;
  revertButton.disabled = true;
  textButton.disabled = true;
  setStatus("Editing the file as text.");
}

function describeSaveError(e: unknown): string {
  const error = e as SaveError | string;
  if (typeof error === "string") return error;
  if (error.kind === "failed") return error.message;
  return error.errors.map((item) => `${item.path}: ${item.message}`).join("\n");
}

function announceSaved(outcome: SaveOutcome): void {
  const backup = outcome.backup ? ` The previous file was kept as ${outcome.backup}.` : "";
  setStatus(`Saved.${backup} Restart Astragal to apply.`, "ok");
  document.getElementById("settings-restart")!.hidden = false;
}

async function save(): Promise<void> {
  if (snapshot.has_comments && !commentsConfirmed) {
    const name = snapshot.path.split(/[\\/]/).pop() ?? "config.yaml";
    const ok = await ask(
      `${name} has comments you wrote. Saving from Settings rewrites the file and removes them. ` +
        `A copy of the current file is kept as ${name}.bak if there is none yet.`,
      "Save Anyway",
    );
    if (!ok) return;
    commentsConfirmed = true;
  }
  saveErrors.clear();
  saveButton.disabled = true;
  const request = {
    config: draft,
    override_command: overrideCommand,
    ai_api_key: secretChanges["ai.api_key"] ?? { action: "keep" },
    tab_summary_api_key: secretChanges["tab_summary.api_key"] ?? { action: "keep" },
  };
  try {
    const outcome = await invoke<SaveOutcome>("settings_save", { request });
    await reload();
    announceSaved(outcome);
  } catch (e) {
    const error = e as SaveError | string;
    if (typeof error === "object" && error.kind === "invalid") {
      for (const item of error.errors) saveErrors.set(item.path, item.message);
      for (const render of fieldRenderers.values()) render();
      setStatus("Not saved: fix the highlighted fields.", "error");
    } else {
      setStatus(`Not saved: ${describeSaveError(e)}`, "error");
    }
    updateSaveButtonAfterError();
  }
}

function updateSaveButtonAfterError(): void {
  saveButton.disabled = inputErrors.size > 0;
}

async function reload(): Promise<void> {
  snapshot = await invoke<Snapshot>("settings_snapshot");
  draft = structuredClone(snapshot.config ?? {});
  overrideCommand = snapshot.override_command;
  for (const key of Object.keys(secretChanges)) delete secretChanges[key];
  inputErrors.clear();
  saveErrors.clear();
  dirty = false;
  textButton.disabled = false;
  if (snapshot.error) {
    renderUnreadable();
    setStatus("The config file has an error.", "error");
  } else {
    renderForm();
    setStatus("");
  }
  updateSaveButton();
}

// ── Start ────────────────────────────────────────────────────────────────────

window.addEventListener("load", async () => {
  saveButton.addEventListener("click", () => void save());
  revertButton.addEventListener("click", () => void reload());
  textButton.addEventListener("click", () => void renderTextEditor());
  document.getElementById("settings-open")!.addEventListener("click", () => {
    invoke("settings_open_file").catch((e: unknown) => setStatus(`Could not open the file: ${String(e)}`, "error"));
  });
  document.getElementById("settings-restart")!.addEventListener("click", async () => {
    if (await ask("Restart Astragal now? All open tabs and their shells are closed.", "Restart")) {
      invoke("settings_restart").catch((e: unknown) => setStatus(String(e), "error"));
    }
  });
  try {
    await reload();
  } catch (e) {
    setStatus(`Could not load the settings: ${String(e)}`, "error");
  }
  // Show the window only after the DOM is filled (the webview starts white). Not inside
  // requestAnimationFrame: WebKit stops frames for hidden pages, so it would never show.
  invoke("settings_window_ready").catch((e: unknown) => {
    console.error("astragal: failed to show the settings window", e);
  });
});
