// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

// First run with no config: the default location gets a private starter config and the
// patchbay serves with zero servers. An explicit path that is missing is still an error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ConfigError, STARTER_CONFIG, ensureStarterConfig, expandConfigPath, loadConfig } from '../src/config.js';
import { CLI, IS_WINDOWS, POSIX_ONLY, ROOT, tmpdir } from './helpers.js';

/** An environment whose home directory is `home`, with no config named anywhere. */
function envFor(home) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_RUNTIME_DIR: path.join(home, 'runtime') };
  delete env.MCP_PATCHBAY_CONFIG;
  fs.mkdirSync(env.XDG_RUNTIME_DIR, { recursive: true, mode: 0o700 });
  return env;
}

const configDir = (home) => path.join(home, '.config', 'mcp-patchbay');
const configFile = (home) => path.join(configDir(home), 'servers.json');

/** Starts the CLI with `args` as an MCP client would, and returns the client and its stderr. */
async function connect(home, args = []) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, ...args],
    env: envFor(home),
    stderr: 'pipe',
    cwd: ROOT,
  });
  let stderr = '';
  transport.stderr?.on('data', (d) => { stderr += d.toString(); });
  const client = new Client({ name: 'first-run-test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return { client, stderr: () => stderr };
}

async function serversOf(client) {
  const r = await client.callTool({ name: 'servers', arguments: {} });
  return JSON.parse(/** @type {any} */ (r).content[0].text).servers;
}

test('with no config at the default path, the first run creates a private starter config and serves', async () => {
  const home = tmpdir();
  const { client, stderr } = await connect(home);
  try {
    assert.deepEqual(await serversOf(client), []);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['disable', 'enable', 'info', 'restart', 'servers']);
  } finally {
    await client.close();
  }
  const file = configFile(home);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 1, servers: {} });
  if (!IS_WINDOWS) {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(configDir(home)).mode & 0o777, 0o700);
  }
  const created = stderr().split('\n').filter((l) => l.includes('created a starter config'));
  assert.equal(created.length, 1, stderr());
  // The path is redacted like every logged string (a temp dir can look like a token), so the
  // test checks the part under the home directory.
  assert.ok(created[0].includes(path.join('.config', 'mcp-patchbay', 'servers.json')), created[0]);
  assert.match(created[0], /#quick-start/);
});

test('a second run uses the starter config as it is, without creating it again', async () => {
  const home = tmpdir();
  const first = await connect(home);
  await first.client.close();
  fs.writeFileSync(configFile(home), '{"version":1,"servers":{"a":{"description":"A","command":"x"}}}', { mode: 0o600 });
  const second = await connect(home);
  try {
    assert.deepEqual((await serversOf(second.client)).map((s) => s.name), ['a']);
  } finally {
    await second.client.close();
  }
  assert.doesNotMatch(second.stderr(), /created a starter config/);
});

test('naming the default path explicitly behaves like naming nothing', async () => {
  const home = tmpdir();
  const { client } = await connect(home, ['--config', configFile(home)]);
  try {
    assert.deepEqual(await serversOf(client), []);
  } finally {
    await client.close();
  }
  assert.ok(fs.existsSync(configFile(home)));
});

test('--config naming a missing file elsewhere is still an error, and nothing is created', () => {
  const home = tmpdir();
  const missing = path.join(home, 'elsewhere', 'servers.json');
  const r = spawnSync(process.execPath, [CLI, '--config', missing], { encoding: 'utf8', input: '', env: envFor(home) });
  assert.equal(r.status, 78, r.stderr);
  assert.match(r.stderr, /cannot read config .*ENOENT/);
  assert.equal(fs.existsSync(path.dirname(missing)), false);
  assert.equal(fs.existsSync(configFile(home)), false);
});

test('$MCP_PATCHBAY_CONFIG naming a missing file elsewhere is still an error', () => {
  const home = tmpdir();
  const missing = path.join(home, 'elsewhere.json');
  const r = spawnSync(process.execPath, [CLI], { encoding: 'utf8', input: '', env: { ...envFor(home), MCP_PATCHBAY_CONFIG: missing } });
  assert.equal(r.status, 78, r.stderr);
  assert.equal(fs.existsSync(missing), false);
  assert.equal(fs.existsSync(configFile(home)), false);
});

test('an existing group- or world-writable config directory is refused before anything is written', { skip: POSIX_ONLY }, () => {
  for (const mode of [0o770, 0o777, 0o1777]) {
    const home = tmpdir();
    fs.mkdirSync(configDir(home), { recursive: true });
    fs.chmodSync(configDir(home), mode);
    const r = spawnSync(process.execPath, [CLI], { encoding: 'utf8', input: '', env: envFor(home) });
    assert.equal(r.status, 78, r.stderr);
    assert.match(r.stderr, /group- or world-writable/);
    assert.equal(fs.existsSync(configFile(home)), false, mode.toString(8));
    assert.equal(r.stdout, '');
  }
});

