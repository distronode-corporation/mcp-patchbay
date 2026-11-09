import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ruleMatchesEnableConfirm, settingsFiles } from '../src/permissions.js';
import { computeAdditions } from '../src/rename-permissions.js';
import { CLI, fake, isAlive, startPatchbay, tmpdir, waitFor, writeConfig } from './helpers.js';

const OWN = ['servers', 'enable', 'disable', 'restart', 'info'];
const OWN_HOST = ['servers', 'enable', 'enable_confirm', 'disable', 'restart', 'info'];

const servers = {
  'example-files': fake({ name: 'files', tools: 'echo', policy: 'allow', description: 'Example files' }),
  'example-ask': fake({ name: 'ask', tools: 'echo,pid', policy: 'confirm', description: 'Needs a yes' }),
  'example-deny': fake({ name: 'deny', tools: 'echo', policy: 'deny', description: 'Never' }),
};
const hostConfig = { version: 1, confirmVia: 'host', servers };
const elicitConfig = { version: 1, confirmVia: 'elicitation', servers };
const accept = () => ({ action: 'accept', content: { allow: true } });

test('enable_confirm is listed only with confirmVia "host", with its annotations', async (t) => {
  const host = await startPatchbay({ config: hostConfig });
  t.after(() => host.close());
  const { tools } = await host.client.listTools();
  assert.deepEqual(tools.map((x) => x.name), OWN_HOST);
  const ec = tools.find((x) => x.name === 'enable_confirm');
  assert.equal(typeof ec.title, 'string');
  assert.ok(ec.title.length > 0);
  assert.match(ec.description, /approval/);
  assert.match(ec.description, /host asks the person/);
  assert.deepEqual(ec._meta, { 'anthropic/alwaysLoad': true });
  assert.equal(ec.annotations.readOnlyHint, false);
  assert.equal(ec.annotations.destructiveHint, true);
  assert.deepEqual(ec.inputSchema.properties.name.enum, ['example-files', 'example-ask', 'example-deny']);
  assert.match(tools.find((x) => x.name === 'enable').description, /enable_confirm/);

  for (const config of [elicitConfig, { version: 1, servers }]) {
    const pb = await startPatchbay({ config });
    t.after(() => pb.close());
    assert.deepEqual(await pb.toolNames(), OWN, 'not listed in elicitation mode (explicit or default)');
    // Not callable either: an unlisted name is an unknown tool.
    await assert.rejects(pb.call('enable_confirm', { name: 'example-ask' }), (e) => {
      assert.equal(/** @type {any} */ (e).code, -32602);
      return true;
    });
    assert.equal((await pb.state('example-ask')).state, 'off');
  }
});

test('host mode: enable refuses a confirm server with the enable_confirm hint, and never elicits', async (t) => {
  const pb = await startPatchbay({ config: hostConfig, onElicit: accept });
  t.after(() => pb.close());
  const r = await pb.own('enable', { name: 'example-ask' });
  assert.equal(r.isError, true);
  assert.match(r.text, /enable_confirm/);
  assert.match(r.text, /\\"name\\": \\"example-ask\\"/);
  assert.equal(pb.elicitations.length, 0, 'no elicitation in host mode');
  assert.equal((await pb.state('example-ask')).state, 'off');
  // allow servers are unaffected
  const ok = await pb.own('enable', { name: 'example-files' });
  assert.equal(ok.isError, false, ok.text);
});

test('host mode: enable_confirm turns a confirm server on without elicitation', async (t) => {
  // Even a client with no elicitation support at all: the host's permission prompt is the ask.
  for (const capabilities of [undefined, {}]) {
    const pb = await startPatchbay({ config: hostConfig, capabilities, onElicit: accept });
    t.after(() => pb.close());
    const s = await pb.state('example-ask');
    assert.equal(s.canEnable, true);
    assert.equal(s.enableWith, 'enable_confirm');
    const r = await pb.own('enable_confirm', { name: 'example-ask' });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.state, 'on');
    assert.deepEqual(r.data.sampleTools, ['example-ask__echo', 'example-ask__pid']);
    assert.equal(pb.elicitations.length, 0);
    assert.ok((await pb.toolNames()).includes('example-ask__echo'));
    const again = await pb.own('enable_confirm', { name: 'example-ask' });
    assert.equal(again.isError, false);
    assert.equal(again.data.message, 'already on');
    // Once on, enable reports it like any on server.
    const en = await pb.own('enable', { name: 'example-ask' });
    assert.equal(en.isError, false, en.text);
  }
});

test('host mode: enable_confirm refuses deny, allow and unknown servers', async (t) => {
  const pb = await startPatchbay({ config: hostConfig, onElicit: accept });
  t.after(() => pb.close());
  const d = await pb.own('enable_confirm', { name: 'example-deny' });
  assert.equal(d.isError, true);
  assert.match(d.text, /denied by policy/);
  const a = await pb.own('enable_confirm', { name: 'example-files' });
  assert.equal(a.isError, true);
  assert.match(a.text, /policy allow/);
  assert.match(a.text, /enable/);
  assert.equal((await pb.state('example-files')).state, 'off', 'allow server not started by enable_confirm');
  const u = await pb.own('enable_confirm', { name: 'nope' });
  assert.equal(u.isError, true);
  assert.match(u.text, /unknown server/);
  const missing = await pb.own('enable_confirm', {});
  assert.equal(missing.isError, true);
  assert.equal((await pb.state('example-deny')).state, 'off');
  assert.equal(pb.elicitations.length, 0);
});

