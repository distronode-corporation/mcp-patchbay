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

// No config at the default location, so these runs never depend on the developer's own config.
const noConfig = () => {
  const home = tmpdir();
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.MCP_PATCHBAY_CONFIG;
  return env;
};

test('CLI dry run prints a diff and changes nothing; --write backs up then writes', () => {
  const env = noConfig();
  const dir = tmpdir();
  const file = path.join(dir, 'settings.json');
  const original = JSON.stringify(settings, null, 2) + '\n';
  fs.writeFileSync(file, original, { mode: 0o644 });

  const dry = spawnSync(process.execPath, [CLI, 'rename-permissions', file], { encoding: 'utf8', env });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /^\+ permissions\.ask: mcp__patchbay__example-remote__create_item$/m);
  assert.match(dry.stdout, /^\+ permissions\.allow: mcp__patchbay__example-remote__\*$/m);
  assert.match(dry.stdout, /dry run/i);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(fs.readdirSync(dir).length, 1);

  const wr = spawnSync(process.execPath, [CLI, 'rename-permissions', file, '--write'], { encoding: 'utf8', env });
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
  const again = spawnSync(process.execPath, [CLI, 'rename-permissions', file], { encoding: 'utf8', env });
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

test('CLI without --config loads the default config and applies its prefixes', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ permissions: { deny: ['mcp__github__delete_repo'] } }));
  const cfg = writeConfig(dir, { version: 1, servers: { github: { command: 'x', prefix: 'gh' } } });
  const viaEnv = spawnSync(process.execPath, [CLI, 'rename-permissions', file], { encoding: 'utf8', env: { ...noConfig(), MCP_PATCHBAY_CONFIG: cfg } });
  assert.equal(viaEnv.status, 0, viaEnv.stderr);
  assert.match(viaEnv.stdout, /^\+ permissions\.deny: mcp__patchbay__gh__delete_repo$/m);
  assert.ok(!viaEnv.stdout.includes('mcp__patchbay__github__'));
  assert.equal(viaEnv.stderr, '', 'no warning when the config was found');

  const home = tmpdir();
  fs.mkdirSync(path.join(home, '.config', 'mcp-patchbay'), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.join(home, '.config', 'mcp-patchbay'), 0o700); // independent of the umask
  writeConfig(path.join(home, '.config', 'mcp-patchbay'), { version: 1, servers: { github: { command: 'x', prefix: 'gh' } } });
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.MCP_PATCHBAY_CONFIG;
  const viaHome = spawnSync(process.execPath, [CLI, 'rename-permissions', file], { encoding: 'utf8', env });
  assert.equal(viaHome.status, 0, viaHome.stderr);
  assert.match(viaHome.stdout, /mcp__patchbay__gh__delete_repo/);
});

test('CLI without --config and without a config file warns that prefixes are unknown', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ permissions: { deny: ['mcp__github__delete_repo'] } }));
  const r = spawnSync(process.execPath, [CLI, 'rename-permissions', file], { encoding: 'utf8', env: noConfig() });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /mcp__patchbay__github__delete_repo/);
  assert.match(r.stderr, /warning/i);
  assert.match(r.stderr, /prefix/);
  assert.match(r.stderr, /as-is|as they are/);
});

test('a JSON syntax error in settings.json does not echo its contents', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{"env": {"API_TOKEN": sk_live_SECRETSECRET}, "permissions": {}}');
  const r = spawnSync(process.execPath, [CLI, 'rename-permissions', file], { encoding: 'utf8', env: noConfig() });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not valid JSON.*line 1, column 23/);
  assert.ok(!r.stderr.includes('SECRET') && !r.stderr.includes('sk_live') && !r.stderr.includes('TOKEN'), r.stderr);
});
