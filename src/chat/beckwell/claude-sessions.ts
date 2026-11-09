// Adapted from Beckwell (Cyberneura), MIT. See docs/beckwell-chat.md.
// Claude Code がディスクに残したセッションの記録の解釈 (Rust の claude_sessions が返す文字列を読む)
import type { SessionSummary } from './types';

function parseLine(line: string): any {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

// 一覧の出力。「@@session <ID> <更新時刻 (秒)>」の行の後に、そのセッションのタイトルになる行が続く
export function parseSessionList(output: string): SessionSummary[] {
  const sessions: (SessionSummary & { rank: number })[] = [];
  for (const line of output.split('\n')) {
    if (line.startsWith('@@session ')) {
      const [, id, seconds] = line.split(' ');
      const updatedAt = Number(seconds);
      if (id) sessions.push({ id, title: '', updatedAt: seconds && Number.isFinite(updatedAt) ? updatedAt : null, rank: 0 });
      continue;
    }
    const current = sessions[sessions.length - 1];
    const entry = current && line.startsWith('{') ? parseLine(line) : null;
    if (!entry) continue;
    // 利用者が付けた名前、自動で付いた題、最後の入力の順に優先する
    const candidates: [number, unknown][] = [
      [3, entry.type === 'custom-title' ? entry.customTitle : null],
      [2, entry.type === 'ai-title' ? entry.aiTitle : null],
      [1, entry.type === 'last-prompt' ? entry.lastPrompt : null],
    ];
    for (const [rank, title] of candidates) {
      if (typeof title === 'string' && title.trim() && rank > current.rank) {
        current.title = title.trim();
        current.rank = rank;
      }
    }
  }
  return sessions.map(({ id, title, updatedAt }) => ({ id, title, updatedAt }));
}

// 利用者が打ったものではない、Claude Code が会話に差し込んだメッセージ
const INJECTED = /^<(local-command-(stdout|stderr|caveat)|bash-(stdout|stderr)|system-reminder|task-notification)>/;

function tagContent(text: string, tag: string): string | null {
  const match = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? match[1].trim() : null;
}

// 記録の中の利用者のメッセージから、画面に出す文字を取り出す。出すものが無ければ null
export function userText(content: unknown): string | null {
  const text = (
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
        : ''
  ).trim();
  if (!text || INJECTED.test(text)) return null;
  const command = tagContent(text, 'command-name');
  if (command !== null) return `${command} ${tagContent(text, 'command-args') ?? ''}`.trim();
  const bash = tagContent(text, 'bash-input');
  if (bash !== null) return `! ${bash}`;
  return text;
}

export type HistoryEntry = { type: 'user' | 'assistant' | 'compacted'; message: any };

// 1 セッションぶんの出力から、会話に出す行を取り出す
export function parseHistory(output: string): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (const line of output.split('\n')) {
    const entry = line.startsWith('{') ? parseLine(line) : null;
    // サブエージェントの会話と、Claude Code が自分用に差し込んだメッセージは出さない
    if (!entry || entry.isSidechain || entry.isMeta || !entry.message) continue;
    if (entry.type === 'assistant') entries.push({ type: 'assistant', message: entry.message });
    else if (entry.type === 'user') entries.push({ type: entry.isCompactSummary ? 'compacted' : 'user', message: entry.message });
  }
  return entries;
}