test('host mode: restart of an off or failed confirm server refuses with the hint', async (t) => {
  const flag = path.join(tmpdir(), 'crash-now');
  const config = {
    version: 1,
    confirmVia: 'host',
    servers: { 'example-ask': fake({ tools: 'echo,pid', policy: 'confirm', env: { FAKE_EXIT_IF_EXISTS: flag } }) },
  };
  const pb = await startPatchbay({ config, onElicit: accept });
  t.after(() => pb.close());
  const off = await pb.own('restart', { name: 'example-ask' });
  assert.equal(off.isError, true);
  assert.match(off.text, /enable_confirm/);
  assert.equal((await pb.state('example-ask')).state, 'off');
  // Failed: the start after approval fails, and a restart must ask again (through enable_confirm).
  fs.writeFileSync(flag, '');
  const failed = await pb.own('enable_confirm', { name: 'example-ask' });
  assert.equal(failed.isError, true);
  assert.equal((await pb.state('example-ask')).state, 'failed');
  fs.rmSync(flag);
  const r = await pb.own('restart', { name: 'example-ask' });
  assert.equal(r.isError, true);
  assert.match(r.text, /enable_confirm/);
  assert.equal((await pb.state('example-ask')).state, 'failed');
  const ok = await pb.own('enable_confirm', { name: 'example-ask' });
  assert.equal(ok.isError, false, ok.text);
  assert.equal(pb.elicitations.length, 0);
});

test('host mode: restart of an on confirm server needs no new approval', async (t) => {
  const pb = await startPatchbay({ config: hostConfig, onElicit: accept });
  t.after(() => pb.close());
  await pb.own('enable_confirm', { name: 'example-ask' });
  const pid1 = JSON.parse((await pb.call('example-ask__pid')).content[0].text).pid;
  const r = await pb.own('restart', { name: 'example-ask' });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.data.state, 'on');
  const pid2 = JSON.parse((await pb.call('example-ask__pid')).content[0].text).pid;
  assert.notEqual(pid1, pid2);
  await waitFor(() => !isAlive(pid1), 3000);
  // After a disable the approval is gone: enable refuses again.
  await pb.own('disable', { name: 'example-ask' });
  const en = await pb.own('enable', { name: 'example-ask' });
  assert.equal(en.isError, true);
  assert.match(en.text, /enable_confirm/);
  assert.equal(pb.elicitations.length, 0);
});

test('host mode: the instructions and servers usage name enable_confirm', async (t) => {
  const pb = await startPatchbay({ config: hostConfig });
  t.after(() => pb.close());
  assert.match(pb.client.getInstructions() ?? '', /`enable_confirm` \{name\}/);
  const r = await pb.own('servers');
  assert.match(r.data.usage, /enable_confirm/);
  const plain = await startPatchbay({ config: elicitConfig });
  t.after(() => plain.close());
  assert.doesNotMatch(plain.client.getInstructions() ?? '', /enable_confirm/);
  assert.equal((await plain.state('example-ask')).enableWith, undefined);
});

test('ruleMatchesEnableConfirm: exact, whole-server and wildcard rules', () => {
  for (const rule of [
    'mcp__patchbay__enable_confirm',
    'mcp__patchbay__*',
    'mcp__patchbay',
    '*',
    'mcp__*',
    'mcp__patchbay__enable*',
    '  mcp__patchbay__enable_confirm  ',
    'mcp__patchbay__enable_confirm(example)',
  ]) {
    assert.equal(ruleMatchesEnableConfirm(rule), true, rule);
  }
  for (const rule of [
    'mcp__patchbay__enable',
    'mcp__patchbay__servers',
    'mcp__patchbay__example-ask__*',
    'mcp__patchbay__enable_confirm_x',
    'mcp__patchbayx',
    'mcp__other__*',
    'Bash(*)',
    'mcp__patchbay__enable.confirm',
    '',
    42,
    null,
  ]) {
    assert.equal(ruleMatchesEnableConfirm(rule), false, String(rule));
  }
});

