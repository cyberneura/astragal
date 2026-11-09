import { strict as assert } from "node:assert";
import { test } from "node:test";
import { TerminalContext, containsSecret, pasteCommand, chatPrompt, terminalInputText } from "../src/chat/context.ts";
const encode = (s: string) => new TextEncoder().encode(s);
const osc = (s: string) => `\x1b]133;${s}\x07`;
const turn = (text: string) => `${osc("A")}$ command\r\n${osc("C")}${text}${osc("D;0")}`;

test("manual code input removes the renderer newline and protects against execution controls", () => {
  assert.deepEqual(terminalInputText("echo hello\n", false), { text: "echo hello" });
  assert.deepEqual(terminalInputText("first\r\n\tsecond\r\n", true), { text: "first\n\tsecond" });
  assert.ok(terminalInputText("first\nsecond\n", false).error);
  assert.ok(terminalInputText("\tindented\n", false).error);
  for (const control of ["\x1b[201~", "\x00", "\x03", "\x7f", "\u2028"]) {
    assert.ok(terminalInputText(`echo ${control}\n`, true).error);
  }
});

test("last N completed turns are filtered as whole turns without backfilling", () => {
  const context = new TerminalContext();
  context.feed(encode(turn("older safe") + turn("safe recent") + turn("API_KEY=hidden\nother output") + turn("latest safe")));
  assert.deepEqual(context.snapshot(3, []).turns, ["$ command\nsafe recent", "$ command\nlatest safe"]);
  assert.equal(context.snapshot(3, []).excluded, 1);
  assert.equal(context.snapshot(0, []).turns.length, 0);
});
test("blacklist handles split bytes, ANSI colors and Unicode compatibility forms", () => {
  const context = new TerminalContext();
  for (const byte of encode(turn("pass\x1b[31mword=hidden") + turn("ＴＯＫＥＮ=hidden") + turn("社内ID=hidden"))) context.feed(new Uint8Array([byte]));
  assert.equal(context.snapshot(3, ["社内ID"]).excluded, 3);
  assert.equal(containsSecret("secret_value", []), true);
  assert.equal(containsSecret("MYKEY=value", ["mykey"]), true);
});
test("incomplete, unknown, and oversized turns are never sent", () => {
  const context = new TerminalContext();
  context.feed(encode("unknown password output"));
  assert.equal(context.snapshot(3, []).available, false);
  context.feed(encode(turn("x".repeat(130 * 1024)) + osc("A") + "half a command"));
  assert.deepEqual(context.snapshot(3, []).turns, []);
  assert.equal(context.snapshot(3, []).excluded, 1);
});
test("prompt revisions prevent stale writeback and distinguish running programs", () => {
  const context = new TerminalContext();
  context.feed(encode(osc("A")));
  const version = context.revision;
  assert.equal(context.atPrompt, true);
  context.input(); assert.notEqual(version, context.revision); assert.equal(context.dirty, true);
  context.feed(encode(osc("C"))); assert.equal(context.atPrompt, false);
  context.feed(encode(osc("D") + osc("A"))); assert.equal(context.dirty, false);
});
test("paste only accepts one explicit complete single-line action", () => {
  assert.equal(pasteCommand("Try:\n```astragal-terminal\nprintf 'hello'\n```"), "printf 'hello'");
  for (const value of ["```sh\nrm x\n```", "```astragal-terminal\na\nb\n```", "```astragal-terminal\na\x03b\n```", "```astragal-terminal\na\n", "```astragal-terminal\na\n```\n```astragal-terminal\nb\n```", "```astragal-terminal\na\u2028b\n```"])
    assert.equal(pasteCommand(value), null);
});
test("excluded content is absent from the entire agent request", () => {
  const context = new TerminalContext(); context.feed(encode(turn("token=never-send-this") + turn("hello")));
  const prompt = chatPrompt("Explain", context.snapshot(3, []));
  assert.equal(prompt.includes("never-send-this"), false);
  assert.equal(prompt.includes("hello"), true);
});
test("local directory notifications are decoded without adopting remote paths", () => {
  const context = new TerminalContext();
  context.feed(encode("\x1b]7;file:///tmp/a%20b%23c\x07"));
  assert.equal(context.workingDirectory, "/tmp/a b#c");
  context.feed(encode("\x1b]7;file://remote-host/root\x07"));
  assert.equal(context.workingDirectory, null);
});
