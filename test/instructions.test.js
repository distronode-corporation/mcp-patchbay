import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInstructions, fairShare, MAX_INSTRUCTIONS } from '../src/instructions.js';
import { fake, startPatchbay, tmpdir } from './helpers.js';

test('fairShare water-fills a budget', () => {
  assert.deepEqual(fairShare([100, 100], 1000), [100, 100]);
  assert.deepEqual(fairShare([1000, 1000], 1000), [500, 500]);
  assert.deepEqual(fairShare([100, 5000, 5000], 1100), [100, 500, 500]);
  assert.deepEqual(fairShare([], 100), []);
  assert.deepEqual(fairShare([10], 0), [0]);
});

test('the catalogue plus autostart instructions stays under 4096 characters', () => {
  const servers = [];
  for (let i = 0; i < 40; i++) {
    servers.push({ name: `example-server-${i}`, description: 'd'.repeat(300), policy: i % 3 === 0 ? 'allow' : 'confirm', state: i < 3 ? 'on' : 'off' });
  }
  const autostarted = [
    { name: 'example-server-0', instructions: 'a'.repeat(5000) },
    { name: 'example-server-1', instructions: 'b'.repeat(200) },
    { name: 'example-server-2', instructions: 'c'.repeat(5000) },
  ];
  const text = buildInstructions(servers, autostarted);
  assert.ok(text.length <= MAX_INSTRUCTIONS, `length ${text.length}`);
  assert.equal(MAX_INSTRUCTIONS, 4096);
  assert.match(text, /enable/);
  assert.match(text, /disable/);
  assert.match(text, /more; call servers/);
  // fair: the short one is whole, the two long ones get about the same
  assert.ok(text.includes('b'.repeat(200)));
  const a = (text.match(/a+/g) ?? []).reduce((m, s) => Math.max(m, s.length), 0);
  const c = (text.match(/c+/g) ?? []).reduce((m, s) => Math.max(m, s.length), 0);
  assert.ok(a > 100 && Math.abs(a - c) <= 1, `a=${a} c=${c}`);
});

test('a small config gets the whole catalogue, one line per server', () => {
  const text = buildInstructions([
    { name: 'example-files', description: 'Files', policy: 'allow', state: 'on' },
    { name: 'example-remote', description: 'Remote', policy: 'confirm', state: 'off' },
  ], [{ name: 'example-files', instructions: 'Use read_file for files.' }]);
  assert.match(text, /^- example-files \[on, allow\]: Files$/m);
  assert.match(text, /^- example-remote \[off, confirm\]: Remote$/m);
  assert.match(text, /## example-files instructions\nUse read_file for files\./);
});

test('autostart via CLAUDE_PROJECT_DIR: listed servers start at launch with no confirmation', async (t) => {
  const project = tmpdir('patchbay-project-');
  const pb = await startPatchbay({
    env: { CLAUDE_PROJECT_DIR: project },
    capabilities: {},
    config: {
      version: 1,
      servers: {
        'example-proj': fake({ name: 'proj', policy: 'confirm', env: { FAKE_INSTRUCTIONS: 'Project server instructions here.' } }),
        'example-default': fake({ name: 'dflt', policy: 'allow', env: { FAKE_INSTRUCTIONS: 'Default instructions.' } }),
        'example-big': fake({ name: 'big', policy: 'allow', env: { FAKE_INSTRUCTIONS_LEN: '9000' } }),
      },
      autostart: { default: ['example-default'], projects: { [project]: ['example-proj', 'example-big'] } },
    },
  });
  t.after(() => pb.close());
  const names = await pb.toolNames();
  assert.ok(names.includes('example-proj__echo'), 'confirm server autostarted without elicitation');
  assert.ok(names.includes('example-big__echo'));
  assert.ok(!names.includes('example-default__echo'));
  assert.equal(pb.elicitations.length, 0);
  const instructions = pb.client.getInstructions();
  assert.ok(instructions.length <= 4096, `length ${instructions.length}`);
  assert.match(instructions, /Project server instructions here\./);
  assert.match(instructions, /## example-big instructions/);
  assert.match(instructions, /- example-default \[off, allow\]/);
  assert.match(instructions, /- example-proj \[on, confirm\]/);
});

test('without a project match the default list autostarts', async (t) => {
  const pb = await startPatchbay({
    env: { CLAUDE_PROJECT_DIR: '/path/to/unlisted-project' },
    config: {
      version: 1,
      servers: { 'example-default': fake({ policy: 'allow' }), other: fake() },
      autostart: { default: ['example-default'], projects: { '/path/to/project': ['other'] } },
    },
  });
  t.after(() => pb.close());
  const names = await pb.toolNames();
  assert.ok(names.includes('example-default__echo'));
  assert.ok(!names.includes('other__echo'));
});
