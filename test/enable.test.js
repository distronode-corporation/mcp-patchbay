import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fake, startPatchbay, waitFor, isAlive } from './helpers.js';

const OWN = ['servers', 'enable', 'disable', 'restart', 'info'];

const config = {
  version: 1,
  servers: {
    'example-files': fake({ name: 'files', tools: 'echo,read.file,sleep', policy: 'allow', description: 'Example files' }),
    'example-ask': fake({ name: 'ask', tools: 'echo', policy: 'confirm', description: 'Needs a yes' }),
    'example-deny': fake({ name: 'deny', tools: 'echo', policy: 'deny', description: 'Never' }),
  },
};

test('own tools are always there, with alwaysLoad meta, and no generic exec tool', async (t) => {
  const pb = await startPatchbay({ config });
  t.after(() => pb.close());
  const { tools } = await pb.client.listTools();
  assert.deepEqual(tools.map((x) => x.name), OWN);
  for (const tool of tools) assert.deepEqual(tool._meta, { 'anthropic/alwaysLoad': true });
  assert.deepEqual(tools.find((x) => x.name === 'enable').inputSchema.properties.name.enum, ['example-files', 'example-ask', 'example-deny']);
  const caps = pb.client.getServerCapabilities();
  assert.deepEqual(caps.tools, { listChanged: true });
  assert.equal(caps.resources, undefined);
  assert.equal(caps.prompts, undefined);
});

test('servers lists every server with state and whether it can be enabled', async (t) => {
  const pb = await startPatchbay({ config });
  t.after(() => pb.close());
  const r = await pb.own('servers');
  assert.equal(r.isError, false);
  const byName = Object.fromEntries(r.data.servers.map((s) => [s.name, s]));
  assert.deepEqual(Object.keys(byName), ['example-files', 'example-ask', 'example-deny']);
  assert.equal(byName['example-files'].state, 'off');
  assert.equal(byName['example-files'].policy, 'allow');
  assert.equal(byName['example-files'].description, 'Example files');
  assert.equal(byName['example-files'].canEnable, true);
  assert.equal(byName['example-deny'].canEnable, false);
  assert.match(byName['example-deny'].whyNot, /deny/);
  assert.deepEqual(r.data.canEnable, ['example-files', 'example-ask']);
});

test('enable on an allow server publishes tools, sends list_changed and waits for the re-list', async (t) => {
  const pb = await startPatchbay({ config });
  t.after(() => pb.close());
  const started = Date.now();
  const r = await pb.own('enable', { name: 'example-files' });
  const took = Date.now() - started;
  assert.equal(r.isError, false, r.text);
  assert.equal(r.data.state, 'on');
  assert.equal(r.data.toolCount, 3);
  assert.deepEqual(r.data.sampleTools, ['example-files__echo', 'example-files__read_file', 'example-files__sleep']);
  assert.equal(pb.listChanged.count, 1);
  assert.equal(pb.listChanged.requested, 1, 'client re-list was under way before enable returned');
  assert.ok(took < 2000 + 1500, `resolved early (took ${took} ms)`);
  const names = await pb.toolNames();
  assert.deepEqual(names, [...OWN, 'example-files__echo', 'example-files__read_file', 'example-files__sleep']);
  const call = await pb.call('example-files__read_file', { value: 'x' });
  assert.equal(call.content[0].text, 'files:read.file:{"value":"x"}');
  const s = await pb.state('example-files');
  assert.equal(s.state, 'on');
  assert.equal(s.toolCount, 3);
  // enabling again is a no-op that reports the same thing
  const again = await pb.own('enable', { name: 'example-files' });
  assert.equal(again.data.state, 'on');
  assert.equal(pb.listChanged.count, 1);
});

test('enable waits at most ~2 s when the client never re-lists', async (t) => {
  const pb = await startPatchbay({ config, autoRelist: false });
  t.after(() => pb.close());
  const started = Date.now();
  const r = await pb.own('enable', { name: 'example-files' });
  const took = Date.now() - started;
  assert.equal(r.isError, false);
  await waitFor(() => pb.listChanged.count === 1);
  assert.ok(took >= 1900, `waited for the re-list (took ${took} ms)`);
  assert.ok(took < 6000, `but not forever (took ${took} ms)`);
});

test('enable on confirm: accept proceeds, with the exact message', async (t) => {
  const pb = await startPatchbay({ config, onElicit: () => ({ action: 'accept', content: { allow: true } }) });
  t.after(() => pb.close());
  const r = await pb.own('enable', { name: 'example-ask' });
  assert.equal(r.isError, false, r.text);
  assert.equal(pb.elicitations.length, 1);
  const e = pb.elicitations[0];
  assert.equal(e.mode, 'form');
  assert.equal(e.message, 'Allow the agent to turn on example-ask (Needs a yes)?');
  assert.deepEqual(Object.keys(e.requestedSchema.properties), ['allow']);
  assert.equal(e.requestedSchema.properties.allow.type, 'boolean');
  assert.ok((await pb.toolNames()).includes('example-ask__echo'));
});

