// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

// The Patchbay in this process, with an SDK client over an in-memory transport and scripted
// children, for the paths the end-to-end suites cannot time: requests that overlap, children
// that answer late or wrongly, and clients without elicitation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { AUTH_MARKER } from '../src/children.js';
import { validateConfig } from '../src/config.js';
import { createLogger } from '../src/log.js';
import { PidFiles } from '../src/process.js';
import { Patchbay } from '../src/server.js';
import { POSIX_ONLY, ROOT, tmpdir } from './helpers.js';

const SCRIPTED = path.join(ROOT, 'test', 'fixtures', 'scripted-server.mjs');
const AUTH_URL = 'https://auth.example.com/authorize?state=scripted';
const parse = (r) => JSON.parse(r.content[0].text);

/** A scripted stdio server entry. */
const scripted = (env = {}, extra = {}) => ({ policy: 'allow', command: process.execPath, args: [SCRIPTED], env: { SCRIPTED_PAGES: 'one', ...env }, ...extra });

/** Resolves once `check()` is true, polling every 20 ms; rejects after `ms`. */
async function until(check, ms = 10000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * A Patchbay for `servers`, without a client yet. Children are closed after the test.
 * @param {any} t
 * @param {Record<string, any>} servers
 * @param {{config?: any, pidFiles?: any, env?: any, startTimeoutMs?: number}} [o]
 */
function patchbay(t, servers, o = {}) {
  const lines = [];
  const log = createLogger({ debug: true, write: (s) => lines.push(s) });
  const config = validateConfig({ version: 1, servers, ...o.config });
  const pb = new Patchbay(config, { log, pidFiles: o.pidFiles ?? null, env: o.env ?? process.env, projectDir: tmpdir(), startTimeoutMs: o.startTimeoutMs });
  t.after(async () => {
    for (const slot of pb.slots.values()) {
      for (const c of [slot.child, slot.lastChild]) {
        if (c?.pid) try { process.kill(c.pid, 'SIGKILL'); } catch { /* gone */ }
        await c?.close().catch(() => {});
      }
    }
  });
  return { pb, lines, logged: (re) => lines.some((l) => re.test(l)) };
}

/**
 * The Patchbay connected to an SDK client declaring `caps`.
 * @param {any} t
 * @param {Record<string, any>} servers
 * @param {{caps?: any, onElicit?: (req: any) => any, config?: any, env?: any, pidFiles?: any, startTimeoutMs?: number}} [o]
 */
async function connected(t, servers, o = {}) {
  const made = patchbay(t, servers, o);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await made.pb.connect(serverSide);
  const client = new Client({ name: 'server-test', version: '1.0.0' }, { capabilities: o.caps ?? {} });
  if (o.onElicit) client.setRequestHandler(ElicitRequestSchema, o.onElicit);
  // As a host does: list again on list_changed, which is what an enable waits for.
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => { client.listTools().catch(() => {}); });
  await client.connect(clientSide);
  t.after(() => client.close());
  const call = async (name, args) => client.callTool({ name, arguments: args });
  return { ...made, client, clientSide, call };
}

