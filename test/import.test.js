import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CLI, IS_WINDOWS, tmpdir } from './helpers.js';
import { loadConfig } from '../src/config.js';

const PROJECT = '/path/to/project';

const claudeJson = {
  numStartups: 3,
  mcpServers: {
    'example-files': {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem@2.2.0', '/path/to/project'],
      env: { EXAMPLE_TOKEN: 'super-secret-env-value-1' },
    },
    'example-remote': { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer secret-header-value-2' } },
    'example-sse': { type: 'sse', url: 'https://mcp.example.com/sse' },
    'claude.ai Example': { type: 'http', url: 'https://mcp.example.com/x' },
    'plugin:example:thing': { command: 'node', args: ['x.js'] },
    'claude-in-chrome': { command: 'chrome-bridge' },
    'bad.name': { command: 'node' },
    'example-ws': { type: 'ws', url: 'wss://mcp.example.com/ws' },
    patchbay: { command: 'npx', args: ['-y', 'mcp-patchbay@0.1.0'] },
  },
  projects: {
    [PROJECT]: {
      mcpServers: { 'example-project-only': { command: '/path/to/bin/server' } },
      disabledMcpServers: ['example-remote', 'example-sse'],
    },
  },
};

function runImport(args) {
  return spawnSync(process.execPath, [CLI, 'import', ...args], { encoding: 'utf8' });
}

test('import maps servers, policy, autostart and skips what it cannot host', () => {
  const dir = tmpdir();
  const from = path.join(dir, 'claude.json');
  fs.writeFileSync(from, JSON.stringify(claudeJson));
  const out = path.join(dir, 'out', 'servers.json');
  const r = runImport(['--from', from, '--project', PROJECT, '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  const cfg = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(cfg.version, 1);
  assert.deepEqual(Object.keys(cfg.servers).sort(), ['example-files', 'example-project-only', 'example-remote', 'example-sse']);
  assert.deepEqual(cfg.servers['example-files'], {
    description: 'Imported from Claude Code (stdio)',
    policy: 'allow',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem@2.2.0', '/path/to/project'],
    env: { EXAMPLE_TOKEN: 'super-secret-env-value-1' },
  });
  assert.deepEqual(cfg.servers['example-remote'], {
    description: 'Imported from Claude Code (http)',
    policy: 'confirm',
    url: 'https://mcp.example.com/mcp',
    headers: { Authorization: 'Bearer secret-header-value-2' },
  });
  assert.equal(cfg.servers['example-sse'].policy, 'confirm');
  assert.equal(cfg.servers['example-project-only'].policy, 'allow');
  assert.deepEqual(cfg.autostart, { default: [], projects: { [PROJECT]: ['example-files', 'example-project-only'] } });
  for (const skipped of ['claude.ai Example', 'plugin:example:thing', 'claude-in-chrome', 'bad.name', 'example-ws', 'patchbay']) {
    assert.ok(r.stdout.includes(skipped), `reports skipped ${skipped}`);
  }
  assert.ok(!r.stdout.includes('super-secret-env-value-1') && !r.stderr.includes('super-secret-env-value-1'), 'never prints env values');
  assert.ok(!r.stdout.includes('secret-header-value-2'));
  if (!IS_WINDOWS) {
    assert.equal(fs.statSync(out).mode & 0o777, 0o600);
  }
  assert.doesNotThrow(() => loadConfig(out), 'the output loads as a valid config');
});

test('import without --project makes everything allow with no autostart', () => {
  const dir = tmpdir();
  const from = path.join(dir, 'claude.json');
  fs.writeFileSync(from, JSON.stringify(claudeJson));
  const out = path.join(dir, 'servers.json');
  const r = runImport(['--from', from, '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  const cfg = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(Object.keys(cfg.servers).sort(), ['example-files', 'example-remote', 'example-sse']);
  assert.ok(Object.values(cfg.servers).every((s) => s.policy === 'allow'));
  assert.deepEqual(cfg.autostart, { default: [], projects: {} });
});

test('import backs up an existing output file and keeps mode 0600', () => {
  const dir = tmpdir();
  const from = path.join(dir, 'claude.json');
  fs.writeFileSync(from, JSON.stringify(claudeJson));
  const out = path.join(dir, 'servers.json');
  fs.writeFileSync(out, '{"version":1,"servers":{}}\n', { mode: 0o644 });
  const r = runImport(['--from', from, '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  const backups = fs.readdirSync(dir).filter((f) => f.startsWith('servers.json.bak-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), '{"version":1,"servers":{}}\n');
  assert.match(r.stdout, /servers\.json\.bak-/);
  if (!IS_WINDOWS) {
    assert.equal(fs.statSync(out).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(dir, backups[0])).mode & 0o777, 0o600);
  }
});

test('import fails clearly on a missing --from', () => {
  const r = runImport(['--out', '/path/to/nowhere.json']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--from/);
});
