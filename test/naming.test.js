import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeToolName, exposedName, mapTools, splitExposed, isValidSegment, CLIENT_PREFIX, MAX_CLIENT_NAME } from '../src/naming.js';

const tool = (name, extra = {}) => ({ name, inputSchema: { type: 'object' }, ...extra });

test('sanitize keeps [A-Za-z0-9_-] and replaces the rest with _', () => {
  assert.equal(sanitizeToolName('read_file'), 'read_file');
  assert.equal(sanitizeToolName('read.file'), 'read_file');
  assert.equal(sanitizeToolName('a b/c:d'), 'a_b_c_d');
  assert.equal(sanitizeToolName('ünï'), '_n_');
  assert.equal(sanitizeToolName('x-Y_9'), 'x-Y_9');
});

test('exposed name is <segment>__<tool>', () => {
  assert.equal(exposedName('files', 'read.file'), 'files__read_file');
  assert.equal(CLIENT_PREFIX, 'mcp__patchbay__');
  assert.equal(MAX_CLIENT_NAME, 128);
});

test('segment rules: no __, no trailing _', () => {
  assert.ok(isValidSegment('example-files'));
  assert.ok(isValidSegment('a_b'));
  assert.ok(!isValidSegment('a__b'));
  assert.ok(!isValidSegment('ab_'));
  assert.ok(!isValidSegment(''));
  assert.ok(!isValidSegment('a.b'));
});

test('the first __ is always the separator', () => {
  assert.deepEqual(splitExposed('files__read_file'), { segment: 'files', tool: 'read_file' });
  assert.deepEqual(splitExposed('files___hidden'), { segment: 'files', tool: '_hidden' });
  assert.deepEqual(splitExposed('files__a__b'), { segment: 'files', tool: 'a__b' });
  assert.equal(splitExposed('servers'), null);
  assert.equal(splitExposed('__x'), null);
  assert.equal(splitExposed('x__'), null);
});

test('mapTools publishes, keeps a reverse map, and skips what it must', () => {
  const longOk = 'a'.repeat(128 - CLIENT_PREFIX.length - 'srv__'.length);
  const longBad = longOk + 'b';
  const { published, skipped } = mapTools('srv', [
    tool('read.file', { title: 'Read', annotations: { readOnlyHint: true, customHint: 1 }, _meta: { k: 'v' }, unknownKey: 1 }),
    tool('read_file'),
    tool(longOk),
    tool(longBad),
    tool(''),
    tool('bad', { inputSchema: { type: 'string' } }),
    tool('needs-task', { execution: { taskSupport: 'required' } }),
    tool('opt-task', { execution: { taskSupport: 'optional' } }),
  ]);
  assert.deepEqual(published.map((p) => p.exposed), ['srv__read_file', `srv__${longOk}`, 'srv__opt-task']);
  assert.equal(`${CLIENT_PREFIX}srv__${longOk}`.length, 128);
  const first = published[0];
  assert.equal(first.original, 'read.file');
  // Everything except name passes through unchanged, unknown keys included.
  assert.deepEqual(first.tool, { name: 'srv__read_file', inputSchema: { type: 'object' }, title: 'Read', annotations: { readOnlyHint: true, customHint: 1 }, _meta: { k: 'v' }, unknownKey: 1 });
  const reasons = Object.fromEntries(skipped.map((s) => [s.tool, s.reason]));
  assert.match(reasons.read_file, /collides with read\.file/);
  assert.match(reasons[longBad], /name too long/);
  assert.match(reasons[''], /empty name/);
  assert.match(reasons.bad, /invalid tool definition/);
  assert.match(reasons['needs-task'], /task/);
});

test('prefix alias is used as the segment and is never shortened', () => {
  const seg = 'p'.repeat(64);
  const { published, skipped } = mapTools(seg, [tool('x'.repeat(60)), tool('short')]);
  assert.deepEqual(published.map((p) => p.exposed), [`${seg}__short`]);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /name too long/);
});
