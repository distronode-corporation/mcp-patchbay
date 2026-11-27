// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CLI, FAKE, fake, tmpdir, writeConfig } from './helpers.js';
import { runDoctor } from '../src/doctor.js';

const config = {
  version: 1,
  servers: {
    'example-ok': fake({ tools: 'echo,pid', policy: 'allow' }),
    'example-broken': { ...fake({ policy: 'allow', env: { FAKE_EXIT_ON_START: '2', FAKE_STDERR: 'fatal: token sk-abcdefghijklmnopqrstuvwxyz' } }) },
    'example-confirm': fake({ tools: 'echo', policy: 'confirm' }),
    'example-deny': fake({ policy: 'deny' }),
  },
};

test('doctor starts allow servers, prints counts and the first error, skips confirm', () => {
  const dir = tmpdir();
  const p = writeConfig(dir, config);
  const r = spawnSync(process.execPath, [CLI, 'doctor', '--config', p], { encoding: 'utf8', env: { ...process.env, XDG_RUNTIME_DIR: dir } });
  assert.equal(r.status, 1, 'non-zero because one server failed');
  assert.match(r.stdout, /config ok/i);
  assert.match(r.stdout, /^example-ok: ok, 2 tools$/m);
  assert.match(r.stdout, /^example-broken: failed: /m);
  assert.match(r.stdout, /^example-confirm: skipped \(policy confirm; use --all\)$/m);
  assert.match(r.stdout, /^example-deny: skipped \(policy deny\)$/m);
  assert.ok(!r.stdout.includes('sk-abcdefghijklmnopqrstuvwxyz'));
});

test('doctor --all also starts confirm servers but never deny ones', () => {
  const dir = tmpdir();
  const p = writeConfig(dir, { version: 1, servers: { 'example-confirm': config.servers['example-confirm'], 'example-deny': config.servers['example-deny'] } });
  const r = spawnSync(process.execPath, [CLI, 'doctor', '--config', p, '--all'], { encoding: 'utf8', env: { ...process.env, XDG_RUNTIME_DIR: dir } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^example-confirm: ok, 1 tools?$/m);
  assert.match(r.stdout, /^example-deny: skipped \(policy deny\)$/m);
});

test('doctor exits 78 on an invalid config', () => {
  const dir = tmpdir();
  const p = writeConfig(dir, { version: 1, servers: { x: { command: 'a', url: 'https://mcp.example.com/mcp' } } });
  const r = spawnSync(process.execPath, [CLI, 'doctor', '--config', p], { encoding: 'utf8' });
  assert.equal(r.status, 78);
  assert.match(r.stderr, /exactly one of command or url/);
});

/** runDoctor in this process, with its output collected and process.env patched for the run. */
async function doctor(argv, env = {}) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  let out = '';
  let err = '';
  try {
    const code = await runDoctor(argv, { out: (s) => { out += s; }, err: (s) => { err += s; } });
    return { code, out, err };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('doctor --config= and --project= take their value after the equals sign', async () => {
  const dir = tmpdir();
  const p = writeConfig(dir, { version: 1, servers: {} });
  const r = await doctor([`--config=${p}`, `--project=${dir}`, '--no-start'], { HOME: dir, USERPROFILE: dir });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, new RegExp(`^config ok: ${p.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')} \\(0 servers\\)$`, 'm'));
  assert.ok(r.out.includes(path.join(dir, '.claude', 'settings.local.json')), 'the project\'s settings were read');
});

test('doctor names the first stderr line of a server that fails, and logs through stderr with MCP_PATCHBAY_DEBUG=1', async () => {
  const dir = tmpdir();
  const p = writeConfig(dir, {
    version: 1,
    servers: { 'example-noisy': { policy: 'allow', command: process.execPath, args: ['-e', 'console.error("noisy: first line"); console.error("second"); process.exit(3)'] } },
  });
  const r = await doctor(['--config', p], { XDG_RUNTIME_DIR: dir, MCP_PATCHBAY_DEBUG: '1' });
  assert.equal(r.code, 1);
  assert.match(r.out, /^example-noisy: failed: .*; first stderr: noisy: first line$/m);
  assert.match(r.err, /\[mcp-patchbay\] debug: \[example-noisy\] noisy: first line/);
});

test('doctor reports a command that does not exist as not found', async () => {
  const dir = tmpdir();
  const p = writeConfig(dir, { version: 1, servers: { 'example-missing': { policy: 'allow', command: path.join(dir, 'no-such-program') } } });
  const r = await doctor(['--config', p], { XDG_RUNTIME_DIR: dir });
  assert.equal(r.code, 1);
  assert.match(r.out, /^example-missing: failed: command not found \(ENOENT\)$/m);
});

test('doctor starts a url server through mcp-remote, with the sign-in budget', async () => {
  const dir = tmpdir();
  const p = writeConfig(dir, {
    version: 1,
    servers: { 'example-remote': { policy: 'allow', url: 'https://mcp.example.com/mcp', env: { FAKE_TOOLS: 'echo' } } },
    oauth: { configDir: path.join(dir, 'oauth'), authTimeoutSeconds: 30 },
  });
  // The fake server stands in for mcp-remote, as in auth.test.js.
  const r = await doctor(['--config', p], { XDG_RUNTIME_DIR: dir, MCP_PATCHBAY_MCP_REMOTE_BIN: FAKE });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /^example-remote: ok, 1 tool$/m);
  assert.ok(fs.existsSync(path.join(dir, 'oauth')));
});

test('doctor rethrows a config load failure that is not about the config itself', async (t) => {
  const dir = tmpdir();
  const p = writeConfig(dir, { version: 1, servers: {} });
  const eio = Object.assign(new Error('EIO: i/o error, fstat'), { code: 'EIO' });
  const fstat = mock.method(fs, 'fstatSync', () => { throw eio; });
  t.after(() => fstat.mock.restore());
  await assert.rejects(doctor(['--config', p, '--no-start']), (e) => e === eio);
});
