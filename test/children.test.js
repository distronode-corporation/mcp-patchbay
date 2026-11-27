// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

// ChildProcessTransport and Child on their own, driven by small scripted children: the paths the
// end-to-end suites do not reach (broken pipes, oversized output, pagination, requests the
// patchbay's client must refuse).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AUTH_MARKER, Child, ChildProcessTransport, isMcpRemote } from '../src/children.js';
import { validateConfig } from '../src/config.js';
import { createLogger } from '../src/log.js';
import { POSIX_ONLY, ROOT, tmpdir } from './helpers.js';

const SCRIPTED = path.join(ROOT, 'test', 'fixtures', 'scripted-server.mjs');
const OAUTH = { configDir: '', authTimeoutSeconds: 30 };

/** A transport running `node -e <code>`. */
function nodeTransport(code, extra = {}) {
  return new ChildProcessTransport({ command: process.execPath, args: ['-e', code], env: { ...process.env }, secrets: [], ...extra });
}

/** Resolves once `check()` is true, polling every 20 ms; rejects after `ms`. */
async function until(check, ms = 10000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A validated stdio entry running the scripted server with `env`. */
function scriptedEntry(env, extra = {}) {
  return validateConfig({ version: 1, servers: { scripted: { policy: 'allow', command: process.execPath, args: [SCRIPTED], env, ...extra } } }).servers.scripted;
}

/** A Child with a debug logger whose lines are collected in `lines`. */
function childOf(entry, o = {}) {
  const lines = [];
  const log = createLogger({ debug: true, write: (s) => lines.push(s) });
  const child = new Child({ entry, oauth: { ...OAUTH, configDir: path.join(tmpdir(), 'oauth') }, clientCapabilities: {}, log, ...o });
  return { child, lines };
}

test('isMcpRemote: an entry with no command, and a runner with no args, are not mcp-remote', () => {
  assert.equal(isMcpRemote({ kind: 'stdio' }), false);
  assert.equal(isMcpRemote({ kind: 'stdio', command: 'npx' }), false);
  assert.equal(isMcpRemote({ kind: 'stdio', command: 'npx', args: ['-y', 'mcp-remote@0.15.2'] }), true);
});

test('a command spawn refuses outright (a NUL byte) rejects start', async () => {
  const t = new ChildProcessTransport({ command: 'no\0such', args: [], env: { ...process.env }, secrets: [] });
  await assert.rejects(t.start(), (e) => /** @type {any} */ (e).code === 'ERR_INVALID_ARG_VALUE');
});

test('a transport that never started: send rejects, killNow is 0, and close still reports closed', async () => {
  const t = nodeTransport('');
  let closed = 0;
  t.onclose = () => { closed++; };
  await assert.rejects(t.send({ jsonrpc: '2.0', method: 'ping', id: 1 }), /child is not running/);
  assert.equal(t.killNow(), 0);
  await t.close();
  assert.equal(closed, 1);
});

test('a child that closes its stdin: writes fail with EPIPE, reported once through onerror, never thrown', { skip: POSIX_ONLY }, async () => {
  // Closing fd 0 itself, not process.stdin, leaves the pipe with no reader.
  const t = nodeTransport('require("fs").closeSync(0); process.stderr.write("closed\\n"); setInterval(() => {}, 1e5)');
  const errors = [];
  t.onerror = (e) => errors.push(e.message);
  await t.start();
  try {
    await until(() => t.stderr.lines(5).includes('closed'));
    await assert.rejects(t.send({ jsonrpc: '2.0', method: 'ping', id: 1 }), (e) => /** @type {any} */ (e).code === 'EPIPE');
    await until(() => errors.length > 0);
    assert.deepEqual(errors, ['stdin: EPIPE']);
  } finally {
    await t.close();
  }
});

test('stdout: blank lines are skipped, a long line with its newline is kept as noise, one without is discarded', async () => {
  const code = [
    'const w = (s) => new Promise((r) => process.stdout.write(s, () => setTimeout(r, 150)));',
    // Two unterminated writes: even if the first shares a read with the line before it, the
    // second arrives on its own and finds the buffer over the limit with no newline.
    '(async () => { await w("\\n\\n"); await w("y".repeat(300) + "\\n"); await w("x".repeat(300)); await w("x".repeat(300)); })();',
  ].join('\n');
  const t = nodeTransport(code, { maxLine: 100 });
  await t.start();
  await until(() => t.closed);
  const noise = t.noise.lines(5);
  assert.equal(noise[0], 'y'.repeat(300), 'the blank lines left nothing, the long line is kept');
  assert.match(noise[1], /^\[discarded (300|600) bytes without a newline\]$/);
});

test('a message handler that throws is reported through onerror and the transport goes on', async () => {
  const t = nodeTransport('process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/one" }) + "\\n" + JSON.stringify({ jsonrpc: "2.0", method: "notifications/two" }) + "\\n")');
  const seen = [];
  const errors = [];
  t.onmessage = (m) => {
    seen.push(m.method);
    if (m.method === 'notifications/one') throw new Error('handler failed');
  };
  t.onerror = (e) => errors.push(e.message);
  await t.start();
  await until(() => t.closed);
  assert.deepEqual(seen, ['notifications/one', 'notifications/two']);
  assert.deepEqual(errors, ['handler failed']);
});

test('stderr past 1 MiB without a newline keeps only its last 4 KiB; with a newline in it, the line is whole', async () => {
  const MiB = 1024 * 1024;
  const code = [
    'const w = (s) => new Promise((r) => process.stderr.write(s, () => setTimeout(r, 100)));',
    `(async () => { await w("a".repeat(${MiB - 10})); await w("b".repeat(20) + "\\n"); await w("c".repeat(${MiB + 10})); await w("\\n"); })();`,
  ].join('\n');
  const raws = [];
  const t = nodeTransport(code, { onStderrLine: (raw) => raws.push(raw.length) });
  await t.start();
  await until(() => t.closed);
  assert.equal(raws.length, 2);
  assert.equal(raws[0], MiB + 10, 'a buffer over 1 MiB that holds a newline is not cut');
  assert.ok(raws[1] <= 4096 + 64 * 1024, `the second line was cut to its tail (${raws[1]} characters)`);
});

test('a Child that never started has no pid, no noise, nothing to kill, and declares no capabilities', async () => {
  const entry = scriptedEntry({});
  const child = new Child({ entry, oauth: OAUTH, log: createLogger({ write: () => {} }) });
  assert.equal(child.pid, 0);
  assert.deepEqual(child.noiseTail(), []);
  assert.deepEqual(child.stderrTail(), []);
  assert.equal(child.killNow(), 0);
  assert.deepEqual(child.childCapabilities(), {});
  await child.close();
});

test('a configured cwd that does not exist is refused before spawning', async () => {
  const dir = tmpdir();
  const { child } = childOf(scriptedEntry({}, { cwd: path.join(dir, 'gone') }));
  await assert.rejects(child.start(5000), /the configured cwd does not exist or is not a directory/);
  const file = path.join(dir, 'file');
  fs.writeFileSync(file, '');
  const { child: second } = childOf(scriptedEntry({}, { cwd: file }));
  await assert.rejects(second.start(5000), /the configured cwd does not exist or is not a directory/);
});

test('listTools follows nextCursor across pages and stops on a cursor that repeats', async (t) => {
  const { child } = childOf(scriptedEntry({ SCRIPTED_PAGES: 'a,b|c|d' }));
  t.after(() => child.close());
  await child.start(10000);
  assert.deepEqual((await child.listTools(10000)).map((x) => x.name), ['a', 'b', 'c', 'd']);

  const { child: looping } = childOf(scriptedEntry({ SCRIPTED_PAGES: 'a|b|c', SCRIPTED_SAME_CURSOR: '1' }));
  t.after(() => looping.close());
  await looping.start(10000);
  assert.deepEqual((await looping.listTools(10000)).map((x) => x.name), ['a', 'b']);
});

test('requests the patchbay\'s client did not declare, or does not know, are refused as method not found', async (t) => {
  const { child } = childOf(scriptedEntry({ SCRIPTED_REQUESTS: 'elicitation/create,custom/thing' }));
  t.after(() => child.close());
  await child.start(10000);
  await until(() => child.stderrTail(10).filter((l) => l.startsWith('answer ')).length === 2);
  const answers = Object.fromEntries(child.stderrTail(10).filter((l) => l.startsWith('answer ')).map((l) => {
    const [, method, json] = /^answer (\S+) (.*)$/.exec(l) ?? [];
    return [method, JSON.parse(json)];
  }));
  assert.equal(answers['elicitation/create'].code, -32601);
  assert.match(answers['elicitation/create'].message, /elicitation\/create is not available: the patchbay's client did not declare the elicitation capability/);
  assert.equal(answers['custom/thing'].code, -32601);
  assert.match(answers['custom/thing'].message, /Method not found: custom\/thing/);
});

test('a protocol error from the child is logged at debug level, with the server name', async (t) => {
  const { child, lines } = childOf(scriptedEntry({ SCRIPTED_STRAY: '1' }));
  t.after(() => child.close());
  await child.start(10000);
  await until(() => lines.some((l) => l.includes('client error')));
  assert.ok(lines.some((l) => /^\[mcp-patchbay\] debug: \[scripted\] client error: /.test(l)), lines.join(''));
});

test('rootsListChanged notifies a running child, and only logs when the child is gone', async () => {
  const { child, lines } = childOf(scriptedEntry({}), { clientCapabilities: { roots: {} }, handlers: { roots: async () => ({ roots: [] }) } });
  await child.start(10000);
  await child.rootsListChanged();
  assert.ok(!lines.some((l) => l.includes('roots list_changed not sent')));
  await child.close();
  await child.rootsListChanged();
  assert.ok(lines.some((l) => /debug: \[scripted\] roots list_changed not sent: /.test(l)), lines.join(''));
});

test('a sign-in line without its URL waits up to three non-blank lines for it', async () => {
  const dir = tmpdir();
  const remote = path.join(dir, 'remote.mjs');
  fs.writeFileSync(remote, [
    `console.error(${JSON.stringify(AUTH_MARKER)});`,
    'console.error("");',
    'console.error("noise before the url");',
    'console.error("https://auth.example.com/authorize?state=one");',
    `console.error(${JSON.stringify(AUTH_MARKER)});`,
    'console.error("a"); console.error("b"); console.error("c");',
    'console.error("https://auth.example.com/authorize?state=too-late");',
  ].join('\n'));
  const entry = validateConfig({ version: 1, servers: { remote: { policy: 'allow', url: 'https://mcp.example.com/mcp' } } }).servers.remote;
  const { child } = childOf(entry, { env: { ...process.env, MCP_PATCHBAY_MCP_REMOTE_BIN: remote } });
  const urls = [];
  child.on('auth-url', (u) => urls.push(u));
  await assert.rejects(child.start(10000));
  await child.close();
  assert.deepEqual(urls, ['https://auth.example.com/authorize?state=one']);
});
