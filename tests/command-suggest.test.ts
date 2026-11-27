// 次のコマンドの提案 (src/command-suggest-state.ts) の判定のテスト (CYBERNEURA-DEV-1393)。
import assert from "node:assert/strict";
import { test } from "node:test";
import { canPaste, canSuggest } from "../src/command-suggest-state.ts";

const atEmptyPrompt = { exited: false, alternateBuffer: false, atPrompt: true, dirty: false };

test("Down is taken only at an empty shell prompt", () => {
  assert.equal(canSuggest(atEmptyPrompt), true);
  // 何か打った・↑ で履歴を遡った後は、↓ をシェルの履歴操作に渡す
  assert.equal(canSuggest({ ...atEmptyPrompt, dirty: true }), false);
  // コマンドの実行中や、境界の分からないシェル
  assert.equal(canSuggest({ ...atEmptyPrompt, atPrompt: false }), false);
  // vim / less 等
  assert.equal(canSuggest({ ...atEmptyPrompt, alternateBuffer: true }), false);
  assert.equal(canSuggest({ ...atEmptyPrompt, exited: true }), false);
});

test("a suggestion is pasted only into the same untouched prompt", () => {
  const state = { ...atEmptyPrompt, active: true, revision: 7 };
  assert.equal(canPaste(state, 7), true);
  // 待つ間に打った / プロンプトが変わった
  assert.equal(canPaste({ ...state, revision: 8 }, 7), false);
  assert.equal(canPaste({ ...state, dirty: true }, 7), false);
  // タブを切り替えた
  assert.equal(canPaste({ ...state, active: false }, 7), false);
  assert.equal(canPaste({ ...state, atPrompt: false }, 7), false);
});
