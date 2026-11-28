// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

// The command line itself: help, version, usage errors, and how serving ends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { CLI, POSIX_ONLY, ROOT, tmpdir, writeConfig } from './helpers.js';
import { VERSION } from '../src/version.js';

const FSTAT_EIO = pathToFileURL(path.join(ROOT, 'test', 'fixtures', 'fstat-eio.mjs')).href;
const READDIR_NOT_A_LIST = pathToFileURL(path.join(ROOT, 'test', 'fixtures', 'readdir-not-a-list.mjs')).href;

/** The CLI with `args`, stdin closed at once, and a private runtime dir. */
function cli(args, o = {}) {
  const dir = o.dir ?? tmpdir();
  return spawnSync(process.execPath, [...(o.node ?? []), CLI, ...args], {
    encoding: 'utf8',
    input: '',
    env: { ...process.env, XDG_RUNTIME_DIR: dir, ...o.env },
    timeout: 30000,
  });
}

test('--help, -h and help print the usage; --version and -v the version', () => {
  for (const flag of ['--help', '-h', 'help']) {
    const r = cli([flag]);
    assert.equal(r.status, 0, flag);
    assert.match(r.stdout, new RegExp(`^mcp-patchbay ${VERSION.replaceAll('.', '\\.')}: host MCP servers`), flag);
    assert.match(r.stdout, /^Usage:$/m, flag);
  }
  for (const flag of ['--version', '-v']) {
    const r = cli([flag]);
    assert.equal(r.status, 0, flag);
    assert.equal(r.stdout, `${VERSION}\n`, flag);
  }
});

test('usage errors exit 64 with the usage: an unknown command, a flag without its value, an unknown option', () => {
  const cases = [
    [['frobnicate'], /^mcp-patchbay: unknown command "frobnicate"$/m],
    [['--config'], /^mcp-patchbay: --config needs a value$/m],
    [['--config', '--debug'], /^mcp-patchbay: --config needs a value$/m],
    [['--bogus=1'], /^mcp-patchbay: unknown option --bogus$/m],
    [['--config', 'x.json', '--bogus', 'y'], /^mcp-patchbay: unknown option --bogus$/m],
  ];
  for (const [args, re] of cases) {
    const r = cli(args);
    assert.equal(r.status, 64, args.join(' '));
    assert.match(r.stderr, re, args.join(' '));
    assert.match(r.stderr, /^Usage:$/m, args.join(' '));
  }
});

test('serving ends cleanly when stdin closes; a stray positional argument is ignored', () => {
  const dir = tmpdir();
  const p = writeConfig(dir, { version: 1, servers: {} });
  const r = cli(['--config', p, 'stray'], { dir, env: { MCP_PATCHBAY_DEBUG: '1' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /serving 0 server\(s\) from /);
  assert.match(r.stderr, /debug: shut down \(stdin (end|closed)\)/);
});

test('a config load failure that is not about the config exits 1 with the redacted stack', () => {
  const dir = tmpdir();
  const p = writeConfig(dir, { version: 1, servers: {} });
  const r = cli(['--config', p], { dir, node: ['--import', FSTAT_EIO] });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^mcp-patchbay: Error: EIO: i\/o error, fstat\n\s+at /);
});

test('a pidfile holding JSON that is not a record is skipped, and serving goes on', { skip: POSIX_ONLY }, () => {
  const dir = tmpdir();
  const p = writeConfig(dir, { version: 1, servers: {} });
  const pidDir = path.join(dir, `mcp-patchbay-${process.getuid?.() ?? 'user'}`);
  fs.mkdirSync(pidDir, { mode: 0o700 });
  fs.chmodSync(pidDir, 0o700);
  // Valid JSON that is not an object (issue #37): it used to stop the whole reap.
  fs.writeFileSync(path.join(pidDir, '1-2.json'), 'null');
  const r = cli(['--config', p], { dir });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /reaping leftovers failed/);
  assert.match(r.stderr, /serving 0 server\(s\)/);
});

test('a reap that fails anyway is logged, and serving goes on', { skip: POSIX_ONLY }, () => {
  const dir = tmpdir();
  const p = writeConfig(dir, { version: 1, servers: {} });
  const r = cli(['--config', p], { dir, node: ['--import', READDIR_NOT_A_LIST] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /warn: reaping leftovers failed: /);
  assert.match(r.stderr, /serving 0 server\(s\)/);
});

test('serving ends when the client stops reading stdout', { skip: POSIX_ONLY }, async () => {
  const dir = tmpdir();
  const p = writeConfig(dir, { version: 1, servers: {} });
  const child = spawn(process.execPath, [CLI, '--config', p], {
    env: { ...process.env, XDG_RUNTIME_DIR: dir, MCP_PATCHBAY_DEBUG: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  await new Promise((r) => {
    const onData = () => { if (stderr.includes('serving 0 server')) { child.stderr.off('data', onData); r(undefined); } };
    child.stderr.on('data', onData);
  });
  child.stdout.destroy();
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`);
  assert.equal(await exited, 0);
  assert.match(stderr, /debug: shut down \(stdout closed\)/);
});
