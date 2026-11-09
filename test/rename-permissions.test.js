import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CLI, IS_WINDOWS, tmpdir, writeConfig } from './helpers.js';
import { computeAdditions } from '../src/rename-permissions.js';

const settings = {
  model: 'example',
  permissions: {
    allow: [
      'Bash(npm test)',
      'mcp__example-files__read_file',
      'mcp__example-remote',
      'mcp__example-files__*',
      'mcp__claude-in-chrome__navigate',
      'mcp__plugin_example_tool__x',
      'mcp__claude_ai_Example__search',
      'mcp__example-files__write_file(path:/tmp)',
      'mcp__patchbay__example-files__read_file',
      'mcp__under_score__do',
    ],
    ask: ['mcp__example-remote__create_item'],
    deny: ['mcp__example-remote__delete_item'],
  },
};

test('computeAdditions maps tool and server rules and skips what cannot be proxied', () => {
  const { additions, skipped } = computeAdditions(JSON.parse(JSON.stringify(settings)));
  // read_file already has its patchbay twin in the list, so it adds nothing.
  assert.deepEqual(additions.allow, [
    'mcp__patchbay__example-remote__*',
    'mcp__patchbay__example-files__*',
    'mcp__patchbay__under_score__do',
  ]);
  assert.deepEqual(additions.ask, ['mcp__patchbay__example-remote__create_item']);
  assert.deepEqual(additions.deny, ['mcp__patchbay__example-remote__delete_item']);
  const skippedRules = skipped.map((s) => s.rule);
  for (const r of ['mcp__claude-in-chrome__navigate', 'mcp__plugin_example_tool__x', 'mcp__claude_ai_Example__search', 'mcp__example-files__write_file(path:/tmp)']) {
    assert.ok(skippedRules.includes(r), r);
  }
});

test('existing patchbay rules are not duplicated; read_file and wildcard rules map once', () => {
  const s = { permissions: { allow: ['mcp__example-files__read_file', 'mcp__example-files__*'] } };
  const { additions } = computeAdditions(s);
  assert.deepEqual(additions.allow, ['mcp__patchbay__example-files__read_file', 'mcp__patchbay__example-files__*']);
});

test('--config maps server names to their prefix alias', () => {
  const s = { permissions: { allow: ['mcp__example-files__read_file'] } };
  const { additions } = computeAdditions(s, { segmentFor: (name) => (name === 'example-files' ? 'files' : name) });
  assert.deepEqual(additions.allow, ['mcp__patchbay__files__read_file']);
});

test('CLI dry run prints a diff and changes nothing; --write backs up then writes', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'settings.json');
  const original = JSON.stringify(settings, null, 2) + '\n';
  fs.writeFileSync(file, original, { mode: 0o644 });

  const dry = spawnSync(process.execPath, [CLI, 'rename-permissions', file], { encoding: 'utf8' });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /^\+ permissions\.ask: mcp__patchbay__example-remote__create_item$/m);
  assert.match(dry.stdout, /^\+ permissions\.allow: mcp__patchbay__example-remote__\*$/m);
  assert.match(dry.stdout, /dry run/i);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(fs.readdirSync(dir).length, 1);

  const wr = spawnSync(process.execPath, [CLI, 'rename-permissions', file, '--write'], { encoding: 'utf8' });
  assert.equal(wr.status, 0, wr.stderr);
  const backups = fs.readdirSync(dir).filter((f) => f.startsWith('settings.json.bak-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), original);
  const updated = JSON.parse(fs.readFileSync(file, 'utf8'));
  // every existing rule kept, in order, followed by the additions
  assert.deepEqual(updated.permissions.allow.slice(0, settings.permissions.allow.length), settings.permissions.allow);
  assert.ok(updated.permissions.allow.includes('mcp__patchbay__example-remote__*'));
  assert.deepEqual(updated.permissions.deny, ['mcp__example-remote__delete_item', 'mcp__patchbay__example-remote__delete_item']);
  assert.equal(updated.model, 'example');
  if (!IS_WINDOWS) assert.equal(fs.statSync(file).mode & 0o777, 0o644);

  // idempotent: a second run adds nothing
  const again = spawnSync(process.execPath, [CLI, 'rename-permissions', file], { encoding: 'utf8' });
  assert.match(again.stdout, /nothing to add/i);
});

test('CLI --config uses prefixes', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ permissions: { allow: ['mcp__example-files__read_file'] } }));
  const cfg = writeConfig(dir, { version: 1, servers: { 'example-files': { command: 'x', prefix: 'files' } } });
  const r = spawnSync(process.execPath, [CLI, 'rename-permissions', file, '--config', cfg], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /mcp__patchbay__files__read_file/);
});
