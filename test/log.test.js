// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../src/log.js';

test('every level writes one redacted, prefixed line; debug only when switched on', () => {
  const lines = [];
  const log = createLogger({ write: (s) => lines.push(s), debug: false });
  log.info('one');
  log.warn('two');
  log.error('three token=abcdef123456');
  log.debug('hidden');
  createLogger({ write: (s) => lines.push(s), debug: true }).debug('hunter22', ['hunter22']);
  assert.deepEqual(lines, [
    '[mcp-patchbay] info: one\n',
    '[mcp-patchbay] warn: two\n',
    '[mcp-patchbay] error: three token=[redacted]\n',
    '[mcp-patchbay] debug: [redacted]\n',
  ]);
});

test('MCP_PATCHBAY_DEBUG=1 switches debug on when the caller does not say', (t) => {
  const before = process.env.MCP_PATCHBAY_DEBUG;
  t.after(() => {
    if (before === undefined) delete process.env.MCP_PATCHBAY_DEBUG;
    else process.env.MCP_PATCHBAY_DEBUG = before;
  });
  const lines = [];
  process.env.MCP_PATCHBAY_DEBUG = '1';
  createLogger({ write: (s) => lines.push(s) }).debug('on');
  process.env.MCP_PATCHBAY_DEBUG = '0';
  createLogger({ write: (s) => lines.push(s) }).debug('off');
  assert.deepEqual(lines, ['[mcp-patchbay] debug: on\n']);
});

test('the default writer is stderr, and a stderr that throws (closed) never throws into the caller', (t) => {
  const seen = [];
  const write = t.mock.method(process.stderr, 'write', (s) => { seen.push(s); return true; });
  createLogger().warn('to stderr');
  assert.deepEqual(seen, ['[mcp-patchbay] warn: to stderr\n']);
  write.mock.mockImplementation(() => { throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }); });
  assert.doesNotThrow(() => createLogger().error('stderr is gone'));
  assert.equal(write.mock.callCount(), 2);
});
