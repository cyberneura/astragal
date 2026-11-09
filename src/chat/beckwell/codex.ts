// Adapted from Beckwell (Cyberneura), MIT. See docs/beckwell-chat.md.
// Codex の app-server (`codex app-server`) の解釈。stdio の JSON-RPC (改行区切り、`jsonrpc` フィールドは無い)
import { finishInterruptedTurn, stringifyContent, type ChatHost, type ChatProtocol, type PermissionDecision, type PermissionItem, type ProtocolOptions, type SessionSummary } from './types';

type ResponseHandler = { onResult: (result: any) => void; onError?: (message: string) => void };

// 承認の要求ごとに、拒否する時に返す値を覚えておく (要求の種類と、その時に選べる値で変わる)
type PendingApproval = { declineDecision: string };

const JSONRPC_METHOD_NOT_FOUND = -32601;
// 一覧に出すスレッドの数
const SESSION_LIST_LIMIT = 30;
// 続きから始める時に画面に並べる、過去のターンの数 (新しい側から)
const HISTORY_TURNS = 100;

export function createCodexProtocol(host: ChatHost, options: ProtocolOptions): ChatProtocol {
  let nextRequestId = 1;
  const responseHandlers = new Map<number, ResponseHandler>();
  const pendingApprovals = new Map<string | number, PendingApproval>();
  let threadId: string | null = null;
  // 実行中のターンの ID (turn/interrupt に要る)。ターンが終わると null
  let turnId: string | null = null;
  // ターンの ID が届く前に中止を求められた時、届いたらすぐ中止する
  let interruptPending = false;
  // 中止を求めた後、ターンの終わりを待っている間
  let interrupting = false;
  // 送った turn/interrupt の通し番号 (最後のものの失敗だけを知らせる)
  let interruptSerial = 0;
  // 始まって、まだ終わっていないコマンドの項目の ID。turn/interrupt はターンを終わらせるだけで、
  // 実行中のコマンドは止めない (codex 0.156 で確認)。残っていたらプロセスごと起動し直して終わらせる
  const runningCommands = new Set<string>();
  // スレッドの作業ディレクトリ (過去のスレッドを、同じディレクトリのものに絞るのに使う)
  let threadCwd: string | null = null;
  // スレッド全体のトークン数の累計と、現在のターンを始めた時の値 (差がそのターンで使った量)
  let totalTokens = 0;
  let turnStartTokens = 0;
  // 書き戻しには最後の完了済み回答だけを使い、途中の提案を引き継がない。
  let finalText: string | undefined;
  // 利用枠の最新の値 (枠ごと)
  const rateLimits: { primary: any; secondary: any } = { primary: null, secondary: null };

  async function request(method: string, params: unknown, handler: ResponseHandler) {
    const id = nextRequestId++;
    responseHandlers.set(id, handler);
    const written = await host.write({ id, method, params });
    if (!written) {
      responseHandlers.delete(id);
      handler.onError?.('The request could not be sent');
    }
  }

  function findItem<K extends 'text' | 'thinking' | 'tool_use'>(kind: K, id: string) {
    for (let i = host.items.length - 1; i >= 0; i--) {
      const item = host.items[i];
      if (item.kind === kind && (item.kind === 'tool_use' ? item.toolUseId === id : (item as any).id === id)) {
        return item as Extract<(typeof host.items)[number], { kind: K }>;
      }
    }
    return null;
  }

  function appendText(kind: 'text' | 'thinking', id: string, delta: string) {
    finalText = undefined;
    const target = findItem(kind, id);
    if (target) target.text += delta;
    else host.push({ kind, id, text: delta, streaming: true });
    if (kind === 'text') host.scrollToBottom();
  }

  // ツール実行にあたる項目の、表示名と入力
  function toolOf(item: any): { name: string; input: Record<string, unknown> } | null {
    switch (item.type) {
      case 'commandExecution':
        return { name: 'Shell', input: { command: item.command, cwd: item.cwd } };
      case 'fileChange':
        return { name: 'Edit', input: { changes: item.changes } };
      case 'mcpToolCall':
        return { name: `${item.server}.${item.tool}`, input: item.arguments ?? {} };
      case 'webSearch':
        return { name: 'WebSearch', input: { query: item.query } };
      default:
        return null;
    }
  }

  function toolResultOf(item: any, streamed: string | null): { result: string; isError: boolean } {
    const failed = item.status === 'failed' || item.status === 'declined';
    switch (item.type) {
      case 'commandExecution': {
        const output = item.aggregatedOutput ?? streamed ?? '';
        const exit = item.exitCode === null || item.exitCode === undefined ? item.status : `exit ${item.exitCode}`;
        return { result: `${output}${output && !output.endsWith('\n') ? '\n' : ''}(${exit})`, isError: failed || (item.exitCode ?? 0) !== 0 };
      }
      case 'mcpToolCall':
        return {
          result: item.error ? stringifyContent(item.error.message ?? item.error) : stringifyContent(item.result?.content ?? item.result ?? ''),
          isError: failed || Boolean(item.error),
        };
      default:
        return { result: String(item.status ?? 'completed'), isError: failed };
    }
  }

  function reasoningText(item: any): string {
    const parts = [...(item.summary ?? []), ...(item.content ?? [])];
    return parts.map((part: any) => (typeof part === 'string' ? part : (part?.text ?? ''))).join('\n\n');
  }

  function handleItemStarted(item: any) {
    finalText = undefined;
    if (item.type === 'agentMessage') {
      if (!findItem('text', item.id)) host.push({ kind: 'text', id: item.id, text: item.text ?? '', streaming: true });
    } else if (item.type === 'reasoning') {
      if (!findItem('thinking', item.id)) host.push({ kind: 'thinking', id: item.id, text: reasoningText(item), streaming: true });
    } else {
      if (item.type === 'commandExecution') runningCommands.add(item.id);
      const tool = toolOf(item);
      if (tool && !findItem('tool_use', item.id)) {
        host.push({ kind: 'tool_use', toolUseId: item.id, name: tool.name, input: tool.input, result: null, isError: false });
      }
    }
  }

  function handleItemCompleted(item: any) {
    finalText = item.type === 'agentMessage' && (item.phase == null || item.phase === 'final_answer')
      && typeof item.text === 'string' ? item.text : undefined;
    if (item.type === 'agentMessage' || item.type === 'reasoning') {
      const kind = item.type === 'agentMessage' ? 'text' : 'thinking';
      const text = item.type === 'agentMessage' ? (item.text ?? '') : reasoningText(item);
      const target = findItem(kind, item.id);
      if (target) {
        // 推論は、要約が無いモデルでは差分だけが届くことがある。確定時の本文が空なら差分を残す
        if (text) target.text = text;
        target.streaming = false;
      } else if (text) {
        host.push({ kind, id: item.id, text, streaming: false });
      }
      return;
    }

    runningCommands.delete(item.id);
    const tool = toolOf(item);
    if (!tool) return;
    let target = findItem('tool_use', item.id);
    if (!target) {
      host.push({ kind: 'tool_use', toolUseId: item.id, name: tool.name, input: tool.input, result: null, isError: false });
      target = findItem('tool_use', item.id);
    }
    if (target) {
      const { result, isError } = toolResultOf(item, target.result);
      target.input = tool.input;
      target.result = result;
      target.isError = isError;
    }
  }

  // 続きから始めたスレッドの、それまでの会話を画面に並べる
  function showHistory(turns: any[]) {
    if (turns.length > HISTORY_TURNS) host.note(`(${turns.length - HISTORY_TURNS} earlier turns are not shown)`);
    for (const turn of turns.slice(-HISTORY_TURNS)) {
      for (const item of turn.items ?? []) {
        if (item.type === 'userMessage') {
          const text = (item.content ?? [])
            .filter((input: any) => input?.type === 'text')
            .map((input: any) => input.text)
            .join('\n');
          if (text) host.push({ kind: 'user', text });
        } else {
          handleItemCompleted(item);
        }
      }
    }
  }

  function handleNotification(method: string, params: any) {
    // 同じ接続に別のスレッド (サブエージェントなど) の通知が届いても、自分のスレッドの画面には出さない
    if (threadId && typeof params.threadId === 'string' && params.threadId !== threadId) return;
    switch (method) {
      case 'item/started':
        handleItemStarted(params.item);
        break;
      case 'item/completed':
        handleItemCompleted(params.item);
        break;
      case 'item/agentMessage/delta':
        appendText('text', params.itemId, params.delta ?? '');
        break;
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
        appendText('thinking', params.itemId, params.delta ?? '');
        break;
      case 'item/commandExecution/outputDelta': {
        const target = findItem('tool_use', params.itemId);
        if (target) target.result = (target.result ?? '') + (params.delta ?? '');
        break;
      }
      case 'thread/tokenUsage/updated':
        totalTokens = params.tokenUsage?.total?.totalTokens ?? totalTokens;
        break;
      case 'account/rateLimits/updated': {
        // 変わった枠だけが届くことがあるので、届いた枠だけを前回の値に上書きして表示する
        for (const key of ['primary', 'secondary'] as const) {
          const limit = params.rateLimits?.[key];
          if (limit && typeof limit === 'object') rateLimits[key] = limit;
        }
        const window = (limit: any) => {
          if (!limit) return null;
          const minutes = limit.windowDurationMins ?? 0;
          const label = minutes >= 1440 ? `${Math.round(minutes / 1440)}d` : `${Math.round(minutes / 60)}h`;
          return `${label} ${Math.round(limit.usedPercent ?? 0)}%`;
        };
        const parts = [window(rateLimits.primary), window(rateLimits.secondary)].filter(Boolean);
        host.setUsage(parts.length ? parts.join(' · ') : null);
        break;
      }
      case 'turn/started':
        startTurn(params.turn?.id);
        break;
      case 'turn/completed': {
        const turn = params.turn ?? {};
        // 中止を求めたが、その前にターンが終わっていた時 (completed) は中止扱いにしない
        const interrupted = turn.status === 'interrupted' || (interrupting && turn.status !== 'completed');
        const seconds = ((turn.durationMs ?? 0) / 1000).toFixed(1);
        host.push({ kind: 'result', summary: `${turn.status ?? 'completed'} · ${seconds}s · ${totalTokens - turnStartTokens} tokens`, at: Date.now(), finalText: turn.status === 'completed' ? finalText : undefined });
        if (turn.error) host.note(stringifyContent(turn.error.message ?? turn.error), 'error');
        endTurn(interrupted);
        break;
      }
      case 'error':
        host.note(stringifyContent(params.error?.message ?? params.error ?? 'error'), 'error');
        // 再試行しないエラーはターンを打ち切る。この後 turn/completed が届かないことがあるので、ここでターンを終える
        // (中止を求めていた時の後始末も、turn/completed と同じく行う)
        if (params.willRetry === false) endTurn(interrupting);
        break;
      case 'warning':
      case 'configWarning':
      case 'deprecationNotice':
        host.note(String(params.message ?? params.summary ?? method));
        break;
    }
  }

  // ターンの終わり (turn/completed、または再試行しない error)。中止したターンなら、途中の項目を閉じ、
  // 終わっていないコマンドが残っていればプロセスごと起動し直して止める
  function endTurn(interrupted: boolean) {
    host.setBusy(false);
    turnId = null;
    interruptPending = false;
    interrupting = false;
    const leftCommands = runningCommands.size > 0;
    // 次のターンの中止で、このターンのコマンドを数えないように
    runningCommands.clear();
    if (!interrupted) return;
    finishInterruptedTurn(host);
    if (leftCommands) host.restart('(interrupted. Restarted Codex to stop the commands that were still running)');
    else host.note('(interrupted)');
  }

  function startTurn(id: unknown) {
    if (typeof id !== 'string' || !id || turnId === id) return;
    turnId = id;
    if (interruptPending) {
      interruptPending = false;
      sendInterrupt();
    }
  }

  function sendInterrupt() {
    if (!threadId || !turnId) return;
    interrupting = true;
    // 押し直した後に届いた、前の要求の失敗は無視する
    const serial = ++interruptSerial;
    request(
      'turn/interrupt',
      { threadId, turnId },
      {
        onResult: () => {},
        onError: (message) => {
          if (serial !== interruptSerial || !interrupting) return;
          interrupting = false;
          host.interruptFailed(`Could not stop the response: ${message}`);
        },
      },
    );
  }

  function handleServerRequest(id: string | number, method: string, params: any) {
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      const isCommand = method === 'item/commandExecution/requestApproval';
      // コマンドの承認は、その時に選べる値が届く。decline が無ければ cancel (ターンを中断する) で断る
      const available: unknown[] = params.availableDecisions ?? [];
      const declineDecision = !isCommand || available.length === 0 || available.includes('decline') ? 'decline' : 'cancel';
      pendingApprovals.set(id, { declineDecision });
      const tool = findItem('tool_use', params.itemId);
      host.push({
        kind: 'permission',
        requestId: id,
        toolName: isCommand ? 'Shell' : 'Edit',
        description: params.reason ?? params.command ?? '',
        input: isCommand ? { command: params.command, cwd: params.cwd } : (tool?.input ?? {}),
        decision: null,
      });
      return;
    }
    // 未対応の要求は応答しないと Codex が待ち続けるので、エラーで返す
    host.write({ id, error: { code: JSONRPC_METHOD_NOT_FOUND, message: `Unsupported request: ${method}` } });
    host.note(`Unsupported request: ${method}`, 'error');
  }

  return {
    start() {
      const fail = (message: string) => host.note(`Failed to start the Codex thread: ${message}`, 'error');
      request(
        'initialize',
        { clientInfo: { name: 'astragal', title: 'Astragal', version: '0' } },
        {
          onResult: async () => {
            // invoke は並行に投げると到着順が保証されないので、initialized が書かれてから thread/start を送る
            if (!(await host.write({ method: 'initialized' }))) return;
            // 承認の方針・サンドボックス・モデルは渡さず、相手の設定の既定に従う
            request(
              options.resume ? 'thread/resume' : 'thread/start',
              options.resume ? { threadId: options.resume } : {},
              {
                onResult: (result) => {
                  threadId = result.thread?.id ?? null;
                  threadCwd = result.cwd ?? null;
                  if (options.resume) {
                    showHistory(result.thread?.turns ?? []);
                    host.note(`resumed session ${threadId}`);
                  }
                  const sandbox = result.sandbox?.type ?? '';
                  host.setSession({
                    sessionId: threadId ?? '',
                    model: result.model ?? '',
                    detail: [result.reasoningEffort, result.approvalPolicy, sandbox].filter((v) => typeof v === 'string' && v).join(' · '),
                  });
                  if (result.cwd) host.setWorkingDirectory(result.cwd);
                  host.setReady(threadId !== null);
                },
                onError: fail,
              },
            );
          },
          onError: fail,
        },
      );
    },

    listSessions() {
      return new Promise<SessionSummary[]>((resolve, reject) => {
        request(
          'thread/list',
          {
            limit: SESSION_LIST_LIMIT,
            sortKey: 'updated_at',
            // 対話で使ったスレッドだけにする (codex exec やサブエージェントのものは出さない)
            sourceKinds: ['cli', 'vscode', 'appServer'],
            // 空の配列は「全てのプロバイダー」。省くと、今の既定のプロバイダーで作ったスレッドだけになることがある
            modelProviders: [],
            ...(threadCwd ? { cwd: threadCwd } : {}),
          },
          {
            onResult: (result) =>
              resolve(
                (result.data ?? [])
                  .filter((thread: any) => thread.id !== threadId)
                  .map((thread: any) => ({
                    id: thread.id,
                    title: String(thread.name || thread.preview || '').trim(),
                    updatedAt: typeof thread.updatedAt === 'number' ? thread.updatedAt : null,
                  })),
              ),
            onError: (message) => reject(new Error(message)),
          },
        );
      });
    },

    handleMessage(message: any) {
      const hasId = message.id !== undefined && message.id !== null;
      if (typeof message.method === 'string') {
        if (hasId) handleServerRequest(message.id, message.method, message.params ?? {});
        else handleNotification(message.method, message.params ?? {});
        return;
      }
      if (!hasId) return;
      const handler = responseHandlers.get(message.id);
      responseHandlers.delete(message.id);
      if (message.error) {
        const text = stringifyContent(message.error.message ?? message.error);
        if (handler?.onError) handler.onError(text);
        else host.note(text, 'error');
      } else {
        handler?.onResult(message.result);
      }
    },

    supportsWorkingDirectory: true,

    async send(text: string, options?: { cwd?: string }) {
      finalText = undefined;
      if (!threadId) {
        host.setBusy(false);
        host.note('The Codex thread is not ready', 'error');
        return;
      }
      turnStartTokens = totalTokens;
      turnId = null;
      interruptPending = false;
      interrupting = false;
      await request(
        'turn/start',
        { threadId, input: [{ type: 'text', text, text_elements: [] }], ...(options?.cwd ? { cwd: options.cwd } : {}) },
        {
          onResult: (result) => {
            if (options?.cwd) {
              threadCwd = options.cwd;
              host.setWorkingDirectory(options.cwd);
            }
            startTurn(result?.turn?.id);
          },
          // 始まらなかったターンには turn/completed が届かないので、ここで戻す
          onError: (message) => {
            host.setBusy(false);
            host.note(message, 'error');
          },
        },
      );
    },

    async interrupt() {
      if (!threadId) return false;
      // turn/start の応答 (ターンの ID) より先に押された時は、届いてから送る
      if (!turnId) interruptPending = true;
      else sendInterrupt();
      return true;
    },

    async respondPermission(item: PermissionItem, decision: PermissionDecision) {
      const pending = pendingApprovals.get(item.requestId);
      const written = await host.write({
        id: item.requestId,
        result: { decision: decision === 'allow' ? 'accept' : (pending?.declineDecision ?? 'decline') },
      });
      // 応答が届かないと Codex は待ち続けるので、もう一度押せるように戻す
      if (written) pendingApprovals.delete(item.requestId);
      else item.decision = null;
    },
  };
}