test('rename-permissions never writes a rule that matches enable_confirm', () => {
  const settings = {
    permissions: {
      allow: ['mcp__patchbay', 'mcp__patchbay__*', '*', 'mcp__*', 'mcp__example-ask', 'mcp__example-ask__*'],
      ask: ['mcp__*__x'],
    },
  };
  const { additions } = computeAdditions(settings);
  for (const list of ['allow', 'ask', 'deny']) {
    for (const r of additions[list]) assert.equal(ruleMatchesEnableConfirm(r), false, r);
  }
  assert.deepEqual(additions.allow, ['mcp__patchbay__example-ask__*']);
  // Every twin is mcp__patchbay__<segment>__<tool>, and enable_confirm has no "__" after the
  // prefix, so no segment mapping can produce a match.
  for (const seg of ['enable', 'enable_confirm', '*', 'enable*', '']) {
    const r = computeAdditions({ permissions: { allow: ['mcp__example-ask__confirm', 'mcp__example-ask__*', 'mcp__example-ask'] } }, { segmentFor: () => seg });
    for (const rule of r.additions.allow) assert.equal(ruleMatchesEnableConfirm(rule), false, rule);
  }
});

/**
 * Runs doctor with a fake home (and optionally a project), never starting a server.
 * @param {{config: any, user?: any, userLocal?: any, project?: any, projectLocal?: any, raw?: Record<string, string>, extra?: string[]}} o
 */
function doctor(o) {
  const dir = tmpdir();
  const home = path.join(dir, 'home');
  const project = path.join(dir, 'project');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  const put = (file, v) => { if (v !== undefined) fs.writeFileSync(file, typeof v === 'string' ? v : JSON.stringify(v)); };
  put(path.join(home, '.claude', 'settings.json'), o.user);
  put(path.join(home, '.claude', 'settings.local.json'), o.userLocal);
  put(path.join(project, '.claude', 'settings.json'), o.project);
  put(path.join(project, '.claude', 'settings.local.json'), o.projectLocal);
  const cfg = writeConfig(dir, o.config);
  const r = spawnSync(process.execPath, [CLI, 'doctor', '--config', cfg, '--no-start', '--project', project, ...(o.extra ?? [])], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, XDG_RUNTIME_DIR: dir },
  });
  return { ...r, home, project };
}

test('doctor warns about allow rules that would approve enable_confirm, in every settings file', () => {
  const r = doctor({
    config: hostConfig,
    user: { permissions: { allow: ['mcp__patchbay__servers', 'mcp__patchbay__*'] } },
    userLocal: { permissions: { allow: ['*'], ask: ['mcp__patchbay__enable_confirm'] } },
    project: { permissions: { allow: ['mcp__patchbay'] } },
    projectLocal: { permissions: { allow: ['mcp__patchbay__enable_confirm'], defaultMode: 'bypassPermissions' } },
  });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^confirmVia: host/m);
  const warnings = r.stdout.split('\n').filter((l) => l.startsWith('permissions: warning:'));
  assert.equal(warnings.length, 5, r.stdout);
  for (const rule of ['mcp__patchbay__*', '*', 'mcp__patchbay', 'mcp__patchbay__enable_confirm']) {
    assert.ok(warnings.some((w) => w.includes(`allow rule "${rule}"`)), rule);
  }
  assert.ok(warnings.some((w) => /bypassPermissions/.test(w)));
  assert.ok(!r.stdout.includes('"mcp__patchbay__servers"'), 'a rule for another tool is not reported');
  assert.ok(r.stdout.includes(path.join(r.project, '.claude', 'settings.local.json')));
  assert.doesNotMatch(r.stdout, /: ok, /, 'no server was started');
});

test('doctor passes when no allow rule matches, and reports missing files', () => {
  const r = doctor({
    config: hostConfig,
    user: { permissions: { allow: ['mcp__patchbay__servers', 'mcp__patchbay__example-ask__*'], deny: ['mcp__patchbay__*'] } },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /settings\.json: ok, no allow rule matches mcp__patchbay__enable_confirm/);
  assert.match(r.stdout, /settings\.local\.json: not found/);
  assert.doesNotMatch(r.stdout, /warning/);
});

test('doctor only notes matching rules in elicitation mode, and fails on unreadable settings in host mode', () => {
  const note = doctor({ config: elicitConfig, user: { permissions: { allow: ['mcp__patchbay__*'] } } });
  assert.equal(note.status, 0, note.stdout + note.stderr);
  assert.match(note.stdout, /^confirmVia: elicitation$/m);
  assert.match(note.stdout, /permissions: note: .*"mcp__patchbay__\*"/);
  const broken = doctor({ config: hostConfig, user: '{"permissions": {"allow": ["sk-abcdefghijklmnopqrstuvwxyz",] }}' });
  assert.equal(broken.status, 1);
  assert.match(broken.stdout, /not valid JSON \(line 1, column \d+\); not checked/);
  assert.ok(!broken.stdout.includes('sk-abcdefghijklmnopqrstuvwxyz'), 'never quotes the settings text');
});

test('doctor without --project reads only the user settings files', () => {
  const files = settingsFiles({ home: '/path/to/home' });
  assert.deepEqual(files, [path.join('/path/to/home', '.claude', 'settings.json'), path.join('/path/to/home', '.claude', 'settings.local.json')]);
  assert.equal(settingsFiles({ home: '/path/to/home', project: '/path/to/project' }).length, 4);
  const bad = spawnSync(process.execPath, [CLI, 'doctor', '--project'], { encoding: 'utf8' });
  assert.equal(bad.status, 64);
});
