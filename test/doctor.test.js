import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { CLI, fake, tmpdir, writeConfig } from './helpers.js';

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
