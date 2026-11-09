// Adapted from Beckwell (Cyberneura), MIT. See docs/beckwell-chat.md.
// 整形済みテキスト (コードブロック・ツールの入出力) のコピーボタン。
// ボタンは .code-block の中に <pre> と並べて置く。Markdown は HTML の文字列で出すので、
// クリックは会話の要素で 1 つにまとめて受ける (handleCopyClick)

export const COPY_BUTTON_CLASS = 'copy-code';
// コピーした後にチェックマークを見せておく時間
export const COPIED_MS = 3000;

// ボタンの HTML。アイコンは CSS で描く (中身を空にして、会話の検索や選択したテキストに混ぜない)
export const COPY_BUTTON_HTML = `<button type="button" class="${COPY_BUTTON_CLASS}" title="Copy" aria-label="Copy"></button>`;

// チェックマークを外すタイマー。続けて押した時に、前のタイマーで早く外れないようにする
const resetTimers = new WeakMap<Element, ReturnType<typeof setTimeout>>();

async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // 権限などで拒まれた時は、下の古い方法を試す
    }
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  try {
    textarea.select();
    if (!document.execCommand('copy')) throw new Error('execCommand("copy") failed');
  } finally {
    textarea.remove();
  }
}

// コピーボタンのクリックなら、隣の <pre> の中身をコピーして true を返す
export function handleCopyClick(event: MouseEvent): boolean {
  const button = (event.target as Element | null)?.closest?.(`button.${COPY_BUTTON_CLASS}`);
  if (!button) return false;
  event.preventDefault();
  const pre = button.closest('.code-block')?.querySelector(':scope > pre');
  if (!pre) return true;
  writeClipboard(pre.textContent ?? '').then(
    () => {
      clearTimeout(resetTimers.get(button));
      button.classList.add('copied');
      button.setAttribute('title', 'Copied');
      resetTimers.set(
        button,
        setTimeout(() => {
          button.classList.remove('copied');
          button.setAttribute('title', 'Copy');
          resetTimers.delete(button);
        }, COPIED_MS),
      );
    },
    (e) => console.error('Failed to copy:', e),
  );
  return true;
}
