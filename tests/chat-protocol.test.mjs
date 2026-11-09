import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import vm from 'node:vm';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'astragal-protocol-'));
after(() => fs.rm(root, { recursive: true, force: true }));
for (const name of ['types', 'index', 'claude', 'codex', 'questions', 'claude-sessions']) {
  const source = await fs.readFile(new URL(`../src/chat/beckwell/${name}.ts`, import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace(/from '(\.\/[^']+)'/g, "from '$1.mjs'");
  await fs.writeFile(path.join(root, `${name}.mjs`), js);
}
const { createProtocol } = await import(pathToFileURL(path.join(root, 'index.mjs')));
function setup(agent) {
  const requests = [], directories = [], errors = [];
  const host = {
    items: [], push(item) { this.items.push(item); }, note(text, level) { if (level === 'error') errors.push(text); },
    write: async payload => { requests.push(payload); return true; },
    scrollToBottom() {}, setBusy() {}, setReady() {}, setSession() {}, setUsage() {},
    setWorkingDirectory(cwd) { directories.push(cwd); }, setCommands() {}, setModels() {}, clear() {}, restart() {}, interruptFailed() {},
  };
  return { protocol: createProtocol(agent, host, { resume: null, readClaudeSessions: async () => '' }), host, requests, directories, errors };
}
async function initialize(c) {
  c.protocol.start();
  c.protocol.handleMessage({ id: c.requests.at(-1).id, result: {} });
  await new Promise(resolve => setImmediate(resolve));
  c.protocol.handleMessage({ id: c.requests.at(-1).id, result: { thread: { id: 'same-conversation' }, cwd: '/tmp/first' } });
}
test('Codex changes cwd on a turn without starting a new conversation', async () => {
  const c = setup('codex'); await initialize(c);
  assert.equal(c.protocol.supportsWorkingDirectory, true);
  await c.protocol.send('Continue', { cwd: '/tmp/second project' });
  const request = c.requests.at(-1);
  assert.equal(request.method, 'turn/start');
  assert.equal(request.params.cwd, '/tmp/second project');
  assert.equal(request.params.threadId, 'same-conversation');
  assert.deepEqual(c.directories, ['/tmp/first']);
  c.protocol.handleMessage({ id: request.id, result: { turn: { id: 'turn-2' } } });
  assert.deepEqual(c.directories, ['/tmp/first', '/tmp/second project']);
  assert.equal(c.requests.filter(r => r.method === 'thread/start').length, 1);
});
test('a rejected directory change does not report success', async () => {
  const c = setup('codex'); await initialize(c);
  await c.protocol.send('Continue', { cwd: '/missing' });
  c.protocol.handleMessage({ id: c.requests.at(-1).id, error: { message: 'Directory does not exist' } });
  assert.deepEqual(c.directories, ['/tmp/first']);
  assert.ok(c.errors.some(e => e.includes('Directory does not exist')));
});
test('Claude does not advertise directory following or receive unsupported cwd fields', async () => {
  const c = setup('claude');
  assert.ok(!c.protocol.supportsWorkingDirectory);
  await c.protocol.send('Continue');
  assert.equal(c.requests.at(-1).type, 'user');
  assert.ok(!('cwd' in c.requests.at(-1)));
});

const commandBlock = '```astragal-terminal\nprintf safe\n```';
test('Claude exposes only the final result for writeback', () => {
  const c = setup('claude');
  c.protocol.handleMessage({ type: 'assistant', message: { content: [{ type: 'text', text: commandBlock }] } });
  c.protocol.handleMessage({ type: 'result', subtype: 'success', result: 'Do not run that command.' });
  assert.equal(c.host.items.at(-1).finalText, 'Do not run that command.');
  c.protocol.handleMessage({ type: 'result', subtype: 'success' });
  assert.equal(c.host.items.at(-1).finalText, undefined);
});

test('Codex writeback ignores interim phases and withdrawn commands', async () => {
  const c = setup('codex'); await initialize(c);
  const completed = item => c.protocol.handleMessage({ method: 'item/completed', params: { threadId: 'same-conversation', item } });
  const finish = () => {
    c.protocol.handleMessage({ method: 'turn/completed', params: { threadId: 'same-conversation', turn: { status: 'completed' } } });
    return c.host.items.at(-1).finalText;
  };
  // Arrange / Act: even an explicit command in a non-final phase must not be pasted.
  for (const phase of ['commentary', 'partial_answer']) {
    completed({ type: 'agentMessage', id: phase, text: commandBlock, phase });
    assert.equal(finish(), undefined);
  }
  completed({ type: 'agentMessage', id: 'old', text: commandBlock });
  completed({ type: 'agentMessage', id: 'final', text: 'Do not run that command.', phase: 'final_answer' });
  assert.equal(finish(), 'Do not run that command.');
  // Older providers omit phase. Accept a completed last text only until more work begins.
  completed({ type: 'agentMessage', id: 'legacy', text: commandBlock });
  assert.equal(finish(), commandBlock);
  c.protocol.handleMessage({ method: 'item/started', params: { item: { type: 'commandExecution', id: 'tool', command: 'pwd' } } });
  assert.equal(finish(), undefined);
});

// Exercise the actual pane functions with only IPC and animation scheduling replaced.
// Test exports are appended in memory; production files do not expose internal state.
const paneSource = await fs.readFile(new URL('../src/chat/pane.ts', import.meta.url), 'utf8');
const contextSource = await fs.readFile(new URL('../src/chat/context.ts', import.meta.url), 'utf8');
function commonjs(source) {
  return ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
}
const contextModule = { exports: {} };
vm.runInNewContext(commonjs(contextSource), { exports: contextModule.exports });
function paneFixture(invoke) {
  const module = { exports: {} };
  vm.runInNewContext(commonjs(paneSource + '\nexport const testPane = { start, restart, interrupt, respondPermission, answerQuestion, complete, insertCode, conversations, select(c) { visible = true; currentSession = () => c.session; } };'), {
    exports: module.exports, queueMicrotask, requestAnimationFrame() {},
    require(name) {
      if (name === '@tauri-apps/api/core') return { invoke };
      if (name === './beckwell') return { createProtocol };
      if (name === './context') return contextModule.exports;
      return {};
    },
  });
  const pane = module.exports.testPane;
  const c = { session: { id: 1 }, provider: 'claude', cwd: '/tmp', items: [], process: null, stopped: false, starting: false, ready: false, busy: false, revision: 1, interrupted: false, autoPaste: false };
  pane.conversations.set(1, c);
  return { pane, c };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('manual block input uses the selected terminal despite edits, without an Enter', () => {
  const { pane, c } = paneFixture(async () => {});
  const pasted = [];
  let focused = false;
  c.session.context = { dirty: true, atPrompt: false, revision: 99, input() { this.revision++; } };
  c.session.terminal = {
    buffer: { active: { type: 'normal' } }, modes: { bracketedPasteMode: true }, options: {},
    paste(text) { pasted.push(text); }, focus() { focused = true; },
  };
  pane.select(c);
  pane.insertCode(c, 'echo one\necho two\n');
  assert.deepEqual(pasted, ['echo one\necho two']);
  assert.equal(focused, true);
  assert.equal(c.revision, null);
  assert.equal(c.session.context.revision, 100);

  c.session.terminal.options.ignoreBracketedPasteMode = true;
  pane.insertCode(c, 'echo three\necho four\n');
  assert.equal(pasted.length, 1);
  c.session.terminal.buffer.active.type = 'alternate';
  pane.insertCode(c, 'echo five\n');
  assert.equal(pasted.length, 1);
  c.session.terminal.buffer.active.type = 'normal';
  c.session.exited = true;
  pane.insertCode(c, 'echo six\n');
  assert.equal(pasted.length, 1);
  c.session.exited = false;
  pane.select({ session: { id: 2 } });
  pane.insertCode(c, 'echo seven\n');
  assert.equal(pasted.length, 1);
});
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('answered approval and question cards send only one response and retain answers', async () => {
  const writes = [];
  const { pane, c } = paneFixture(async (cmd, args) => { if (cmd === 'agent_write') writes.push(JSON.parse(args.line)); });
  await pane.start(c); await settle();
  const permission = { kind: 'permission', requestId: 'p', input: {}, decision: null };
  const question = { kind: 'question', requestId: 'q', input: {}, decision: null, answers: {} };
  c.items.push(permission, question);
  await Promise.all([pane.respondPermission(c, permission, 'allow'), pane.respondPermission(c, permission, 'deny')]);
  await Promise.all([pane.answerQuestion(c, question, { Scope: 'Local' }), pane.answerQuestion(c, question, null)]);
  assert.equal(permission.decision, 'allow');
  assert.equal(question.decision, 'answered');
  assert.equal(question.answers.Scope, 'Local');
  assert.equal(writes.filter(w => w.response?.request_id === 'p').length, 1);
  assert.equal(writes.filter(w => w.response?.request_id === 'q').length, 1);
  await pane.interrupt(c);
  assert.equal(writes.filter(w => w.type === 'control_response').length, 2);
});

test('failed approval delivery restores the pending card', async () => {
  const { pane, c } = paneFixture(async (cmd, args) => {
    if (cmd === 'agent_write' && JSON.parse(args.line).type === 'control_response') throw new Error('disconnected');
  });
  await pane.start(c); await settle();
  const permission = { kind: 'permission', requestId: 'p', input: {}, decision: null };
  c.items.push(permission);
  await pane.respondPermission(c, permission, 'allow');
  assert.equal(permission.decision, null);
});

test('an old write rejection cannot disconnect a restarted conversation', async () => {
  const pending = deferred();
  const { pane, c } = paneFixture(async (cmd, args) => {
    if (cmd === 'agent_write' && JSON.parse(args.line).type === 'user') return pending.promise;
  });
  await pane.start(c); await settle();
  const sending = c.protocol.send('old request');
  await pane.restart(c); await settle();
  c.busy = true;
  pending.reject(new Error('old process failed'));
  await sending;
  assert.equal(c.ready, true);
  assert.equal(c.busy, true);
  assert.ok(!c.items.some(i => i.text?.includes('old process failed')));
});

test('Stop does not interrupt a new conversation while an old denial is pending', async () => {
  const pending = deferred(), writes = [];
  const { pane, c } = paneFixture(async (cmd, args) => {
    if (cmd !== 'agent_write') return;
    const payload = JSON.parse(args.line); writes.push({ id: args.id, payload });
    if (payload.type === 'control_response') return pending.promise;
  });
  await pane.start(c); await settle();
  c.items.push({ kind: 'permission', requestId: 'p', input: {}, decision: null });
  const stopping = pane.interrupt(c);
  await pane.restart(c); await settle();
  pending.resolve(); await stopping;
  assert.ok(!writes.some(w => w.payload.request?.subtype === 'interrupt'));
  assert.equal(c.ready, true);
  assert.ok(!c.items.some(item => item.level === 'error'));
});

test('pane writeback uses final text and cannot reuse intermediate blocks', () => {
  const { pane, c } = paneFixture(async () => {});
  c.items.push({ kind: 'text', text: commandBlock });
  pane.complete(c, 'Do not run that command.');
  assert.equal(c.command, null);
  pane.complete(c);
  assert.equal(c.command, null);
  pane.complete(c, commandBlock);
  assert.equal(c.command, 'printf safe');
});

test('Codex interrupt recovery resumes the thread and preserves the visible transcript', async () => {
  // Arrange: a conversation with an unfinished shell command.
  const writes = [], stopped = [];
  const { pane, c } = paneFixture(async (cmd, args) => {
    if (cmd === 'agent_write') writes.push({ process: args.id, ...JSON.parse(args.line) });
    if (cmd === 'agent_stop') stopped.push(args.id);
  });
  c.provider = 'codex';
  async function handshake(expectedMethod) {
    c.protocol.handleMessage({ id: writes.at(-1).id, result: {} });
    await settle();
    const request = writes.at(-1);
    assert.equal(request.method, expectedMethod);
    c.protocol.handleMessage({ id: request.id, result: { thread: { id: 'kept-thread', turns: [] }, cwd: '/tmp' } });
    return request;
  }
  await pane.start(c);
  await handshake('thread/start');
  const user = { kind: 'user', text: 'Keep this context' };
  c.items.push(user);
  await c.protocol.send(user.text);
  c.protocol.handleMessage({ id: writes.at(-1).id, result: { turn: { id: 'running-turn' } } });
  c.protocol.handleMessage({ method: 'item/started', params: { threadId: 'kept-thread', item: { type: 'commandExecution', id: 'shell', command: 'sleep 60' } } });
  const oldProcess = c.process;

  // Act: Stop requires process recovery because the command is still running.
  await pane.interrupt(c);
  assert.equal(writes.at(-1).method, 'turn/interrupt');
  c.protocol.handleMessage({ method: 'turn/completed', params: { threadId: 'kept-thread', turn: { status: 'interrupted' } } });
  await settle();
  const resumed = await handshake('thread/resume');

  // Assert: reconnect to the same server-side thread without replaying or clearing UI history.
  assert.equal(resumed.params.threadId, 'kept-thread');
  assert.deepEqual(stopped, [oldProcess]);
  assert.notEqual(c.process, oldProcess);
  assert.equal(c.ready, true);
  assert.equal(c.items.filter(item => item === user).length, 1);
  assert.equal(c.command, null);
  await c.protocol.send('Continue');
  assert.equal(writes.at(-1).params.threadId, 'kept-thread');

  // Explicit New chat still starts a fresh conversation.
  await pane.restart(c);
  await handshake('thread/start');
  assert.ok(!c.items.includes(user));
});
