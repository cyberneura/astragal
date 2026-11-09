// Adapted from Beckwell (Cyberneura), MIT. See docs/beckwell-chat.md.
import DOMPurify from 'dompurify';
import { Marked, Renderer } from 'marked';
import { COPY_BUTTON_HTML } from './copy';

// 属性値とテキストのどちらにも使える形にする。文字参照 (&amp; など) は二重に変換しない
function escapeHtml(text: string): string {
  return text.replace(/&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 端末と同じく、1 つの改行をそのまま改行として見せる (breaks)
const marked = new Marked({ gfm: true, breaks: true });

const DETAILS_OPEN = /^ {0,3}<details\b[^>\n]*>/i;
const LINE_DETAILS_OPEN = /^<details\b[^>\n]*>/i;
const DETAILS_CLOSE = /<\/details\s*>/gi;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
// 引用 (>) とリストの印。本文の lexer はこれを外してから中身を読むので、その後ろの <details> やフェンスも行頭として扱う
const BLOCK_PREFIX = /^(?:[ \t]*(?:>|(?:[-*+]|\d{1,9}[.)])(?=[ \t])))*[ \t]*/;

// コードスパンを同じ長さの空白にする (一致した位置をそのまま元の行の位置に使えるように)。
// コードスパンは、同じ長さのバッククォートの並びで閉じる。長さの違う並びは中身の一部。
// 開く側の並びの先頭が \ でエスケープされていれば、その 1 文字は文字のまま (閉じる側の \ はコードの中なので効かない)
function maskCodeSpans(line: string): string {
  const runs = [...line.matchAll(/`+/g)];
  let masked = line;
  for (let i = 0; i < runs.length; i++) {
    const escaped = (/\\*$/.exec(line.slice(0, runs[i].index))?.[0].length ?? 0) % 2 === 1;
    const length = runs[i][0].length - (escaped ? 1 : 0);
    if (!length) continue;
    const j = runs.findIndex((run, k) => k > i && run[0].length === length);
    if (j === -1) continue;
    const from = runs[i].index + (escaped ? 1 : 0);
    const to = runs[j].index + length;
    masked = masked.slice(0, from) + ' '.repeat(to - from) + masked.slice(to);
    i = j;
  }
  return masked;
}

// 入れ子は 1 段ごとに中身を走査し直すので、段数を抑える。超えた分の <details> は文字のまま
const MAX_DETAILS_DEPTH = 8;
let detailsDepth = 0;

// 行頭の <details> から、対応する </details> まで。閉じていなければ (ストリーミング中) 末尾まで。
// 本文のコード (フェンス・コードスパン) の中のタグは数えない。開くタグは、ブロックになる行頭のものだけを数える
function findDetailsBlock(src: string): { raw: string; body: string } | null {
  const open = DETAILS_OPEN.exec(src);
  if (!open) return null;
  let depth = 0;
  let fence = '';
  for (let start = 0; start < src.length; ) {
    const newline = src.indexOf('\n', start);
    const end = newline === -1 ? src.length : newline;
    const line = src.slice(start, end);
    const prefix = BLOCK_PREFIX.exec(line)?.[0].length ?? 0;
    const content = line.slice(prefix);
    if (fence) {
      const marker = FENCE_CLOSE.exec(content)?.[1];
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = '';
    } else {
      fence = FENCE_OPEN.exec(content)?.[1] ?? '';
      if (!fence) {
        const text = maskCodeSpans(line);
        const lineOpen = LINE_DETAILS_OPEN.exec(text.slice(prefix));
        if (lineOpen) depth++;
        DETAILS_CLOSE.lastIndex = lineOpen ? prefix + lineOpen[0].length : 0;
        for (let m = DETAILS_CLOSE.exec(text); m; m = DETAILS_CLOSE.exec(text)) {
          if (--depth > 0) continue;
          const close = start + m.index;
          return { raw: src.slice(0, close + m[0].length), body: src.slice(open[0].length, close) };
        }
      }
    }
    start = end + 1;
  }
  return { raw: src, body: src.slice(open[0].length) };
}

// <details> / <summary> は折りたたまずに、枠と見出しを付けた div にする。ほかの HTML タグと同じく文字として見せると、
// エージェントが補足を <details> で書いた時に読みにくい。中身は Markdown として解釈する
marked.use({
  extensions: [
    {
      name: 'details',
      level: 'block',
      // marked は段落の 2 文字目以降を渡してくるので、先頭の位置は行頭ではない。改行の直後だけを候補にする
      start(src) {
        const index = /\n {0,3}<details\b/i.exec(src)?.index;
        return index === undefined ? undefined : index + 1;
      },
      tokenizer(src) {
        if (detailsDepth >= MAX_DETAILS_DEPTH) return undefined;
        const block = findDetailsBlock(src);
        if (!block) return undefined;
        const summary = /^\s*<summary\b[^>]*>([\s\S]*?)<\/summary>/i.exec(block.body);
        const body = summary ? block.body.slice(summary[0].length) : block.body;
        const token = { type: 'details', raw: block.raw, summaryTokens: [], tokens: [] };
        if (summary) this.lexer.inline(summary[1].trim(), token.summaryTokens);
        detailsDepth++;
        try {
          // 先頭の空行だけを落とす。trim だと最初の行の字下げ (インデントのコードブロック) も消える
          this.lexer.blockTokens(body.replace(/^\s*\n/, '').trimEnd(), token.tokens);
        } finally {
          detailsDepth--;
        }
        return token;
      },
      renderer(token) {
        const summary = token.summaryTokens.length
          ? `<div class="summary">${this.parser.parseInline(token.summaryTokens)}</div>`
          : '';
        return `<div class="details">${summary}${this.parser.parse(token.tokens ?? [])}</div>\n`;
      },
      childTokens: ['summaryTokens', 'tokens'],
    },
  ],
  renderer: {
    // 本文中の HTML タグは文字として見せる。エージェントが HTML の書き方を説明する時に、タグが消えると読めない
    html({ text }) {
      return escapeHtml(text);
    },
    // marked は <pre> / <script> / <style> の開始タグより後ろの文字を、エスケープ済みの HTML として扱い、そのまま出す
    text(token) {
      if (token.type === 'text' && token.escaped && !token.tokens) return escapeHtml(token.text);
      return false;
    },
    // コードブロックには、ホバーで右上に出るコピーボタンを添える (クリックは ChatTab が受ける)
    code(token) {
      return `<div class="code-block">${Renderer.prototype.code.call(this, token)}${COPY_BUTTON_HTML}</div>\n`;
    },
    // 画像は読み込まず、リンクにする。表示するだけで外部のサーバーへアクセスが飛ぶのを避ける
    image({ href, text, tokens }) {
      const label = tokens ? this.parser.parseInline(tokens, this.parser.textRenderer) : text;
      return `<a href="${escapeHtml(href)}">${escapeHtml(label || href)}</a>`;
    },
  },
});

// marked が出すタグだけを通す。WebView は Tauri のコマンドを呼べるので、スクリプトを実行できる要素や属性を残さない
const SANITIZE_OPTIONS = {
  ALLOWED_TAGS: [
    'p', 'br', 'hr', 'strong', 'em', 'del', 'code', 'pre', 'blockquote',
    'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a',
    'table', 'thead', 'tbody', 'tr', 'th', 'td', 'input', 'div', 'button',
  ],
  ALLOWED_ATTR: ['href', 'title', 'align', 'start', 'class', 'type', 'checked', 'disabled', 'aria-label'],
  ALLOW_DATA_ATTR: false,
};

// リンク先を入れておく属性。href のままだと、クリック以外の経路 (右クリックのメニューなど) で WebView がそのページへ
// 移動できる。移動先のページはアプリのコマンドを呼べるので、WebView が辿れる形では残さない
export const LINK_ATTRIBUTE = 'data-href';

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName !== 'A') return;
  const href = node.getAttribute('href');
  if (href === null) return;
  node.removeAttribute('href');
  node.setAttribute(LINK_ATTRIBUTE, href);
  // 開く前に行き先を確かめられるようにする
  if (!node.hasAttribute('title')) node.setAttribute('title', href);
});

// エージェントや利用者の Markdown を、画面に差し込める HTML にする
export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false });
  return DOMPurify.sanitize(html, SANITIZE_OPTIONS);
}

// 外部のアプリで開いてよいリンクか。相対パスなどをそのまま開くと、WebView がアプリの画面から移動してしまう
export function isExternalLink(href: string): boolean {
  return /^(https?:|mailto:)/i.test(href);
}
