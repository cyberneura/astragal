// Adapted from Beckwell (Cyberneura), MIT. See docs/beckwell-chat.md.
// Claude Code の stream-json (`claude -p --input-format stream-json --output-format stream-json`) の解釈
import { parseHistory, parseSessionList, userText } from './claude-sessions';
import { parseQuestions } from './questions';
import { finishInterruptedTurn, stringifyContent, type ChatHost, type ChatProtocol, type PermissionDecision, type PermissionItem, type ProtocolOptions, type QuestionItem } from './types';

// 自分が送る control_request の ID
const INITIALIZE_REQUEST_ID = 'initialize';
const SET_MODEL_REQUEST_PREFIX = 'set-model-';
const INTERRUPT_REQUEST_PREFIX = 'interrupt-';

const LOCAL_COMMAND_OUTPUT = /^<local-command-stdout>([\s\S]*)<\/local-command-stdout>$/;

export function createClaudeProtocol(host: ChatHost, options: ProtocolOptions): ChatProtocol {
  let nextSetModelId = 1;
  let nextInterruptId = 1;
  // 中止を求めた後、ターンの終わり (result) を待っている間。届いた result をエラーとして出さない
  let interrupting = false;
  // 永続セッションに繋いだ直後の、それまでの出力の再生の間 (beckwell_live が届くまで)。
  // 再生の中の利用者のメッセージは、画面にまだ無いので並べる (繋いでいる間に送ったものは ChatTab が並べ済み)
  let replaying = Boolean(options.persistent);
  let endReplay: () => void = () => {};
  const replayed = options.persistent ? new Promise<void>((resolve) => (endReplay = resolve)) : Promise.resolve();
  // 前の接続で返した control_response (request_id → response)。再生した権限確認のうち、答え済みのものを見分ける
  const answered = new Map<string, any>();
  // この接続で送り、写しがまだ返っていない利用者のメッセージ (送った順)。ChatTab が並べ済みなので、写しは並べない。
  // 写しと突き合わせるのは、切れる直前に送ったメッセージの写しが、再生の後に遅れて届くことがあるため (それは並べる)
  const awaitingEcho: string[] = [];
  // 返事 (result) をまだ受けていないターンの数 (永続セッションだけ)。切れる直前に送ったメッセージの result が遅れて届いた時に、
  // その後に送ったメッセージの応答中なのに busy を解かないように
  let outstanding = 0;
  // result の total_cost_usd は、このプロセスを起動してからの累計。ターンごとの額はその差で出す
  let costSoFar = 0;
  // 前の接続までに claude に渡した利用者のメッセージ (beckwell_sent) のうち、写しがまだ届いていないもの。
  // ターンは渡した行で数え、写しでは数えない (スラッシュコマンドは写しを返さないので、その応答中に切れると busy が戻らない)
  const sentBefore: string[] = [];
  // 最後に送った中止の要求の ID。押し直した後に届いた、前の要求の失敗は無視する
  let interruptRequestId: string | null = null;

  // 現在のターンのストリーミング中の項目。差分は最後のブロックに足し、
  // 最終的な assistant メッセージは最初の未確定ブロックから順に確定させる
  function streamingItem(kind: 'text' | 'thinking', which: 'first' | 'last') {
    let found = null;
    for (let i = host.items.length - 1; i >= 0; i--) {
      const item = host.items[i];
      if (item.kind === 'user') break;
      if (item.kind === kind && item.streaming) {
        found = item;
        if (which === 'last') break;
      }
    }
    return found;
  }

  function handleStreamEvent(event: any) {
    if (event.type === 'content_block_start') {
      const type = event.content_block?.type;
      if (type === 'text' || type === 'thinking') {
        host.push({ kind: type, text: '', streaming: true });
      }
    } else if (event.type === 'content_block_delta') {
      const delta = event.delta;
      if (delta?.type === 'text_delta') {
        const target = streamingItem('text', 'last');
        if (target) target.text += delta.text;
        else host.push({ kind: 'text', text: delta.text, streaming: true });
        host.scrollToBottom();
      } else if (delta?.type === 'thinking_delta') {
        const target = streamingItem('thinking', 'last');
        if (target) target.text += delta.thinking;
      }
    }
  }

  function handleAssistant(message: any) {
    for (const block of message.content ?? []) {
      if (block.type === 'text' || block.type === 'thinking') {
        const text = block.type === 'text' ? block.text : block.thinking;
        const target = streamingItem(block.type, 'first');
        if (target) {
          target.text = text;
          target.streaming = false;
        } else if (text) {
          host.push({ kind: block.type, text, streaming: false });
        }
      } else if (block.type === 'tool_use') {
        host.push({
          kind: 'tool_use',
          toolUseId: block.id,
          name: block.name,
          input: block.input ?? {},
          result: null,
          isError: false,
        });
      }
    }
  }

  function handleUser(message: any) {
    const content = message.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block.type !== 'tool_result') continue;
      const target = host.items.find((i) => i.kind === 'tool_use' && i.toolUseId === block.tool_use_id);
      if (target && target.kind === 'tool_use') {
        target.result = stringifyContent(block.content);
        target.isError = Boolean(block.is_error);
      }
    }
  }

  function handleControlRequest(event: any) {
    const request = event.request;
    const prior = answered.get(String(event.request_id));
    const allowed = prior?.subtype === 'success' && prior.response?.behavior === 'allow';
    if (request?.subtype === 'can_use_tool') {
      const input = request.input ?? {};
      // 利用者への質問も権限確認の形で届く。答えは updatedInput の answers で返す
      const questions = request.tool_name === 'AskUserQuestion' ? parseQuestions(input) : null;
      if (questions) {
        host.push({
          kind: 'question',
          requestId: event.request_id,
          input,
          title: typeof input.title === 'string' ? input.title : '',
          questions,
          decision: prior ? (allowed ? 'answered' : 'declined') : null,
          answers: (allowed && prior.response.updatedInput?.answers) || {},
        });
        return;
      }
      host.push({
        kind: 'permission',
        requestId: event.request_id,
        toolName: request.tool_name,
        description: request.description ?? '',
        input,
        decision: prior ? (allowed ? 'allow' : 'deny') : null,
      });
      return;
    }
    // 前の接続でエラーを返し済み
    if (prior) return;
    // 未対応のリクエストは応答しないと Claude Code が待ち続けるので、エラーで返す
    host.write({
      type: 'control_response',
      response: { subtype: 'error', request_id: event.request_id, error: `Unsupported request: ${request?.subtype}` },
    });
    host.note(`Unsupported control_request: ${request?.subtype}`, 'error');
  }

  function handleControlResponse(response: any) {
    const requestId = String(response?.request_id ?? '');
    if (requestId.startsWith(INTERRUPT_REQUEST_PREFIX)) {
      if (response.subtype === 'error' && requestId === interruptRequestId) {
        interrupting = false;
        interruptRequestId = null;
        host.interruptFailed(`Could not stop the response: ${stringifyContent(response.error)}`);
      }
      return;
    }
    if (requestId.startsWith(SET_MODEL_REQUEST_PREFIX)) {
      if (response.subtype === 'error') host.note(`Could not change the model: ${stringifyContent(response.error)}`, 'error');
      return;
    }
    // initialize に応えない古い Claude Code では、補完とモデルの一覧が出ないだけにする
    if (requestId !== INITIALIZE_REQUEST_ID || response.subtype !== 'success') return;
    const result = response.response ?? {};
    host.setCommands(
      (result.commands ?? [])
        .filter((command: any) => typeof command?.name === 'string' && command.name)
        .map((command: any) => ({
          name: command.name,
          description: String(command.description ?? ''),
          argumentHint: String(command.argumentHint ?? ''),
        })),
    );
    host.setModels(
      (result.models ?? [])
        // default は、モデルの選択欄の「default model」(指定なし) にあたる
        .filter((model: any) => typeof model?.value === 'string' && model.value && model.value !== 'default')
        .map((model: any) => ({ value: model.value, label: String(model.displayName ?? model.value) })),
    );
  }

  // 続きから始めるセッションの、それまでの会話を画面に並べる (stream-json は過去の会話を送ってこない)
  async function showHistory(sessionId: string) {
    try {
      const entries = parseHistory(await options.readClaudeSessions(sessionId));
      for (const entry of entries) {
        if (entry.type === 'assistant') {
          handleAssistant(entry.message);
        } else if (entry.type === 'compacted') {
          host.note('(context compacted)');
        } else {
          const text = userText(entry.message.content);
          if (text) host.push({ kind: 'user', text });
          handleUser(entry.message);
        }
      }
      // 結果が記録に無いツール (中断されたもの、長すぎて読まなかったもの) を、実行中に見せない
      for (const item of host.items) {
        if (item.kind === 'tool_use' && item.result === null) item.result = '(no result in the session record)';
      }
      host.note(`resumed session ${sessionId}`);
    } catch (e) {
      host.note(`Could not read the session record: ${e}`, 'error');
    }
  }

  return {
    // stream-json は起動直後からメッセージを受け付ける (init イベントは最初のメッセージの後に届く)
    async start() {
      // 使えるスラッシュコマンドとモデルを尋ねる。最初のメッセージより先に届くよう、書き終えてから ready にする
      if (!(await host.write({ type: 'control_request', request_id: INITIALIZE_REQUEST_ID, request: { subtype: 'initialize' } }))) return;
      // 過去の会話を並べ終えるまで送信させない (途中で送ると、新しいメッセージの後ろに過去の会話が並ぶ)
      if (options.resume) await showHistory(options.resume);
      // 永続セッションは、それまでの出力を並べ終えてから送らせる (busy かどうかも再生の最後で決まる)
      await replayed;
      host.setReady(true);
    },

    async listSessions() {
      return parseSessionList(await options.readClaudeSessions(null));
    },

    handleMessage(event: any) {
      switch (event.type) {
        case 'system':
          if (event.subtype === 'init') {
            host.setSession({
              sessionId: event.session_id,
              model: event.model ?? '',
              detail: `${event.tools?.length ?? 0} tools`,
            });
            if (event.cwd) host.setWorkingDirectory(event.cwd);
          }
          break;
        case 'stream_event':
          handleStreamEvent(event.event);
          break;
        case 'assistant':
          handleAssistant(event.message);
          break;
        case 'user': {
          // set_model などの結果は、利用者のメッセージの形で届く
          const output = typeof event.message?.content === 'string' ? event.message.content.match(LOCAL_COMMAND_OUTPUT) : null;
          if (output) {
            if (output[1].trim()) host.note(output[1].trim());
          } else if (options.persistent && typeof event.message?.content === 'string') {
            // --replay-user-messages が返した、利用者のメッセージ。返事 (result) がまだ無ければ、応答中のまま繋がる。
            // 写しを返さないメッセージ (スラッシュコマンドなど) もあり得るので、一致したものより前の送信は写しを待たない
            const content = event.message.content;
            const sent = replaying ? -1 : awaitingEcho.indexOf(content);
            if (sent >= 0) {
              awaitingEcho.splice(0, sent + 1);
            } else {
              const text = userText(content);
              const earlier = sentBefore.indexOf(content);
              if (earlier >= 0) sentBefore.splice(earlier, 1);
              if (text) {
                host.push({ kind: 'user', text });
                if (earlier < 0) outstanding++;
                host.setBusy(outstanding > 0);
              }
            }
          } else {
            handleUser(event.message);
          }
          break;
        }
        // 永続セッションの中継が付けた行 (persistent_session.rs)。前の接続で送った control_response と利用者のメッセージ、再生の終わり
        case 'beckwell_sent': {
          const response = event.payload?.response;
          if (response?.request_id !== undefined) answered.set(String(response.request_id), response);
          const content = event.payload?.type === 'user' ? event.payload.message?.content : undefined;
          if (typeof content === 'string') {
            sentBefore.push(content);
            outstanding++;
          }
          break;
        }
        case 'beckwell_live':
          replaying = false;
          host.setBusy(outstanding > 0);
          endReplay();
          break;
        case 'control_response':
          handleControlResponse(event.response);
          break;
        // /clear で会話が始め直された。この後の init イベントで新しいセッション ID が届く
        case 'conversation_reset':
          host.clear();
          host.note('(conversation cleared)');
          break;
        case 'control_request':
          handleControlRequest(event);
          break;
        case 'rate_limit_event': {
          const windows = event.rate_limit_info?.unifiedWindows;
          if (windows) {
            const percent = (value: number | undefined) => Math.round((value ?? 0) * 100);
            host.setUsage(`5h ${percent(windows.five_hour?.utilization)}% · 7d ${percent(windows.seven_day?.utilization)}%`);
          }
          break;
        }
        case 'result': {
          outstanding = Math.max(0, outstanding - 1);
          host.setBusy(options.persistent ? outstanding > 0 : false);
          // 中止を求めたが、その前にターンが終わっていた時 (success) は中止扱いにしない
          const interrupted = interrupting && event.subtype !== 'success';
          interrupting = false;
          interruptRequestId = null;
          if (interrupted) finishInterruptedTurn(host);
          const seconds = ((event.duration_ms ?? event.duration_api_ms ?? 0) / 1000).toFixed(1);
          const total = event.total_cost_usd ?? costSoFar;
          const cost = Math.max(0, total - costSoFar).toFixed(2);
          costSoFar = total;
          host.push({
            kind: 'result',
            summary: `${event.subtype} · ${event.num_turns ?? 0} turns · ${seconds}s · $${cost}`,
            at: replaying ? null : Date.now(),
            finalText: event.subtype === 'success' && typeof event.result === 'string' ? event.result : undefined,
          });
          // 中止した時は error_during_execution で届く (result は空)。エラーではなく、中止したことを出す
          // 中止と同時に別のエラーで終わった時は、そのエラーも出す
          if (interrupted) {
            host.note('(interrupted)');
            if (event.is_error && event.result) {
              host.note(stringifyContent(event.result), 'error');
            }
          } else if (event.is_error) {
            host.note(stringifyContent(event.result ?? event.errors ?? 'error'), 'error');
          }
          break;
        }
      }
    },

    async send(text: string) {
      interrupting = false;
      interruptRequestId = null;
      if (options.persistent) {
        awaitingEcho.push(text);
        outstanding++;
      }
      const written = await host.write({ type: 'user', message: { role: 'user', content: text } });
      // 届かなかったメッセージには result が返らないので、ここで戻さないと以後送信できなくなる
      if (!written) {
        host.setBusy(false);
        const index = awaitingEcho.lastIndexOf(text);
        if (index >= 0) {
          awaitingEcho.splice(index, 1);
          outstanding = Math.max(0, outstanding - 1);
        }
      }
    },

    // 実行中のツールのコマンドは Claude Code が止める (Bash の子プロセスも残らないことを確認済み)
    async interrupt() {
      interrupting = true;
      const requestId = `${INTERRUPT_REQUEST_PREFIX}${nextInterruptId++}`;
      interruptRequestId = requestId;
      const written = await host.write({ type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } });
      if (!written && interruptRequestId === requestId) {
        interrupting = false;
        interruptRequestId = null;
      }
      return written;
    },

    async setModel(model: string) {
      await host.write({
        type: 'control_request',
        request_id: `${SET_MODEL_REQUEST_PREFIX}${nextSetModelId++}`,
        request: { subtype: 'set_model', model: model || 'default' },
      });
    },

    async respondPermission(item: PermissionItem, decision: PermissionDecision) {
      const response =
        decision === 'allow'
          ? { behavior: 'allow', updatedInput: item.input }
          : { behavior: 'deny', message: 'The user denied this tool call.' };
      const written = await host.write({
        type: 'control_response',
        response: { subtype: 'success', request_id: item.requestId, response },
      });
      // 応答が届かないと Claude Code は待ち続けるので、もう一度押せるように戻す
      if (!written) item.decision = null;
    },

    async answerQuestion(item: QuestionItem, answers: Record<string, string> | null) {
      const response = answers
        ? { behavior: 'allow', updatedInput: { ...item.input, answers } }
        : { behavior: 'deny', message: 'The user declined to answer.' };
      const written = await host.write({
        type: 'control_response',
        response: { subtype: 'success', request_id: item.requestId, response },
      });
      if (!written) item.decision = null;
    },
  };
}
