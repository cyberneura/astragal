// Adapted from Beckwell (Cyberneura), MIT. See docs/beckwell-chat.md.
import { createClaudeProtocol } from './claude';
import { createCodexProtocol } from './codex';
import type { ChatHost, ChatProtocol, ModelChoice, ProtocolOptions } from './types';

// チャットタブで使えるエージェント
export type ChatAgent = 'claude' | 'codex';

export function createProtocol(agent: ChatAgent, host: ChatHost, options: ProtocolOptions): ChatProtocol {
  return agent === 'codex' ? createCodexProtocol(host, options) : createClaudeProtocol(host, options);
}

// 起動時に選べるモデル。空ならモデルの選択欄を出さない。
// Claude は、起動後にエージェントが報告した一覧 (ChatHost.setModels) で置き換わる。
// Codex は相手の ~/.codex/config.toml の既定に従う
export function modelChoices(agent: ChatAgent): ModelChoice[] {
  if (agent === 'codex') return [];
  return [
    { value: 'opus', label: 'opus' },
    { value: 'sonnet', label: 'sonnet' },
    { value: 'haiku', label: 'haiku' },
  ];
}

// セッションの更新時刻を「どれだけ前か」で表す (now も秒)
export function formatAge(updatedAt: number, now: number): string {
  const seconds = Math.max(0, now - updatedAt);
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

// 最後の応答の時刻を「どれだけ前か」で表す (ミリ秒)。表示を頻繁に変えないよう段階を粗くする
export function formatElapsed(at: number, now: number): string {
  const seconds = Math.max(0, (now - at) / 1000);
  if (seconds < 10) return 'just now';
  if (seconds < 30) return '10 seconds ago';
  if (seconds < 60) return '30 seconds ago';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 90) return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}
