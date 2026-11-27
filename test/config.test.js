// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

import { mock, test } from 'node:test';
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
  checkDirPermissions,
  checkFilePermissions,
  ensureStarterConfig,
  expandHome,
  jsonErrorPosition,
  jsonSyntaxMessage,
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

test('examples/servers.json is a valid config', () => {
  const p = new URL('../examples/servers.json', import.meta.url);
  const c = validateConfig(JSON.parse(fs.readFileSync(p, 'utf8')));
  assert.ok(c.order.length >= 3);
});

test('autostart names that are inherited object keys are unknown servers', () => {
  for (const n of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    bad((c) => { c.autostart.default = [n]; }, new RegExp(`autostart\\.default names unknown server "${n}"`));
    bad((c) => { c.autostart.projects = { '/path/to/project': [n] }; }, /unknown server/);
  }
  // a server really called "constructor" is fine
  const c = validateConfig({ version: 1, servers: { constructor: { command: 'x', policy: 'allow' } }, autostart: { default: ['constructor'] } });
  assert.deepEqual(autostartFor(c, '/anywhere'), ['constructor']);
});

test('the CLI exits 78 (not a crash) for autostart.default: ["constructor"]', () => {
  const dir = tmpdir();
  const p = writeConfig(dir, { version: 1, servers: {}, autostart: { default: ['constructor'] } });
  const r = spawnSync(process.execPath, [CLI, '--config', p], { encoding: 'utf8', input: '' });
  assert.equal(r.status, 78, r.stderr);
  assert.match(r.stderr, /unknown server "constructor"/);
});

test('an env key named __proto__ is kept as a plain key', () => {
  const c = validateConfig(JSON.parse('{"version":1,"servers":{"a":{"command":"x","env":{"__proto__":"v1","OK":"v2"}}}}'));
  assert.deepEqual(Object.keys(c.servers.a.env), ['__proto__', 'OK']);
  assert.equal(Object.getPrototypeOf(c.servers.a.env), Object.prototype);
});

const SECRET_JSON = '{\n  "version": 1,\n  "servers": {\n    "gh": {"command": "x", "env": {"GITHUB_TOKEN": ghp_abcdefSECRETSECRET}}\n  }\n}\n';

test('a JSON syntax error reports the file, line and column, never the text around it', () => {
  const dir = tmpdir();
  const p = path.join(dir, 'secret.json');
  fs.writeFileSync(p, SECRET_JSON, { mode: 0o600 });
  assert.throws(() => loadConfig(p), (e) => {
    assert.ok(e instanceof ConfigError);
    assert.match(e.message, /not valid JSON/);
    assert.ok(e.message.includes(p), 'names the file');
    assert.match(e.message, /line 4, column 52/);
    for (const bit of ['ghp_', 'abcdef', 'SECRET', 'B_TOKEN']) assert.ok(!e.message.includes(bit), `no "${bit}" in ${e.message}`);
    return true;
  });
  const r = spawnSync(process.execPath, [CLI, '--config', p], { encoding: 'utf8', input: '' });
  assert.equal(r.status, 78);
  assert.ok(!r.stderr.includes('SECRET') && !r.stderr.includes('ghp_'), r.stderr);
});

test('jsonErrorPosition finds the offset of the first syntax error', () => {
  const cases = [
    ['{"a": tru}', 9], ['{ nope', 2], ['{"a": 1,}', 8], ['', 0], ['{"a":1} x', 8], ['{"k": "v"', 9],
    ['{"a": "x\ny"}', 8], ['[1, 2', 5], ['{"a": -}', 6], ['{"a": "\\q"}', 8], ['{"a": [1, 2], "b": {"c": null}}', -1],
  ];
  for (const [text, want] of cases) assert.equal(jsonErrorPosition(text), want, JSON.stringify(text));
});

test('a config in a group- or world-writable directory is refused', { skip: POSIX_ONLY }, (t) => {
  const dir = tmpdir();
  const p = writeConfig(dir, good);
  t.after(() => fs.chmodSync(dir, 0o700));
  for (const mode of [0o770, 0o707, 0o1777]) {
    fs.chmodSync(dir, mode);
    assert.throws(() => loadConfig(p), (e) => e instanceof ConfigError && e.exitCode === 78 && /directory .* is group- or world-writable/.test(e.message), mode.toString(8));
  }
  fs.chmodSync(dir, 0o755);
  assert.doesNotThrow(() => loadConfig(p));
});

