// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { IS_WINDOWS, tmpdir } from './helpers.js';
import { backup, stamp, writeAtomic } from '../src/fsutil.js';

test('writeAtomic writes through a symlink and leaves the link in place', { skip: IS_WINDOWS && 'creating a symlink needs extra privileges on Windows' }, () => {
  const dir = tmpdir();
  const real = path.join(dir, 'real.json');
  const link = path.join(dir, 'link.json');
  fs.writeFileSync(real, '{}\n');
  fs.symlinkSync(real, link);
  writeAtomic(link, '{"a":1}\n', 0o600);
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(fs.readFileSync(real, 'utf8'), '{"a":1}\n');
  assert.equal(fs.statSync(real).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['link.json', 'real.json']);
});

test('writeAtomic removes its temp file when the write fails', () => {
  const dir = tmpdir();
  const target = path.join(dir, 'busy');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'x'), 'x'); // a non-empty directory cannot be renamed over
  assert.throws(() => writeAtomic(target, 'content', 0o600));
  assert.deepEqual(fs.readdirSync(dir), ['busy']);
});

test('backup never overwrites an earlier backup made in the same millisecond', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 26, 12, 0, 0, 0) });
  const dir = tmpdir();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, 'now');
  const taken = `${file}.bak-${stamp()}`;
  fs.writeFileSync(taken, 'earlier');
  fs.writeFileSync(`${taken}-1`, 'earlier too');
  const bak = backup(file);
  assert.equal(bak, `${taken}-2`);
  assert.equal(fs.readFileSync(bak, 'utf8'), 'now');
  assert.equal(fs.readFileSync(taken, 'utf8'), 'earlier');
  assert.equal(backup(path.join(dir, 'missing.json')), null);
});

test('writeAtomic reports the write\'s own error even when removing its temp file fails too', () => {
  const dir = tmpdir();
  const target = path.join(dir, 'busy');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'x'), 'x');
  const rm = mock.method(fs, 'rmSync', () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); });
  try {
    assert.throws(() => writeAtomic(target, 'content', 0o600), (e) => /** @type {any} */ (e).code !== 'EACCES');
    assert.equal(rm.mock.callCount(), 1);
  } finally {
    rm.mock.restore();
  }
  for (const f of fs.readdirSync(dir)) if (f !== 'busy') fs.rmSync(path.join(dir, f));
});
