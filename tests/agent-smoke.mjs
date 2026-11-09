// Opt-in live subscription test: node tests/agent-smoke.mjs claude|codex
// Only a synthetic request is sent; no terminal or project contents are used.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import ts from 'typescript';
const provider = process.argv[2];
if (!['claude', 'codex'].includes(provider)) throw new Error('Pass claude or codex');
const followDirectory = process.argv.includes('--follow-directory');
if (followDirectory && provider !== 'codex') throw new Error('Directory following requires Codex');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'astragal-agent-test-'));
let child;
let deadline;
try {
  for (const name of ['types', 'index', 'claude', 'codex', 'questions', 'claude-sessions']) {
    const source = await fs.readFile(new URL(`../src/chat/beckwell/${name}.ts`, import.meta.url), 'utf8');
    const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace(/from '(\.\/[^']+)'/g, "from '$1.mjs'");
    await fs.writeFile(path.join(root, `${name}.mjs`), js);
  }
  const { createProtocol } = await import(pathToFileURL(path.join(root, 'index.mjs')));
  const items = [];
  let readyResolve, doneResolve, failed = '', workingDirectory = '';
  const ready = new Promise(r => readyResolve = r);
  let done = new Promise(r => doneResolve = r);
  const host = {
    items, push(item) { items.push(item); if (item.kind === 'result') doneResolve(); },
    note(text, level) { if (level === 'error') { failed = text; doneResolve(); } },
    scrollToBottom() {}, write(payload) { child.stdin.write(JSON.stringify(payload) + '\n'); return Promise.resolve(true); },
    setBusy() {}, setReady(value) { if (value) readyResolve(); }, setSession() {}, setUsage() {}, setWorkingDirectory(value) { workingDirectory = value; }, setCommands() {}, setModels() {}, clear() {}, restart() { failed = 'Unexpected restart'; doneResolve(); }, interruptFailed() {},
  };
  const protocol = createProtocol(provider, host, { resume: null, readClaudeSessions: async () => '' });
  const argv = provider === 'claude' ? ['claude', '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-prompt-tool', 'stdio'] : ['codex', 'app-server'];
  const launcher = 'exec 3>&1 4>&2 5<&0 1>/dev/null 2>/dev/null </dev/null; s=$1; shift; if "$s" -lic \': >&3\' </dev/null; then f=-lic; else f=-lc; fi; exec "$s" "$f" \'cd -- "$1" 2>&4 || exit 1; shift; exec "$@" 0<&5 1>&3 2>&4 3>&- 4>&- 5<&-\' astragal "$@"';
  child = spawn('/bin/sh', ['-c', launcher, 'astragal', process.env.SHELL || '/bin/zsh', root, ...argv], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  child.on('exit', (code) => { if (code) failed = `Agent exited: ${code}`; readyResolve(); doneResolve(); });
  readline.createInterface({ input: child.stdout }).on('line', line => {
    try { protocol.handleMessage(JSON.parse(line)); } catch (e) { failed = String(e); doneResolve(); }
  });
  deadline = setTimeout(() => { failed = 'Timed out after 90 seconds'; readyResolve(); doneResolve(); }, 90000);
  protocol.start();
  await ready;
  if (!failed) {
    items.push({ kind: 'user', text: 'Test' });
    await protocol.send('This is a connectivity test. Do not use any tools or read files. Reply with exactly ASTRAGAL_CHAT_OK.');
    await done;
  }
  const response = items.filter(item => item.kind === 'text').map(item => item.text).join('');
  if (failed || !response.includes('ASTRAGAL_CHAT_OK')) throw new Error(failed || 'Expected response was not received');
  if (!items.findLast(item => item.kind === 'result')?.finalText?.includes('ASTRAGAL_CHAT_OK')) {
    throw new Error('The final response was not available for terminal writeback');
  }
  if (followDirectory) {
    const directory = path.join(root, 'followed-project');
    await fs.mkdir(directory);
    const start = items.length;
    done = new Promise(r => doneResolve = r);
    await protocol.send('This is another connectivity test. Do not use tools or read files. Report the cwd given in your environment context and the exact marker you replied with previously.', { cwd: directory });
    await done;
    const next = items.slice(start).filter(item => item.kind === 'text').map(item => item.text).join('');
    if (failed || workingDirectory !== directory || !next.includes('followed-project') || !next.includes('ASTRAGAL_CHAT_OK')) {
      throw new Error(failed || 'Directory change or conversation continuity was not confirmed');
    }
    console.log('codex: changed directory on the existing conversation and retained the prior turn');
  }
  clearTimeout(deadline);
  console.log(`${provider}: initialized, streamed response, and completed a turn successfully`);
} finally {
  clearTimeout(deadline);
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 2000);
    await new Promise(resolve => child.once('exit', resolve)); clearTimeout(force);
  }
  await fs.rm(root, { recursive: true, force: true });
}