test('a symlinked config is used only if its target passes the same checks', { skip: POSIX_ONLY }, (t) => {
  const linkDir = tmpdir();
  const goodTargetDir = tmpdir();
  const target = writeConfig(goodTargetDir, good);
  const link = path.join(linkDir, 'servers.json');
  fs.symlinkSync(target, link);
  assert.equal(loadConfig(link).order.length, 3, 'a symlink to a safe file in a safe directory works');

  fs.chmodSync(target, 0o666);
  assert.throws(() => loadConfig(link), /group- or world-writable/, 'the target mode is checked');
  fs.chmodSync(target, 0o600);

  const badTargetDir = tmpdir();
  const exposed = writeConfig(badTargetDir, good);
  fs.chmodSync(badTargetDir, 0o777);
  t.after(() => fs.chmodSync(badTargetDir, 0o700));
  const link2 = path.join(linkDir, 'exposed.json');
  fs.symlinkSync(exposed, link2);
  assert.throws(() => loadConfig(link2), (e) => e instanceof ConfigError && /directory .* is group- or world-writable/.test(e.message), 'the target directory is checked');
});

test('a config that is not a regular file is refused without blocking', { skip: POSIX_ONLY }, () => {
  const dir = tmpdir();
  const fifo = path.join(dir, 'servers.json');
  const r = spawnSync('mkfifo', [fifo]);
  if (r.status !== 0) return;
  assert.throws(() => loadConfig(fifo), /not a regular file/);
});

test('confirmVia defaults to elicitation, accepts host, and rejects anything else', () => {
  assert.equal(validateConfig({ version: 1, servers: {} }).confirmVia, 'elicitation');
  assert.equal(validateConfig({ version: 1, confirmVia: 'elicitation', servers: {} }).confirmVia, 'elicitation');
  assert.equal(validateConfig({ version: 1, confirmVia: 'host', servers: {} }).confirmVia, 'host');
  for (const v of ['Host', 'prompt', '', true, 1, null, ['host']]) {
    assert.throws(
      () => validateConfig({ version: 1, confirmVia: v, servers: {} }),
      (e) => e instanceof ConfigError && /confirmVia must be one of elicitation, host/.test(e.message),
      String(v),
    );
  }
});

test('the CLI exits 78 for an invalid confirmVia', () => {
  const dir = tmpdir();
  const p = writeConfig(dir, { version: 1, confirmVia: 'sometimes', servers: {} });
  const r = spawnSync(process.execPath, [CLI, 'doctor', '--config', p, '--no-start'], { encoding: 'utf8' });
  assert.equal(r.status, 78);
  assert.match(r.stderr, /confirmVia must be one of/);
});

test('validation refuses each wrong type at its own path', () => {
  bad((c) => { c.servers = []; }, /^servers must be an object$/);
  bad((c) => { c.servers['example-files'] = 'npx'; }, /^servers\.example-files must be an object$/);
  bad((c) => { c.servers['example-files'].description = 7; }, /description must be a string/);
  bad((c) => { c.servers['example-files'].description = 'x'.repeat(301); }, /description must be at most 300 characters/);
  bad((c) => { c.servers['example-files'].command = ''; }, /command must be a non-empty string/);
  bad((c) => { c.servers['example-files'].command = ['npx']; }, /command must be a non-empty string/);
  bad((c) => { c.servers['example-files'].env = ['K=v']; }, /env must be an object of strings/);
  bad((c) => { c.servers['example-remote'].url = 42; }, /url must be a string/);
  bad((c) => { c.autostart = []; }, /^autostart must be an object$/);
  bad((c) => { c.autostart.default = 'example-files'; }, /autostart\.default must be an array of server names/);
  bad((c) => { c.autostart.default = [1]; }, /autostart\.default must be an array of server names/);
  bad((c) => { c.autostart.projects = ['/path/to/project']; }, /autostart\.projects must be an object/);
  bad((c) => { c.oauth = 'dir'; }, /^oauth must be an object$/);
  bad((c) => { c.oauth.configDir = ''; }, /oauth\.configDir must be a path/);
  bad((c) => { c.oauth.configDir = 5; }, /oauth\.configDir must be a path/);
  bad((c) => { c.oauth.configDir = 'relative/oauth'; }, /oauth\.configDir must be absolute/);
  assert.throws(() => validateConfig([]), /^ConfigError: the config must be a JSON object$|the config must be a JSON object/);
  assert.throws(() => validateConfig(null), /the config must be a JSON object/);
});

test('a Windows-style absolute oauth.configDir is accepted on every system, and ~ alone is the home directory', () => {
  const c = clone(good);
  c.oauth.configDir = 'C:\\Users\\example\\oauth';
  assert.equal(validateConfig(c).oauth.configDir, 'C:\\Users\\example\\oauth');
  assert.equal(expandHome('~'), os.homedir());
});

test('jsonErrorPosition finds the offset of each kind of syntax error', () => {
  assert.equal(jsonErrorPosition('{}'), -1);
  assert.equal(jsonErrorPosition('[ ]'), -1);
  assert.equal(jsonErrorPosition('{"a": "\\u00e9\\n"}'), -1);
  assert.equal(jsonErrorPosition('"abc'), 4, 'an unterminated string fails at the end');
  assert.equal(jsonErrorPosition('"abc\\'), 5, 'a backslash at the very end');
  assert.equal(jsonErrorPosition('"\\x"'), 2, 'an unknown escape');
  assert.equal(jsonErrorPosition('"\\u12g4"'), 2, 'a \\u escape without four hex digits');
  assert.equal(jsonErrorPosition('{"a" 1}'), 5, 'a missing colon');
});