test('a dangling symlink at the default path is not followed or replaced', { skip: POSIX_ONLY }, () => {
  const home = tmpdir();
  fs.mkdirSync(configDir(home), { recursive: true, mode: 0o700 });
  const target = path.join(home, 'target.json');
  fs.symlinkSync(target, configFile(home));
  const r = spawnSync(process.execPath, [CLI], { encoding: 'utf8', input: '', env: envFor(home) });
  assert.equal(r.status, 78, r.stderr);
  assert.equal(fs.existsSync(target), false);
  assert.ok(fs.lstatSync(configFile(home)).isSymbolicLink());
});

test('ensureStarterConfig creates only the default path, once', () => {
  const home = tmpdir();
  const def = configFile(home);
  assert.equal(ensureStarterConfig(path.join(home, 'other.json'), home), false);
  assert.equal(fs.existsSync(configDir(home)), false);
  assert.equal(ensureStarterConfig(def, home), true);
  assert.equal(fs.readFileSync(def, 'utf8'), STARTER_CONFIG);
  assert.doesNotThrow(() => loadConfig(def));
  assert.equal(ensureStarterConfig(def, home), false, 'an existing file is left alone');
  // A relative spelling of the same path is the same path.
  fs.rmSync(def);
  const rel = path.relative(process.cwd(), def);
  assert.equal(ensureStarterConfig(rel, home), true);
});

test('ensureStarterConfig keeps an existing private directory as it is', { skip: POSIX_ONLY }, () => {
  const home = tmpdir();
  fs.mkdirSync(configDir(home), { recursive: true, mode: 0o750 });
  fs.chmodSync(configDir(home), 0o750);
  assert.equal(ensureStarterConfig(configFile(home), home), true);
  assert.equal(fs.statSync(configDir(home)).mode & 0o777, 0o750);
  assert.equal(fs.statSync(configFile(home)).mode & 0o777, 0o600);
});

test('ensureStarterConfig reports a directory it cannot create as a config error', { skip: POSIX_ONLY || (process.getuid?.() === 0 && 'root ignores directory modes') }, () => {
  const home = tmpdir();
  fs.chmodSync(home, 0o500);
  try {
    assert.throws(() => ensureStarterConfig(configFile(home), home), (e) => e instanceof ConfigError && e.exitCode === 78 && /cannot create the config directory .*EACCES/.test(e.message));
  } finally {
    fs.chmodSync(home, 0o700);
  }
});

test('ensureStarterConfig leaves an unreadable default path to loadConfig', { skip: POSIX_ONLY }, () => {
  const home = tmpdir();
  fs.writeFileSync(path.join(home, '.config'), 'not a directory');
  assert.equal(ensureStarterConfig(configFile(home), home), false);
  assert.throws(() => loadConfig(configFile(home)), (e) => e instanceof ConfigError && /ENOTDIR/.test(e.message));
});

test('a literal ${HOME} or ~ at the start of --config is expanded, so the bundle default works unexpanded', async () => {
  for (const spelled of ['${HOME}/.config/mcp-patchbay/servers.json', '~/.config/mcp-patchbay/servers.json']) {
    const home = tmpdir();
    const { client } = await connect(home, ['--config', spelled]);
    try {
      assert.deepEqual(await serversOf(client), []);
    } finally {
      await client.close();
    }
    assert.ok(fs.existsSync(configFile(home)), spelled);
  }
  assert.equal(expandConfigPath('/path/to/${HOME}/a.json'), '/path/to/${HOME}/a.json');
  assert.equal(expandConfigPath('${HOMEDIR}/a.json'), '${HOMEDIR}/a.json');
});

test('--config= with no path is a usage error, not the default', () => {
  const home = tmpdir();
  const r = spawnSync(process.execPath, [CLI, '--config='], { encoding: 'utf8', input: '', env: envFor(home) });
  assert.equal(r.status, 64, r.stderr);
  assert.match(r.stderr, /--config needs a path/);
  assert.equal(fs.existsSync(configFile(home)), false);
});

test('the default path with a trailing separator is not created', () => {
  const home = tmpdir();
  assert.equal(ensureStarterConfig(configFile(home) + path.sep, home), false);
  assert.equal(ensureStarterConfig(configFile(home) + '/', home), false);
  assert.equal(fs.existsSync(configDir(home)), false);
});