test('whenClientReady waits for the client, and gives up after 30 s without one', async (t) => {
  const { pb } = patchbay(t, {});
  const waiting = pb.whenClientReady();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await pb.connect(serverSide);
  const client = new Client({ name: 'late', version: '1.0.0' });
  await client.connect(clientSide);
  t.after(() => client.close());
  assert.equal(await waiting, true);
  assert.equal(await pb.whenClientReady(), true, 'at once once initialized');

  const { pb: alone } = patchbay(t, {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const never = alone.whenClientReady();
  t.mock.timers.tick(30000);
  assert.equal(await never, false);
});

test('a protocol error from the client is logged at debug level', async (t) => {
  const { clientSide, lines } = await connected(t, {});
  await clientSide.send({ jsonrpc: '2.0', id: 4242, result: {} });
  await until(() => lines.some((l) => l.includes('debug: protocol: ')));
});

test('a tools/call with no arguments object is a call with none', async (t) => {
  const { client } = await connected(t, {});
  const { CallToolResultSchema } = await import('@modelcontextprotocol/sdk/types.js');
  const r = await client.request({ method: 'tools/call', params: { name: 'servers' } }, CallToolResultSchema);
  assert.deepEqual(parse(r).servers, []);
});

test('roots/list_changed from the client reaches the children that are on, and only those', async (t) => {
  const { pb, client, call } = await connected(t, { on: scripted({ SCRIPTED_ECHO: '1' }), off: scripted({ SCRIPTED_ECHO: '1' }) }, { caps: { roots: { listChanged: true } } });
  client.setRequestHandler((await import('@modelcontextprotocol/sdk/types.js')).ListRootsRequestSchema, async () => ({ roots: [] }));
  assert.equal((await call('enable', { name: 'on' })).isError, undefined);
  await client.sendRootsListChanged();
  const on = pb.slots.get('on');
  await until(() => on.child.stderrTail(10).includes('got notifications/roots/list_changed'));
  assert.equal(pb.slots.get('off').child, null);
});

test('tools the patchbay cannot publish are listed as skipped by servers, enable and info', async (t) => {
  const long = 'x'.repeat(130);
  const { call, logged } = await connected(t, { odd: scripted({ SCRIPTED_PAGES: `ok,${long}` }) });
  const enabled = parse(await call('enable', { name: 'odd' }));
  assert.equal(enabled.toolCount, 1);
  assert.equal(enabled.skippedTools[0].tool, long);
  assert.match(enabled.skippedTools[0].reason, /name too long/);
  assert.deepEqual(parse(await call('servers', {})).servers[0].skippedTools, enabled.skippedTools);
  assert.deepEqual(parse(await call('info', { name: 'odd' })).skippedTools, enabled.skippedTools);
  assert.ok(logged(/info: odd: on, 1 tools, 1 skipped/));
});

test('two enables of a confirm server at once ask the person one question', async (t) => {
  let asked = 0;
  /** @type {(v: any) => void} */
  let answer = () => {};
  const { call } = await connected(t, { quiet: scripted({}, { policy: 'confirm' }) }, {
    caps: { elicitation: { form: {} } },
    onElicit: (req) => {
      asked++;
      assert.equal(req.params.message, 'Allow the agent to turn on quiet?', 'no description, no parentheses');
      return new Promise((r) => { answer = r; });
    },
  });
  const a = call('enable', { name: 'quiet' });
  const b = call('enable', { name: 'quiet' });
  await until(() => asked === 1);
  answer({ action: 'accept', content: { allow: true } });
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(asked, 1);
  assert.equal(parse(ra).state, 'on');
  assert.equal(parse(rb).state, 'on');
});

test('a confirmation the client fails to answer fails closed', async (t) => {
  const { pb, call } = await connected(t, { ask: scripted({}, { policy: 'confirm', description: 'Asks' }) }, {
    caps: { elicitation: { form: {} } },
    onElicit: () => { throw new Error('the dialog crashed'); },
  });
  const r = await call('enable', { name: 'ask' });
  assert.equal(r.isError, true);
  assert.match(parse(r).error, /^ask was not approved: the confirmation failed \(.*the dialog crashed.*\)\.$/);
  assert.equal(pb.slots.get('ask').state, 'off');
});

test('a confirm server that another start turned on while the person was asked is reported as already on', async (t) => {
  let answer = () => {};
  const { pb, call } = await connected(t, { ask: scripted({}, { policy: 'confirm' }) }, {
    caps: { elicitation: { form: {} } },
    onElicit: () => new Promise((r) => { answer = () => r({ action: 'accept', content: { allow: true } }); }),
  });
  const slot = pb.slots.get('ask');
  const enabling = call('enable', { name: 'ask' });
  await until(() => slot.confirmPromise !== null);
  // What autostart does for a project's list: start without asking.
  assert.equal((await pb.startSlot(slot)).ok, true);
  answer();
  const r = parse(await enabling);
  assert.equal(r.state, 'on');
  assert.equal(r.message, 'already on');
});

test('disable, restart and info refuse a name that is not configured', async (t) => {
  const { call } = await connected(t, { real: scripted() });
  for (const tool of ['disable', 'restart', 'info']) {
    const r = await call(tool, { name: 'imaginary' });
    assert.equal(r.isError, true, tool);
    assert.match(parse(r).error, /^unknown server "imaginary"; call servers for the list$/, tool);
  }
});

test('disabling a failed server resets it to off', async (t) => {
  const { pb, call } = await connected(t, { broken: scripted({ SCRIPTED_INIT_ERROR: '1' }) });
  assert.equal((await call('enable', { name: 'broken' })).isError, true);
  assert.equal(pb.slots.get('broken').state, 'failed');
  const r = parse(await call('disable', { name: 'broken' }));
  assert.deepEqual(r, { name: 'broken', state: 'off', message: 'was failed; reset to off' });
  assert.equal(pb.slots.get('broken').lastError, undefined);
});

test('restart refuses a server that is still starting, and one with calls in flight', async (t) => {
  const { pb, call } = await connected(t, { slow: scripted({ SCRIPTED_LIST_DELAY_MS: '400', SCRIPTED_CALL_DELAY_MS: '400' }) });
  const slot = pb.slots.get('slow');
  const starting = call('enable', { name: 'slow' });
  await until(() => slot.state === 'starting');
  const r = await call('restart', { name: 'slow' });
  assert.equal(r.isError, true);
  assert.match(parse(r).error, /^slow is starting; wait for it, or disable it first$/);
  await starting;
  const calling = call('slow__one', {});
  await until(() => slot.inFlight === 1);
  const busy = await call('restart', { name: 'slow' });
  assert.equal(busy.isError, true);
  assert.deepEqual(parse(busy), { error: 'slow has 1 call(s) in flight; try again when they finish', name: 'slow', inFlight: 1 });
  assert.equal((await calling).content[0].text, 'called one');
});

test('startSlot called twice while starting returns the same start', async (t) => {
  const { pb } = patchbay(t, { one: scripted({ SCRIPTED_LIST_DELAY_MS: '100' }) });
  const slot = pb.slots.get('one');
  const a = pb.startSlot(slot);
  assert.equal(pb.startSlot(slot), a);
  assert.equal((await a).ok, true);
});

test('a disable that lands as the start finishes stops it: the start reports it was disabled', async (t) => {
  // refresh() runs in the last step of a start, after initialize; a disable then is the one
  // that wins the race with the start's own checks.
  /** @type {Patchbay} */
  let pb;
  const pidFiles = { enabled: false, record() {}, refresh() { void pb.toolDisable('late'); }, remove() {} };
  ({ pb } = patchbay(t, { late: scripted() }, { pidFiles }));
  const r = await pb.startSlot(pb.slots.get('late'));
  assert.deepEqual(r, { ok: false, error: 'disabled while starting' });
  assert.equal(pb.slots.get('late').state, 'off');
});

test('a disable while the start lists tools stops it, even when the child answers anyway', async (t) => {
  const { pb } = patchbay(t, { stubborn: scripted({ SCRIPTED_HOLD: '1', SCRIPTED_ECHO: '1', SCRIPTED_LIST_DELAY_MS: '300' }) });
  const slot = pb.slots.get('stubborn');
  const child = () => /** @type {any} */ (slot.child);
  const starting = pb.startSlot(slot);
  await until(() => child()?.stderrTail(5).includes('got tools/list')); // initialize done, tools/list waiting
  const disabling = pb.toolDisable('stubborn');
  assert.deepEqual(await starting, { ok: false, error: 'disabled while starting' });
  await disabling;
  assert.equal(slot.state, 'off');
});

test('start errors: a command that is not executable, no answer in time, an error answer with the last stderr line', { skip: POSIX_ONLY }, async (t) => {
  const dir = tmpdir();
  const plain = path.join(dir, 'not-executable');
  fs.writeFileSync(plain, '#!/bin/sh\n', { mode: 0o644 });
  fs.chmodSync(plain, 0o644);
  const { pb } = patchbay(t, {
    noexec: { policy: 'allow', command: plain },
    silent: scripted({ SCRIPTED_INIT_SILENT: '1' }),
    // Two lines: one equal to a whole env value would be scrubbed as a secret.
    refusing: scripted({ SCRIPTED_INIT_ERROR: '1', SCRIPTED_STDERR: 'starting|scripted: about to refuse' }),
  }, { startTimeoutMs: 500 });
  assert.deepEqual(await pb.startSlot(pb.slots.get('noexec')), { ok: false, error: 'could not start: EACCES' });
  assert.deepEqual(await pb.startSlot(pb.slots.get('silent')), { ok: false, error: 'did not finish starting within 1 s' });
  assert.deepEqual(await pb.startSlot(pb.slots.get('refusing')), { ok: false, error: 'scripted: cannot initialize; last stderr: scripted: about to refuse' });
});

test('a child killed by a signal while on is failed, and says which signal', { skip: POSIX_ONLY }, async (t) => {
  const { pb } = patchbay(t, { victim: scripted() });
  const slot = pb.slots.get('victim');
  assert.equal((await pb.startSlot(slot)).ok, true);
  process.kill(slot.child.pid, 'SIGKILL');
  await until(() => slot.state === 'failed');
  assert.equal(slot.lastError, 'exited on signal SIGKILL');
});

test('tools/list_changed: ignored while starting, coalesced while re-listing, and a failing re-list is logged', async (t) => {
  const { pb, logged } = patchbay(t, {
    eager: scripted({ SCRIPTED_NOTIFY: 'notifications/tools/list_changed' }),
    busy: scripted({ SCRIPTED_ECHO: '1', SCRIPTED_NOTIFY: 'notifications/tools/list_changed,notifications/tools/list_changed,notifications/tools/list_changed', SCRIPTED_NOTIFY_DELAY_MS: '400', SCRIPTED_LIST_DELAY_MS: '150' }),
    flaky: scripted({ SCRIPTED_NOTIFY: 'notifications/tools/list_changed', SCRIPTED_NOTIFY_DELAY_MS: '200', SCRIPTED_LIST_FAIL: '1' }),
  });
  for (const name of ['eager', 'busy', 'flaky']) assert.equal((await pb.startSlot(pb.slots.get(name))).ok, true, name);
  await until(() => logged(/warn: flaky: re-listing tools failed: .*scripted: cannot list/));
  // Three notifications while the first re-list runs make one more re-list, not three.
  const busy = pb.slots.get('busy');
  const lists = () => busy.child.stderrTail(20).filter((l) => l === 'got tools/list').length;
  await until(() => lists() === 3 && !busy.relisting);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(lists(), 3);
  assert.equal(pb.slots.get('eager').state, 'on');
});

test('a disable while re-listing drops the late answer', async (t) => {
  // The child ignores SIGTERM, so it is still there to answer the re-list after the disable.
  const { pb } = patchbay(t, { held: scripted({ SCRIPTED_HOLD: '1', SCRIPTED_LIST_DELAY_MS: '300', SCRIPTED_NOTIFY: 'notifications/tools/list_changed', SCRIPTED_NOTIFY_DELAY_MS: '500' }) });
  const slot = pb.slots.get('held');
  assert.equal((await pb.startSlot(slot)).ok, true);
  await until(() => slot.relisting);
  await pb.toolDisable('held');
  await until(() => !slot.relisting);
  assert.equal(slot.state, 'off');
  assert.deepEqual(pb.publishedTools(), []);
});

test('notifications/elicitation/complete from a child goes to a client with url elicitation, and only to one', async (t) => {
  const notify = { SCRIPTED_NOTIFY: 'notifications/elicitation/complete', SCRIPTED_NOTIFY_PARAMS: '{"elicitationId":"e-1"}', SCRIPTED_NOTIFY_DELAY_MS: '50' };
  const seen = [];
  const withUrl = await connected(t, { c: scripted(notify) }, { caps: { elicitation: { url: {} } }, onElicit: () => ({ action: 'cancel' }) });
  const { ElicitationCompleteNotificationSchema } = await import('@modelcontextprotocol/sdk/types.js');
  withUrl.client.setNotificationHandler(ElicitationCompleteNotificationSchema, (n) => { seen.push(n.method); });
  await withUrl.call('enable', { name: 'c' });
  await until(() => seen.length === 1);

  const without = await connected(t, { c: scripted({ ...notify, SCRIPTED_ECHO: '1' }) }, { caps: { elicitation: { form: {} } }, onElicit: () => ({ action: 'cancel' }) });
  await without.call('enable', { name: 'c' });
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(!without.logged(/elicitation\/complete not forwarded/));

  // The client has gone: forwarding fails, and is only logged.
  const gone = await connected(t, { c: scripted({ ...notify, SCRIPTED_NOTIFY_DELAY_MS: '300' }) }, { caps: { elicitation: { url: {} } }, onElicit: () => ({ action: 'cancel' }) });
  await gone.call('enable', { name: 'c' });
  await gone.client.close();
  await until(() => gone.logged(/debug: elicitation\/complete not forwarded: /));
});

/** A url server whose stand-in for mcp-remote prints `lines` on stderr, then serves. */
function remote(dir, lines, env = {}) {
  const bin = path.join(dir, `remote-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(bin, `${lines.map((l) => `console.error(${JSON.stringify(l)});`).join('\n')}\nawait import(${JSON.stringify(new URL(`file://${SCRIPTED}`).href)});\n`);
  return {
    entry: { policy: 'allow', url: 'https://mcp.example.com/mcp', env: { SCRIPTED_PAGES: 'one', ...env } },
    env: { ...process.env, MCP_PATCHBAY_MCP_REMOTE_BIN: bin },
  };
}

test('a sign-in URL printed twice is asked about once', async (t) => {
  const dir = tmpdir();
  const r = remote(dir, [`${AUTH_MARKER} ${AUTH_URL}`, `${AUTH_MARKER} ${AUTH_URL}`], { SCRIPTED_INIT_SILENT: '1' });
  let asked = 0;
  const { pb, call } = await connected(t, { remote: r.entry }, {
    env: r.env,
    caps: { elicitation: { url: {} } },
    onElicit: () => { asked++; return new Promise(() => {}); },
    config: { oauth: { configDir: path.join(dir, 'oauth'), authTimeoutSeconds: 30 } },
  });
  void call('enable', { name: 'remote' });
  await until(() => pb.slots.get('remote').state === 'waiting-for-sign-in' && asked === 1);
  await new Promise((res) => setTimeout(res, 200));
  assert.equal(asked, 1);
  await pb.toolDisable('remote');
});

test('a client without elicitation is not asked to sign in; that is logged', async (t) => {
  const dir = tmpdir();
  const r = remote(dir, [`${AUTH_MARKER} ${AUTH_URL}`]);
  const { call, logged } = await connected(t, { remote: r.entry }, { env: r.env, config: { oauth: { configDir: path.join(dir, 'oauth'), authTimeoutSeconds: 30 } } });
  assert.equal(parse(await call('enable', { name: 'remote' })).state, 'on');
  assert.ok(logged(/warn: remote needs a sign-in, but the client cannot show a link/));
});

test('a sign-in question still open when the start finishes is withdrawn, and that is logged', async (t) => {
  const dir = tmpdir();
  const r = remote(dir, [`${AUTH_MARKER} ${AUTH_URL}`], { SCRIPTED_LIST_DELAY_MS: '200' });
  const { call, logged } = await connected(t, { remote: r.entry }, {
    env: r.env,
    caps: { elicitation: { form: {} } },
    onElicit: () => new Promise(() => {}),
    config: { oauth: { configDir: path.join(dir, 'oauth'), authTimeoutSeconds: 30 } },
  });
  assert.equal(parse(await call('enable', { name: 'remote' })).state, 'on');
  await until(() => logged(/debug: remote: sign-in elicitation ended: /));
});

test('an autostarted server that fails before the client is ready asks nothing', async (t) => {
  const dir = tmpdir();
  const r = remote(dir, [`${AUTH_MARKER} ${AUTH_URL}`], { SCRIPTED_INIT_ERROR: '1' });
  let asked = 0;
  const { pb } = await connected(t, { remote: r.entry }, {
    env: r.env,
    caps: { elicitation: { url: {} } },
    onElicit: () => { asked++; return { action: 'cancel' }; },
    config: { autostart: { default: ['remote'] }, oauth: { configDir: path.join(dir, 'oauth'), authTimeoutSeconds: 30 } },
  });
  assert.equal(pb.slots.get('remote').state, 'failed');
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(asked, 0);
});

test('a call whose write fails because the child stopped reading is an internal error naming why', { skip: POSIX_ONLY }, async (t) => {
  const { pb, call } = await connected(t, { deaf: scripted({ SCRIPTED_DEAF_MS: '100' }) });
  assert.equal((await call('enable', { name: 'deaf' })).isError, undefined);
  await until(() => pb.slots.get('deaf').child.stderrTail(5).includes('deaf'));
  await assert.rejects(call('deaf__one', {}), /EPIPE/);
});

test('shutdownSync signals every child that is on and names its pidfile only when pidfiles are on', { skip: POSIX_ONLY }, async (t) => {
  const dir = tmpdir();
  const pidFiles = new PidFiles(path.join(dir, 'pids'), createLogger({ write: () => {} }));
  for (const pf of [null, pidFiles]) {
    const { pb } = patchbay(t, { a: scripted() }, { pidFiles: pf });
    const slot = pb.slots.get('a');
    assert.equal((await pb.startSlot(slot)).ok, true);
    const child = slot.child;
    pb.shutdownSync();
    assert.equal(pb.closed, true);
    await until(() => child.transport.exited);
  }
});
