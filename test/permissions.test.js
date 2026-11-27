// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { scanSettings } from '../src/permissions.js';
import { tmpdir } from './helpers.js';

test('scanSettings: settings with no permissions, a null document and a non-array allow find nothing', () => {
  const dir = tmpdir();
  const write = (name, text) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, text);
    return f;
  };
  const files = [
    write('empty.json', '{}'),
    write('null.json', 'null'),
    write('allow-string.json', JSON.stringify({ permissions: { allow: 'mcp__patchbay__enable_confirm' } })),
    write('allow.json', JSON.stringify({ permissions: { allow: ['mcp__patchbay__enable_confirm', 'Bash'], defaultMode: 'bypassPermissions' } })),
  ];
  assert.deepEqual(scanSettings(files).map(({ status, rules, bypass }) => ({ status, rules, bypass })), [
    { status: 'ok', rules: [], bypass: false },
    { status: 'ok', rules: [], bypass: false },
    { status: 'ok', rules: [], bypass: false },
    { status: 'ok', rules: ['mcp__patchbay__enable_confirm'], bypass: true },
  ]);
});

test('scanSettings: a missing file, a directory and a syntax error are told apart, with the code', () => {
  const dir = tmpdir();
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{"env": {"TOKEN": "sk-secret-value"');
  const [missing, directory, syntax] = scanSettings([path.join(dir, 'nope.json'), dir, bad]);
  assert.equal(missing.status, 'missing');
  assert.equal(directory.status, 'unreadable');
  assert.equal(directory.error, 'cannot read: EISDIR');
  assert.equal(syntax.status, 'unreadable');
  assert.ok(!syntax.error.includes('sk-secret-value'), 'never the text around the error');
});