test('JSON too deeply nested to scan is still reported, without a position', () => {
  const deep = '['.repeat(200000);
  assert.equal(jsonErrorPosition(deep), -1);
  assert.equal(jsonSyntaxMessage('config x.json', deep), 'config x.json is not valid JSON');
});

test('a config owned by root is accepted and one owned by another user is refused', { skip: POSIX_ONLY || (process.getuid?.() === 0 && 'root is the other user here') }, () => {
  const dir = tmpdir();
  const p = writeConfig(dir, { version: 1, servers: {} });
  const st = fs.statSync(p);
  const other = process.getuid() + 1;
  assert.doesNotThrow(() => checkFilePermissions(p, Object.assign(st, { uid: 0 })));
  assert.throws(() => checkFilePermissions(p, Object.assign(fs.statSync(p), { uid: other })), (e) => e instanceof ConfigError && new RegExp(`owned by uid ${other}, not by you`).test(e.message));
});

test('a config directory owned by root is accepted, one owned by another user or unreadable is refused', { skip: POSIX_ONLY || (process.getuid?.() === 0 && 'root is the other user here') }, (t) => {
  const dir = tmpdir();
  const p = writeConfig(dir, { version: 1, servers: {} });
  const real = fs.statSync;
  let uid = 0;
  const stat = t.mock.method(fs, 'statSync', (f, ...rest) => (f === dir ? Object.assign(real(f, ...rest), { uid }) : real(f, ...rest)));
  assert.doesNotThrow(() => checkDirPermissions(p, dir));
  uid = process.getuid() + 1;
  assert.throws(() => checkDirPermissions(p, dir), new RegExp(`directory .* is owned by uid ${uid}, not by you`));
  stat.mock.restore();
  assert.throws(() => checkDirPermissions(p, path.join(dir, 'gone')), (e) => e instanceof ConfigError && /cannot check the directory of config .*: ENOENT$/.test(e.message));
});

test('loadConfig reports a read error on the open file as a config error, with its code', (t) => {
  const dir = tmpdir();
  const p = writeConfig(dir, { version: 1, servers: {} });
  t.mock.method(fs, 'readFileSync', () => { throw Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' }); });
  assert.throws(() => loadConfig(p), (e) => e instanceof ConfigError && e.message === `cannot read config ${p}: EIO`);
});

test('ensureStarterConfig: a default path it cannot create the file in, and a write that fails, leave no file', { skip: POSIX_ONLY || (process.getuid?.() === 0 && 'root ignores directory modes') }, (t) => {
  const home = tmpdir();
  const dir = path.join(home, '.config', 'mcp-patchbay');
  const def = path.join(dir, 'servers.json');
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, 0o500);
  try {
    assert.throws(() => ensureStarterConfig(def, home), (e) => e instanceof ConfigError && e.message === `cannot create config ${def}: EACCES`);
  } finally {
    fs.chmodSync(dir, 0o700);
  }
  const enospc = Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
  const write = t.mock.method(fs, 'writeFileSync', () => { throw enospc; });
  assert.throws(() => ensureStarterConfig(def, home), (e) => e instanceof ConfigError && e.message === `cannot write config ${def}: ENOSPC`);
  assert.equal(fs.existsSync(def), false, 'the half-written file is removed');
  // Removing it can fail too; the write's error is still the one reported.
  const rm = t.mock.method(fs, 'rmSync', () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); });
  assert.throws(() => ensureStarterConfig(def, home), (e) => e instanceof ConfigError && e.message === `cannot write config ${def}: ENOSPC`);
  assert.equal(rm.mock.callCount(), 1);
  rm.mock.restore();
  write.mock.restore();
  fs.rmSync(def, { force: true });
});

test('ensureStarterConfig leaves a config that appears between its check and its create alone', (t) => {
  const home = tmpdir();
  const dir = path.join(home, '.config', 'mcp-patchbay');
  const def = path.join(dir, 'servers.json');
  const real = fs.lstatSync;
  // Another process (a second patchbay starting at once) writes the file right after the check.
  t.mock.method(fs, 'lstatSync', (f, ...rest) => {
    if (f !== def) return real(f, ...rest);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(def, '{"version":1,"servers":{"theirs":{"command":"x"}}}', { mode: 0o600 });
    throw Object.assign(new Error(`ENOENT: no such file or directory, lstat '${def}'`), { code: 'ENOENT' });
  });
  assert.equal(ensureStarterConfig(def, home), false);
  assert.equal(fs.readFileSync(def, 'utf8'), '{"version":1,"servers":{"theirs":{"command":"x"}}}');
});
