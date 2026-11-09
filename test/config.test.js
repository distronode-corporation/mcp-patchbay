import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  validateConfig,
  loadConfig,
  resolveConfigPath,
  autostartFor,
  ConfigError,
} from '../src/config.js';
import { CLI, POSIX_ONLY, tmpdir, writeConfig } from './helpers.js';

const good = {
  version: 1,
  servers: {
    'example-files': {
      description: 'Files under /path/to/project',
      policy: 'allow',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem@2.2.0', '/path/to/project'],
      env: { EXAMPLE_LEVEL: 'info' },
      cwd: '/path/to',
      prefix: 'files',
      timeoutMs: 30000,
    },
    'example-remote': {
      description: 'A remote server',
      url: 'https://mcp.example.com/mcp',
      headers: { 'X-Example': 'value' },
    },
    'example-local-http': { url: 'http://127.0.0.1:8080/mcp', policy: 'deny' },
  },
  autostart: { default: ['example-files'], projects: { '/path/to/project': ['example-remote'] } },
  oauth: { configDir: '~/.config/mcp-patchbay/oauth', authTimeoutSeconds: 120 },
};

const clone = (o) => JSON.parse(JSON.stringify(o));
const bad = (mutate, re) => {
  const c = clone(good);
  mutate(c);
  assert.throws(() => validateConfig(c), (e) => e instanceof ConfigError && re.test(e.message), `expected ${re}`);
};

test('a good config validates and gets defaults', () => {
  const c = validateConfig(clone(good));
  assert.deepEqual(c.order, ['example-files', 'example-remote', 'example-local-http']);
  const files = c.servers['example-files'];
  assert.equal(files.kind, 'stdio');
  assert.equal(files.segment, 'files');
  assert.equal(files.timeoutMs, 30000);
  const remote = c.servers['example-remote'];
  assert.equal(remote.kind, 'url');
  assert.equal(remote.policy, 'confirm', 'policy defaults to confirm');
  assert.equal(remote.segment, 'example-remote');
  assert.equal(remote.timeoutMs, 0, 'timeoutMs defaults to 0 (no cap)');
  assert.equal(c.oauth.authTimeoutSeconds, 120);
  assert.equal(c.oauth.configDir, path.join(os.homedir(), '.config/mcp-patchbay/oauth'));
});

test('minimal config gets oauth defaults', () => {
  const c = validateConfig({ version: 1, servers: {} });
  assert.equal(c.oauth.authTimeoutSeconds, 300);
  assert.equal(c.oauth.configDir, path.join(os.homedir(), '.config', 'mcp-patchbay', 'oauth'));
  assert.deepEqual(c.autostart, { default: [], projects: {} });
});

test('unknown keys are rejected with their path', () => {
  bad((c) => { c.extra = 1; }, /unknown key "extra" at \(root\)/);
  bad((c) => { c.servers['example-files'].comand = 'x'; }, /unknown key "comand" at servers\.example-files/);
  bad((c) => { c.autostart.always = []; }, /unknown key "always" at autostart/);
  bad((c) => { c.oauth.port = 1; }, /unknown key "port" at oauth/);
});

test('structural errors', () => {
  bad((c) => { c.version = 2; }, /version must be 1/);
  bad((c) => { delete c.servers; }, /servers is required/);
  bad((c) => { c.servers['example-files'].url = 'https://mcp.example.com/mcp'; }, /exactly one of command or url/);
  bad((c) => { delete c.servers['example-remote'].url; }, /exactly one of command or url/);
  bad((c) => { c.servers['example-files'].headers = { A: 'b' }; }, /headers.*only.*url/);
  bad((c) => { c.servers['example-remote'].args = ['x']; }, /args.*only.*command/);
  bad((c) => { c.servers['example-remote'].cwd = '/tmp'; }, /cwd.*only.*command/);
  bad((c) => { c.servers['example-files'].policy = 'maybe'; }, /policy must be one of/);
  bad((c) => { c.servers['example-files'].cwd = 'relative/dir'; }, /cwd must be an absolute path/);
  bad((c) => { c.servers['example-files'].args = 'x'; }, /args must be an array of strings/);
  bad((c) => { c.servers['example-files'].env = { 'BAD-KEY': 'x' }; }, /env key "BAD-KEY"/);
  bad((c) => { c.servers['example-files'].env = { K: 1 }; }, /env\.K must be a string/);
  bad((c) => { c.servers['example-files'].timeoutMs = -1; }, /timeoutMs must be an integer/);
  bad((c) => { c.servers['example-files'].timeoutMs = 1.5; }, /timeoutMs must be an integer/);
  bad((c) => { c.servers['example-files'].description = 'two\nlines'; }, /description must be one line/);
  bad((c) => { c.servers['example-remote'].url = 'http://mcp.example.com/mcp'; }, /https/);
  bad((c) => { c.servers['example-remote'].url = 'not a url'; }, /url must be/);
  bad((c) => { c.servers['example-remote'].headers = { 'Bad Header': 'x' }; }, /header name "Bad Header"/);
  bad((c) => { c.servers['example-remote'].headers = { A: 'x\ny' }; }, /must not contain line breaks/);
  bad((c) => { c.autostart.default = ['nope']; }, /autostart\.default.*unknown server "nope"/);
  bad((c) => { c.autostart.default = ['example-local-http']; }, /deny/);
  bad((c) => { c.autostart.projects = { 'relative/x': [] }; }, /absolute/);
  bad((c) => { c.oauth.authTimeoutSeconds = 0; }, /authTimeoutSeconds/);
});

