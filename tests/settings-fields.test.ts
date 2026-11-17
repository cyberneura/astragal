// Settings ウインドウの純粋な部品 (src/settings-fields.ts) のテスト。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatMap,
  getPath,
  isOverridden,
  keyName,
  parseLines,
  parseMap,
  recordShortcut,
  setPath,
} from "../src/settings-fields.ts";

const key = (overrides: Partial<Parameters<typeof recordShortcut>[0]>) => ({
  key: "a",
  code: "KeyA",
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...overrides,
});

test("records modifiers in the config file's order", () => {
  const result = recordShortcut(key({ ctrlKey: true, altKey: true, metaKey: true, shiftKey: true }));
  assert.deepEqual(result, { kind: "shortcut", value: "Control+Option+Shift+Command+A" });
});

test("uses the physical key, not the typed character", () => {
  // Option+A types "å" on a US layout; the shortcut is still A
  assert.deepEqual(recordShortcut(key({ key: "å", altKey: true })), {
    kind: "shortcut",
    value: "Option+A",
  });
  assert.deepEqual(recordShortcut(key({ key: "!", code: "Digit1", shiftKey: true })), {
    kind: "shortcut",
    value: "Shift+1",
  });
});

test("waits while only modifiers are held", () => {
  assert.deepEqual(recordShortcut(key({ key: "Control", code: "ControlLeft", ctrlKey: true })), {
    kind: "pending",
  });
});

test("Escape cancels and Backspace clears when no modifier is held", () => {
  assert.deepEqual(recordShortcut(key({ key: "Escape", code: "Escape" })), { kind: "cancel" });
  assert.deepEqual(recordShortcut(key({ key: "Backspace", code: "Backspace" })), { kind: "clear" });
});

test("a plain key needs a modifier, but a function key does not", () => {
  assert.equal(recordShortcut(key({})).kind, "error");
  assert.deepEqual(recordShortcut(key({ key: "F5", code: "F5" })), { kind: "shortcut", value: "F5" });
});

test("key names follow the global-hotkey spelling", () => {
  assert.equal(keyName("KeyZ"), "Z");
  assert.equal(keyName("Digit0"), "0");
  assert.equal(keyName("ArrowUp"), "ArrowUp");
  assert.equal(keyName("Comma"), "Comma");
});

test("lines are trimmed and blank lines dropped", () => {
  assert.deepEqual(parseLines(" -l \n\n-i\n"), ["-l", "-i"]);
});

test("maps keep everything after the first separator", () => {
  assert.deepEqual(parseMap("LANG=ja_JP.UTF-8\nOPTS=a=b\n", "="), {
    ok: true,
    value: { LANG: "ja_JP.UTF-8", OPTS: "a=b" },
  });
  assert.deepEqual(parseMap("background: #000000", ":"), {
    ok: true,
    value: { background: "#000000" },
  });
});

test("environment values are kept exactly, empty included", () => {
  assert.deepEqual(parseMap("EMPTY=\nPAD= a b \n", "="), {
    ok: true,
    value: { EMPTY: "", PAD: " a b " },
  });
});

test("malformed or duplicate map lines are errors", () => {
  assert.equal(parseMap("LANG", "=").ok, false);
  assert.equal(parseMap("=x", "=").ok, false);
  assert.equal(parseMap("A=1\nA=2", "=").ok, false);
  assert.equal(parseMap("background:", ":").ok, false);
});

test("maps format back to the same text", () => {
  const text = "LANG=C\nTERM=xterm";
  const parsed = parseMap(text, "=");
  assert.ok(parsed.ok);
  assert.equal(formatMap(parsed.value, "="), text);
});

test("a field is locked when it, a parent or a child is overridden", () => {
  const overridden = ["ai.api_key", "theme.background", "shell"];
  assert.ok(isOverridden("ai.api_key", overridden));
  assert.ok(isOverridden("theme", overridden));
  assert.ok(isOverridden("shell.env", overridden));
  assert.ok(!isOverridden("ai.model", overridden));
  assert.ok(!isOverridden("ai.api_key_extra", overridden));
});

test("paths read and write nested objects", () => {
  const root: Record<string, unknown> = { font: { size: 13 } };
  setPath(root, "font.size", 15);
  setPath(root, "window.main.width", 800);
  assert.equal(getPath(root, "font.size"), 15);
  assert.equal(getPath(root, "window.main.width"), 800);
  assert.equal(getPath(root, "missing.key"), undefined);
});
