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

test('a remote url is a secret: whole, each path segment of 6+ chars, and each query value', () => {
  const entry = { url: 'https://mcp.example.com/s/Zk3aQ9xLm2Pq7/mcp?team=acme-team&k=v' };
  const secrets = secretsFor(entry);
  assert.ok(secrets.includes(entry.url));
  assert.ok(secrets.includes('Zk3aQ9xLm2Pq7'));
  assert.ok(secrets.includes('acme-team'));
  assert.ok(!secrets.includes('mcp') && !secrets.includes('s'), 'short segments are not secrets');
  assert.equal(redact(`Connecting to remote server: ${entry.url}`, secrets), 'Connecting to remote server: [redacted]');
  assert.equal(redact('Connecting to remote server: https://mcp.example.com/s/Zk3aQ9xLm2Pq7/mcp', secrets), 'Connecting to remote server: https://mcp.example.com/s/[redacted]/mcp');
  assert.equal(redact('GET /s/Zk3aQ9xLm2Pq7/mcp 401', secrets), 'GET /s/[redacted]/mcp 401');
});

test('redaction stays linear on long runs that look like the start of a url', () => {
  // Each took tens of seconds at this size before the url rules were bounded.
  for (const s of ['a.'.repeat(131072), 'http://'.repeat(37449), 'ab://'.repeat(52428)]) {
    const t = Date.now();
    redact(s);
    assert.ok(Date.now() - t < 3000, `${s.slice(0, 8)}... took ${Date.now() - t} ms`);
  }
  assert.equal(redact('see https://h.example/p?key=abc and http://h.example/q'), `see https://h.example/p?[redacted] and http://h.example/q`);
});