test('server name and prefix rules', () => {
  const withName = (n) => ({ version: 1, servers: { [n]: { command: 'x' } } });
  for (const ok of ['a', 'example-files', 'A_b-9', 'x'.repeat(64), 'claude_ai_x']) {
    assert.doesNotThrow(() => validateConfig(withName(ok)), ok);
  }
  for (const no of ['', 'a__b', 'trailing_', 'has space', 'dot.name', 'x'.repeat(65), 'ünïcode']) {
    assert.throws(() => validateConfig(withName(no)), ConfigError, JSON.stringify(no));
  }
  assert.throws(() => validateConfig({ version: 1, servers: { a: { command: 'x', prefix: 'p__q' } } }), /prefix/);
  assert.throws(() => validateConfig({ version: 1, servers: { a: { command: 'x', prefix: 'p_' } } }), /prefix/);
  // segments must be unique (case-insensitively)
  assert.throws(() => validateConfig({ version: 1, servers: { a: { command: 'x', prefix: 'b' }, b: { command: 'y' } } }), /tool-name segment "b"/);
  assert.throws(() => validateConfig({ version: 1, servers: { Ab: { command: 'x' }, aB: { command: 'y' } } }), /segment/);
});

test('config path resolution: flag, then env, then default', () => {
  assert.equal(resolveConfigPath({ flag: '/path/to/a.json', env: { MCP_PATCHBAY_CONFIG: '/path/to/b.json' } }), '/path/to/a.json');
  assert.equal(resolveConfigPath({ env: { MCP_PATCHBAY_CONFIG: '/path/to/b.json' } }), '/path/to/b.json');
  assert.equal(resolveConfigPath({ env: {} }), path.join(os.homedir(), '.config', 'mcp-patchbay', 'servers.json'));
});

test('loadConfig reads and validates a file; bad JSON is a ConfigError', () => {
  const dir = tmpdir();
  const p = writeConfig(dir, good);
  assert.equal(loadConfig(p).order.length, 3);
  fs.writeFileSync(path.join(dir, 'broken.json'), '{ nope', { mode: 0o600 });
  assert.throws(() => loadConfig(path.join(dir, 'broken.json')), (e) => e instanceof ConfigError && /not valid JSON/.test(e.message));
  assert.throws(() => loadConfig(path.join(dir, 'missing.json')), (e) => e instanceof ConfigError && /cannot read/.test(e.message));
});

test('group- or world-writable config is refused', { skip: POSIX_ONLY }, () => {
  const dir = tmpdir();
  const p = writeConfig(dir, good);
  fs.chmodSync(p, 0o620);
  assert.throws(() => loadConfig(p), (e) => e instanceof ConfigError && /group- or world-writable/.test(e.message) && e.exitCode === 78);
  fs.chmodSync(p, 0o602);
  assert.throws(() => loadConfig(p), /group- or world-writable/);
  fs.chmodSync(p, 0o644);
  assert.doesNotThrow(() => loadConfig(p));
});

test('the CLI exits 78 with a clear message for a writable config', { skip: POSIX_ONLY }, () => {
  const dir = tmpdir();
  const p = writeConfig(dir, good);
  fs.chmodSync(p, 0o666);
  const r = spawnSync(process.execPath, [CLI, '--config', p], { encoding: 'utf8', input: '' });
  assert.equal(r.status, 78);
  assert.match(r.stderr, /group- or world-writable/);
  assert.match(r.stderr, /chmod 600/);
  assert.equal(r.stdout, '', 'nothing on stdout');
});

test('the CLI exits 78 for an invalid config', () => {
  const dir = tmpdir();
  const p = writeConfig(dir, { version: 1, servers: { a: { command: 'x', bogus: true } } });
  const r = spawnSync(process.execPath, [CLI, '--config', p], { encoding: 'utf8', input: '' });
  assert.equal(r.status, 78);
  assert.match(r.stderr, /unknown key "bogus" at servers\.a/);
});

test('autostart picks the project list, else default', () => {
  const c = validateConfig(clone(good));
  assert.deepEqual(autostartFor(c, '/path/to/project'), ['example-remote']);
  assert.deepEqual(autostartFor(c, '/path/to/project/'), ['example-remote']);
  assert.deepEqual(autostartFor(c, '/somewhere/else'), ['example-files']);
});
