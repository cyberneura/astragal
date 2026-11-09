// Adapted from Beckwell (Cyberneura), MIT. See docs/beckwell-chat.md.
// チャットタブの画面に並べる項目。エージェントごとのイベントをこの形に正規化する
export type Item =
  | { kind: 'user'; text: string }
  // id はエージェントが項目に付けた ID (差分を足す先を探すのに使う。無いエージェントもある)
  | { kind: 'text'; id?: string; text: string; streaming: boolean }
  | { kind: 'thinking'; id?: string; text: string; streaming: boolean }
  | { kind: 'tool_use'; toolUseId: string; name: string; input: Record<string, unknown>; result: string | null; isError: boolean }
  | { kind: 'permission'; requestId: string | number; toolName: string; description: string; input: Record<string, unknown>; decision: PermissionDecision | null }
  // エージェントが利用者に選択肢を示して尋ねる (Claude の AskUserQuestion)。answers は答えた後の、質問文 → 答え
  | { kind: 'question'; requestId: string | number; input: Record<string, unknown>; title: string; questions: Question[]; decision: QuestionDecision | null; answers: Record<string, string> }
  // at はターンが終わった時刻 (ミリ秒)。再生した過去の出力では分からないので null
  | { kind: 'result'; summary: string; at: number | null; finalText?: string }
  | { kind: 'note'; text: string; level: NoteLevel };

export type PermissionDecision = 'allow' | 'deny';
export type PermissionItem = Extract<Item, { kind: 'permission' }>;
export type QuestionDecision = 'answered' | 'declined';
export type QuestionItem = Extract<Item, { kind: 'question' }>;

// 質問 1 つ。choice は選択肢から選ぶ (自由記述もできる)。text / number は入力欄だけ
export type Question = {
  question: string;
  header: string;
  // 質問の下に出す補助の 1 行
  description: string;
  kind: 'choice' | 'text' | 'number';
  options: QuestionOption[];
  multiSelect: boolean;
  placeholder: string;
  min: number | null;
  max: number | null;
  step: number | null;
  unit: string;
};
export type QuestionOption = { label: string; description: string };
// 1 問の答えの入力途中 (画面の状態)。selected は選んだ選択肢の label、text は自由記述 (text / number の質問はこちらだけ)
export type QuestionDraft = { selected: string[]; text: string };
export type NoteLevel = 'info' | 'error';

// ヘッダーの下に出す、セッションの情報
export type SessionInfo = { sessionId: string; model: string; detail: string };

export type ModelChoice = { value: string; label: string };

// 入力欄で補完するスラッシュコマンド (name に先頭の / は付かない)
export type SlashCommand = { name: string; description: string; argumentHint: string };

// 続きから始められる過去のセッション。updatedAt は秒 (分からなければ null)
export type SessionSummary = { id: string; title: string; updatedAt: number | null };

// プロトコルを作る時に渡すもの
export type ProtocolOptions = {
  // 続きから始めるセッションの ID。新しく始める時は null
  resume: string | null;
  // Claude Code がディスクに残したセッションの記録を読む。sessionId が null なら一覧、あればその会話
  readClaudeSessions(sessionId: string | null): Promise<string>;
  // 永続セッション (Claude だけ)。繋いだ直後に、それまでの出力が再生される
  persistent?: boolean;
};

// ChatTab がプロトコルに渡す、画面と子プロセスへの口
export type ChatHost = {
  // 現在のセッションの項目 (Svelte の $state。見つけた項目を書き換えれば画面に反映される)
  readonly items: Item[];
  push(item: Item): void;
  note(text: string, level?: NoteLevel): void;
  scrollToBottom(): void;
  // JSON 1 行を子プロセスの stdin に書く。届かなければ false (理由は note 済み)
  write(payload: unknown): Promise<boolean>;
  // 応答待ちの間は送信できない
  setBusy(busy: boolean): void;
  // メッセージを受け付けられる状態になったか
  setReady(ready: boolean): void;
  setSession(session: SessionInfo | null): void;
  // 利用枠の表示 (例: "5h 25% · 7d 43%")
  setUsage(usage: string | null): void;
  // エージェントが報告した作業ディレクトリ
  setWorkingDirectory(cwd: string): void;
  // エージェントが報告した、使えるスラッシュコマンドとモデル
  setCommands(commands: SlashCommand[]): void;
  setModels(models: ModelChoice[]): void;
  // エージェントが会話を始め直した時に呼ぶ。画面の項目とセッションの情報を消す
  clear(): void;
  // 同じセッションの続きとしてプロセスを起動し直す。中止しても止まらなかったツールのコマンドを、
  // プロセスごと終わらせるのに使う (Codex)。note は起動し直した後の画面に出す
  restart(note: string): void;
  // 中止の要求をエージェントが断った時に呼ぶ。理由を出し、Stop を押し直せる状態に戻す
  interruptFailed(message: string): void;
};

// エージェントごとの通信の解釈
export type ChatProtocol = {
  // 子プロセスが起動した直後に呼ばれる。続きから始める時は、それまでの会話を画面に並べる
  start(): void;
  // 起動したディレクトリで続きから始められる、過去のセッション (新しい順)。ready になってから呼ぶ
  listSessions(): Promise<SessionSummary[]>;
  // 子プロセスが stdout に書いた JSON 1 行ぶん
  handleMessage(message: any): void;
  // 利用者のメッセージを送る (画面への追加と busy の設定は ChatTab が済ませている)
  send(text: string, options?: { cwd?: string }): Promise<void>;
  /** Supports changing cwd at the next turn without restarting the conversation. */
  supportsWorkingDirectory?: boolean;
  respondPermission(item: PermissionItem, decision: PermissionDecision): Promise<void>;
  // 質問に答える (answers は質問文 → 答え)。null は答えずに断る。質問の項目を出すエージェントだけが持つ
  answerQuestion?(item: QuestionItem, answers: Record<string, string> | null): Promise<void>;
  // 起動したままモデルを切り替える (できないエージェントには無い)。空文字は既定のモデル
  setModel?(model: string): Promise<void>;
  // 応答の途中のターンを中止する。プロセスは残し、続けてメッセージを送れる状態に戻す。
  // ターンの終わりが届くと busy が解ける。要求を送れなかった時は false
  interrupt(): Promise<boolean>;
};

// 中止したターンの、途中の項目を閉じる (ストリーミング中の表示と、結果の無いツールを実行中のまま残さない)
export function finishInterruptedTurn(host: ChatHost): void {
  for (let i = host.items.length - 1; i >= 0; i--) {
    const item = host.items[i];
    if (item.kind === 'user') break;
    if ((item.kind === 'text' || item.kind === 'thinking') && item.streaming) item.streaming = false;
    if (item.kind === 'tool_use' && item.result === null) {
      item.result = '(interrupted)';
      item.isError = true;
    }
  }
}

export function stringifyContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c?.type === 'text' ? c.text : `[${c?.type ?? 'unknown'}]`)).join('\n');
  }
  return JSON.stringify(content, null, 2);
}
