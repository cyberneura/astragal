// Pure helpers for the Settings window (settings.ts). No DOM or Tauri imports, so
// `pnpm test:settings` can run them under node.

/** A key event, reduced to what the hotkey recorder needs. */
export interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

export type RecordResult =
  | { kind: "shortcut"; value: string }
  | { kind: "pending" }
  | { kind: "cancel" }
  | { kind: "clear" }
  | { kind: "error"; message: string };

const MODIFIER_KEYS = new Set(["Control", "Alt", "Shift", "Meta", "OS", "AltGraph", "CapsLock", "Fn"]);

/**
 * Turns a keydown into a global shortcut string in the format config.yaml uses
 * ("Control+Option+Command+A"). The key comes from `code` (the physical key), which is
 * what the global-hotkey crate registers, so the result does not depend on the layout.
 */
export function recordShortcut(event: KeyLike): RecordResult {
  const modifiers = [
    event.ctrlKey ? "Control" : "",
    event.altKey ? "Option" : "",
    event.shiftKey ? "Shift" : "",
    event.metaKey ? "Command" : "",
  ].filter(Boolean);
  if (MODIFIER_KEYS.has(event.key) || event.code === "" || event.code === "Unidentified") {
    return { kind: "pending" };
  }
  if (modifiers.length === 0) {
    if (event.key === "Escape") return { kind: "cancel" };
    if (event.key === "Backspace" || event.key === "Delete") return { kind: "clear" };
  }
  const key = keyName(event.code);
  const isFunctionKey = /^F\d{1,2}$/.test(key);
  if (modifiers.length === 0 && !isFunctionKey) {
    return {
      kind: "error",
      message: "Use at least one modifier (Control, Option, Shift or Command), or a function key.",
    };
  }
  return { kind: "shortcut", value: [...modifiers, key].join("+") };
}

/** "KeyA" -> "A", "Digit1" -> "1"; other codes ("F5", "Space", "ArrowUp", "Comma") as they are. */
export function keyName(code: string): string {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  const digit = /^Digit(\d)$/.exec(code);
  if (digit) return digit[1];
  return code;
}

/** One entry per non-empty line, trimmed. */
export function parseLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

export type ParsedMap = { ok: true; value: Record<string, string> } | { ok: false; message: string };

/**
 * Parses "NAME<separator>value" lines into a map. The first separator splits; the value
 * keeps everything after it (so values may contain the separator). Duplicate names are an
 * error rather than "last wins", so a typo does not silently drop a line.
 *
 * Environment variables (`=`) keep their value exactly, including spaces and an empty
 * value (`EMPTY=` is a valid variable). Theme entries (`:`) are trimmed and need a value.
 */
export function parseMap(text: string, separator: "=" | ":"): ParsedMap {
  const value: Record<string, string> = {};
  const lines = text.split("\n");
  const exact = separator === "=";
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index];
    if (raw.trim() === "") continue;
    const line = exact ? raw.replace(/^\s+/, "") : raw.trim();
    const at = line.indexOf(separator);
    if (at <= 0) {
      return { ok: false, message: `Line ${index + 1}: write it as name${exact ? "=" : ": "}value.` };
    }
    const name = line.slice(0, at).trim();
    const entry = exact ? line.slice(at + 1) : line.slice(at + 1).trim();
    if (name === "" || (!exact && entry === "")) {
      return { ok: false, message: `Line ${index + 1}: both the name and the value are needed.` };
    }
    if (Object.prototype.hasOwnProperty.call(value, name)) {
      return { ok: false, message: `Line ${index + 1}: ${name} appears more than once.` };
    }
    value[name] = entry;
  }
  return { ok: true, value };
}

export function formatMap(map: Record<string, string>, separator: "=" | ":"): string {
  const glue = separator === "=" ? "=" : ": ";
  return Object.entries(map)
    .map(([name, value]) => `${name}${glue}${value}`)
    .join("\n");
}

/**
 * Whether a field is controlled by config_override_command. `overridden` holds the dotted
 * leaf paths the command printed. A field is locked when it, one of its parents, or one of
 * its children is overridden (a map such as `theme` is edited as a whole).
 */
export function isOverridden(path: string, overridden: readonly string[]): boolean {
  return overridden.some(
    (key) => key === path || key.startsWith(`${path}.`) || path.startsWith(`${key}.`),
  );
}

export function getPath(root: unknown, path: string): unknown {
  let node: unknown = root;
  for (const part of path.split(".")) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

export function setPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let node = root;
  for (const part of parts.slice(0, -1)) {
    const next = node[part];
    if (next === null || typeof next !== "object") {
      node[part] = {};
    }
    node = node[part] as Record<string, unknown>;
  }
  node[parts[parts.length - 1]] = value;
}

/** The YAML to put in 1Password for one secret, ready to paste into a note or field. */
export function overrideYamlSnippet(path: string): string {
  const [section, key] = path.split(".");
  return `${section}:\n  ${key}: "<paste the API key here>"\n`;
}

export const OP_READ_EXAMPLE = 'op read "op://<vault>/<item>/<field>"';
