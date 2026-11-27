// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

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
  assert.equal(cfg.confirmVia, 'host', 'Claude Code configs confirm through the host permission prompt');
  assert.match(r.stdout, /confirmVia: host/);
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

test('import --project with an inherited key name is "not found"', () => {
  const dir = tmpdir();
  const from = path.join(dir, 'claude.json');
  fs.writeFileSync(from, JSON.stringify(claudeJson));
  for (const p of ['constructor', 'toString']) {
    const r = runImport(['--from', from, '--project', p, '--out', path.join(dir, 'out.json')]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(`project "${p}" not found`));
  }
});

test('a JSON syntax error in the Claude config does not echo its contents', () => {
  const dir = tmpdir();
  const from = path.join(dir, 'claude.json');
  fs.writeFileSync(from, '{"mcpServers": {"gh": {"command": "x", "env": {"GITHUB_TOKEN": ghp_abcdefSECRETSECRET}}}}');
  const r = runImport(['--from', from, '--out', path.join(dir, 'out.json')]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not valid JSON/);
  assert.match(r.stderr, /line 1, column 64/);
  assert.ok(r.stderr.includes(from));
  assert.ok(!r.stderr.includes('SECRET') && !r.stderr.includes('ghp_') && !r.stderr.includes('TOKEN'), r.stderr);
});

test('import skips definitions it cannot convert or that fail validation, and keeps the rest', () => {
  const dir = tmpdir();
  const from = path.join(dir, 'claude.json');
  const cwd = path.resolve(dir, 'work');
  fs.writeFileSync(from, JSON.stringify({
    mcpServers: {
      'example-null': null,
      'example-string': 'npx something',
      'example-untyped-url': { url: 'https://mcp.example.com/untyped' },
      'example-http-no-url': { type: 'http' },
      'example-empty-command': { command: '' },
      'example-cwd': { command: 'node', args: [], env: {}, cwd },
      'example-number-args': { command: 'node', args: [1, 2] },
      'example-plain-http': { type: 'http', url: 'http://mcp.example.com/mcp', headers: {} },
    },
    projects: { [PROJECT]: {} },
  }));
  const out = path.join(dir, 'servers.json');
  const r = runImport(['--from', from, '--project', PROJECT, '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  const cfg = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(cfg.servers, {
    'example-untyped-url': { description: 'Imported from Claude Code (http)', policy: 'allow', url: 'https://mcp.example.com/untyped' },
    'example-cwd': { description: 'Imported from Claude Code (stdio)', policy: 'allow', command: 'node', cwd },
  });
  assert.deepEqual(cfg.autostart.projects[PROJECT], ['example-untyped-url', 'example-cwd'], 'a project with no lists of its own');
  assert.match(r.stdout, /^ {2}example-null: definition is not an object$/m);
  assert.match(r.stdout, /^ {2}example-string: definition is not an object$/m);
  assert.match(r.stdout, /^ {2}example-http-no-url: type http without a url$/m);
  assert.match(r.stdout, /^ {2}example-empty-command: stdio without a command$/m);
  assert.match(r.stdout, /^ {2}example-number-args: not valid here: servers\.example-number-args\.args must be an array of strings$/m);
  assert.match(r.stdout, /^ {2}example-plain-http: not valid here: .*must use https/m);
});

test('import --project that imports nothing says the autostart list is empty', () => {
  const dir = tmpdir();
  const from = path.join(dir, 'claude.json');
  fs.writeFileSync(from, JSON.stringify({ projects: { [PROJECT]: { mcpServers: {}, disabledMcpServers: 'not a list' } } }));
  const r = runImport(['--from', from, '--project', PROJECT, '--out', path.join(dir, 'servers.json')]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^Autostart for ${PROJECT}: \\(none\\)$`, 'm'));
});

test('import usage errors: a flag with no value and an unknown argument exit 64', () => {
  const missing = runImport(['--from']);
  assert.equal(missing.status, 64);
  assert.match(missing.stderr, /^import: --from needs a value$/m);
  const unknown = runImport(['--frm', 'claude.json']);
  assert.equal(unknown.status, 64);
  assert.match(unknown.stderr, /^import: unknown argument --frm$/m);
  assert.match(unknown.stderr, /^Usage: mcp-patchbay import /m);
});

test('import without --out writes the default config path under the home directory', () => {
  const home = tmpdir();
  const from = path.join(home, 'claude.json');
  fs.writeFileSync(from, JSON.stringify({ mcpServers: { 'example-files': { command: 'node' } } }));
  const r = spawnSync(process.execPath, [CLI, 'import', '--from', from], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
  assert.equal(r.status, 0, r.stderr);
  const out = path.join(home, '.config', 'mcp-patchbay', 'servers.json');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(out, 'utf8')).servers), ['example-files']);
  assert.match(r.stdout, /Wrote .*servers\.json \(mode 0600\)/);
});
