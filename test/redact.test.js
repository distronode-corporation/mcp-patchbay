import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, RingBuffer, secretsFor } from '../src/redact.js';

test('URL query strings and userinfo are redacted', () => {
  assert.equal(redact('see https://mcp.example.com/mcp?token=abc&x=1 now'), 'see https://mcp.example.com/mcp?[redacted] now');
  assert.equal(redact('https://user:pw@mcp.example.com/a'), 'https://[redacted]@mcp.example.com/a');
  assert.equal(redact('"https://a.example.com/cb?code=1#frag"'), '"https://a.example.com/cb?[redacted]#frag"');
  assert.equal(redact('https://mcp.example.com/mcp'), 'https://mcp.example.com/mcp');
});

test('token shapes are redacted', () => {
  const cases = {
    'Authorization: Bearer abc.def-ghi': 'Authorization: Bearer [redacted]',
    'key sk-proj-abcdefghij1234567890 end': 'key [redacted] end',
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789': '[redacted]',
    'github_pat_11ABCDEFG0123456789_abcdefghijklmnop': '[redacted]',
    'xoxb-1234567890-abcdefghij': '[redacted]',
    'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl': 'jwt [redacted]',
    'hex 0123456789abcdef0123456789abcdef01': 'hex [redacted]',
    'b64 QWxhZGRpbjpvcGVuIHNlc2FtZQ9876543210abcdefXYZ==': 'b64 [redacted]',
    'api_key=hunter2hunter2': 'api_key=[redacted]',
    '"password": "correct horse"': '"password": "[redacted]"',
    'AKIAABCDEFGHIJKLMNOP': '[redacted]',
  };
  for (const [input, want] of Object.entries(cases)) assert.equal(redact(input), want, input);
});

test('ordinary text and absolute paths survive', () => {
  for (const s of [
    'Server started on port 8080',
    '/path/to/project/src/components/SomethingLong2024Component.tsx',
    'Allowed directories: /path/to/project',
    'Error: ENOENT: no such file or directory',
  ]) assert.equal(redact(s), s);
});

test('exact secrets (entry env, args, header values) are scrubbed, short ones are not', () => {
  const entry = { args: ['--root', '/path/to/secret-root'], env: { API_TOKEN: 'plainsecretvalue', LEVEL: 'info' }, headers: { 'X-Key': 'headervalue123' } };
  const secrets = secretsFor(entry);
  assert.ok(secrets.includes('plainsecretvalue'));
  assert.ok(!secrets.includes('info'), 'short values are not treated as secrets');
  const out = redact('failed with plainsecretvalue in /path/to/secret-root (headervalue123) level info', secrets);
  assert.equal(out, 'failed with [redacted] in [redacted] ([redacted]) level info');
});

test('RingBuffer keeps the last N lines', () => {
  const rb = new RingBuffer(3);
  for (const l of ['a', 'b', 'c', 'd']) rb.push(l);
  assert.deepEqual(rb.lines(), ['b', 'c', 'd']);
  assert.equal(rb.last(), 'd');
  assert.deepEqual(rb.lines(2), ['c', 'd']);
});

test('non-string input is stringified', () => {
  assert.equal(redact(new Error('boom https://x.example.com/?a=b')), 'Error: boom https://x.example.com/?[redacted]');
  assert.equal(redact(undefined), '');
});
