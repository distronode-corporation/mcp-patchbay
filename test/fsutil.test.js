import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { IS_WINDOWS, tmpdir } from './helpers.js';
import { writeAtomic } from '../src/fsutil.js';

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
