// 次のコマンドの提案 (command-suggest.ts) の判定。DOM と Tauri に触らないのでテストできる

/** ↓ を横取りしてよい状態か (空のプロンプト) */
export function canSuggest(state: {
  exited: boolean;
  alternateBuffer: boolean;
  atPrompt: boolean;
  dirty: boolean;
}): boolean {
  return !state.exited && !state.alternateBuffer && state.atPrompt && !state.dirty;
}

/** 応答を貼り付けてよいか。依頼した時のタブ・プロンプトのまま何も打っていないこと */
export function canPaste(
  state: { active: boolean; exited: boolean; alternateBuffer: boolean; atPrompt: boolean; dirty: boolean; revision: number },
  requestedRevision: number,
): boolean {
  return state.active && canSuggest(state) && state.revision === requestedRevision;
}