test('enable on confirm: decline, cancel, and accept-with-false all refuse', async (t) => {
  const answers = [
    { action: 'decline' },
    { action: 'cancel' },
    { action: 'accept', content: { allow: false } },
  ];
  const pb = await startPatchbay({ config, onElicit: () => answers.shift() });
  t.after(() => pb.close());
  for (let i = 0; i < 3; i++) {
    const r = await pb.own('enable', { name: 'example-ask' });
    assert.equal(r.isError, true);
    assert.match(r.text, /not approved/);
  }
  assert.equal(pb.elicitations.length, 3);
  assert.equal((await pb.state('example-ask')).state, 'off');
  assert.ok(!(await pb.toolNames()).includes('example-ask__echo'));
  assert.equal(pb.listChanged.count, 0);
});

test('enable on confirm without client elicitation support is refused (fail closed)', async (t) => {
  const pb = await startPatchbay({ config, capabilities: {} });
  t.after(() => pb.close());
  const r = await pb.own('enable', { name: 'example-ask' });
  assert.equal(r.isError, true);
  assert.match(r.text, /autostart/);
  assert.match(r.text, /policy: allow/);
  assert.equal((await pb.state('example-ask')).state, 'off');
  const s = await pb.state('example-ask');
  assert.equal(s.canEnable, false);
  // allow servers still work without elicitation
  const ok = await pb.own('enable', { name: 'example-files' });
  assert.equal(ok.isError, false);
});

test('enable on deny and on unknown names is refused', async (t) => {
  const pb = await startPatchbay({ config, onElicit: () => ({ action: 'accept', content: { allow: true } }) });
  t.after(() => pb.close());
  const d = await pb.own('enable', { name: 'example-deny' });
  assert.equal(d.isError, true);
  assert.match(d.text, /denied by policy/);
  const u = await pb.own('enable', { name: 'nope' });
  assert.equal(u.isError, true);
  assert.equal(pb.elicitations.length, 0, 'never asked the person');
  const restartDeny = await pb.own('restart', { name: 'example-deny' });
  assert.equal(restartDeny.isError, true);
});

test('disable removes tools and sends list_changed; refused while a call is in flight', async (t) => {
  const pb = await startPatchbay({ config });
  t.after(() => pb.close());
  await pb.own('enable', { name: 'example-files' });
  const slow = pb.call('example-files__sleep', { ms: 800 });
  await waitFor(async () => (await pb.own('info', { name: 'example-files' })).data.inFlight === 1);
  const refused = await pb.own('disable', { name: 'example-files' });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /1 call\(s\) in flight/);
  assert.equal((await slow).content[0].text, 'slept 800');
  const before = pb.listChanged.count;
  const r = await pb.own('disable', { name: 'example-files' });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.data.state, 'off');
  await waitFor(() => pb.listChanged.count === before + 1);
  assert.deepEqual(await pb.toolNames(), OWN);
  const gone = await pb.call('example-files__echo', {});
  assert.equal(gone.isError, true);
  assert.match(gone.content[0].text, /not enabled/);
  const again = await pb.own('disable', { name: 'example-files' });
  assert.equal(again.isError, false);
  assert.match(again.text, /already off/);
});

test('an unknown tool on an enabled server is a protocol error, not advice to enable it', async (t) => {
  const pb = await startPatchbay({ config });
  t.after(() => pb.close());
  await pb.own('enable', { name: 'example-files' });
  await assert.rejects(pb.call('example-files__nope', {}), (e) => {
    assert.equal(/** @type {any} */ (e).code, -32602);
    assert.match(/** @type {Error} */ (e).message, /Unknown tool: example-files__nope/);
    return true;
  });
});

test('restart replaces the child without asking again when it is on', async (t) => {
  const pb = await startPatchbay({
    config: { version: 1, servers: { 'example-ask': fake({ name: 'ask', tools: 'pid', policy: 'confirm' }) } },
    onElicit: () => ({ action: 'accept', content: { allow: true } }),
  });
  t.after(() => pb.close());
  await pb.own('enable', { name: 'example-ask' });
  const pid1 = JSON.parse((await pb.call('example-ask__pid')).content[0].text).pid;
  const r = await pb.own('restart', { name: 'example-ask' });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.data.state, 'on');
  assert.equal(pb.elicitations.length, 1, 'no second confirmation');
  const pid2 = JSON.parse((await pb.call('example-ask__pid')).content[0].text).pid;
  assert.notEqual(pid1, pid2);
  await waitFor(() => !isAlive(pid1), 3000);
});

test('restart of an off confirm server asks like enable', async (t) => {
  const pb = await startPatchbay({ config, onElicit: () => ({ action: 'decline' }) });
  t.after(() => pb.close());
  const r = await pb.own('restart', { name: 'example-ask' });
  assert.equal(r.isError, true);
  assert.equal(pb.elicitations.length, 1);
});

test('info shows details and full instructions when on', async (t) => {
  const long = 'x'.repeat(3000);
  const pb = await startPatchbay({
    config: { version: 1, servers: { 'example-files': fake({ name: 'files', env: { FAKE_INSTRUCTIONS: long } }) } },
  });
  t.after(() => pb.close());
  const off = await pb.own('info', { name: 'example-files' });
  assert.equal(off.data.state, 'off');
  assert.equal(off.data.instructions, undefined);
  const en = await pb.own('enable', { name: 'example-files' });
  assert.equal(en.data.instructions.length <= 2000, true);
  assert.match(en.data.instructions, /…\[truncated\]$/);
  const on = await pb.own('info', { name: 'example-files' });
  assert.equal(on.data.instructions, long);
  assert.equal(on.data.policy, 'allow');
});
