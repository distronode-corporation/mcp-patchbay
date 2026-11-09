import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { FAKE, fake, startPatchbay, tmpdir, waitFor } from './helpers.js';

async function direct(env) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [FAKE], env: { ...process.env, ...env }, stderr: 'ignore' });
  const client = new Client({ name: 'direct', version: '1' });
  await client.connect(transport);
  return client;
}

test('tool definitions and call results pass through unchanged', async (t) => {
  const env = { FAKE_NAME: 'files', FAKE_TOOLS: 'echo,structured' };
  const d = await direct(env);
  t.after(() => d.close());
  const pb = await startPatchbay({ config: { version: 1, servers: { 'example-files': { ...fake(), env } } } });
  t.after(() => pb.close());
  await pb.own('enable', { name: 'example-files' });

  const directTools = (await d.listTools()).tools;
  const proxied = (await pb.client.listTools()).tools.filter((x) => x.name.startsWith('example-files__'));
  assert.equal(proxied.length, directTools.length);
  for (const dt of directTools) {
    const pt = proxied.find((x) => x.name === `example-files__${dt.name}`);
    assert.ok(pt, dt.name);
    assert.deepEqual({ ...pt, name: dt.name }, dt, `tool ${dt.name} identical apart from its name`);
  }
  const structuredTool = proxied.find((x) => x.name === 'example-files__structured');
  assert.equal(structuredTool.outputSchema.required[0], 'answer');

  const args = { value: 'héllo' };
  const viaDirect = await d.request({ method: 'tools/call', params: { name: 'echo', arguments: args } }, CallToolResultSchema);
  const viaPb = await pb.call('example-files__echo', args);
  assert.deepEqual(viaPb, viaDirect);

  // outputSchema declared, no structuredContent returned: passes through, not rejected.
  const s1 = await d.request({ method: 'tools/call', params: { name: 'structured', arguments: {} } }, CallToolResultSchema);
  const s2 = await pb.call('example-files__structured');
  assert.deepEqual(s2, s1);
  assert.equal(s2.structuredContent, undefined);
  assert.equal(s2.isError, undefined);
  assert.deepEqual(s2._meta, { 'example/trace': 'abc' });
});

test('cancellation reaches the child', async (t) => {
  const markers = tmpdir();
  const pb = await startPatchbay({ config: { version: 1, servers: { slow: fake({ tools: 'sleep', env: { FAKE_MARKER_DIR: markers } }) } } });
  t.after(() => pb.close());
  await pb.own('enable', { name: 'slow' });
  const ac = new AbortController();
  const p = pb.call('slow__sleep', { ms: 4000 }, { signal: ac.signal });
  await waitFor(async () => (await pb.own('info', { name: 'slow' })).data.inFlight === 1);
  ac.abort('test cancelled');
  await assert.rejects(p);
  await waitFor(() => fs.existsSync(path.join(markers, 'cancelled')), 3000);
  await waitFor(async () => (await pb.own('info', { name: 'slow' })).data.inFlight === 0, 3000);
});

test('progress is forwarded with the original progress token', async (t) => {
  const pb = await startPatchbay({ config: { version: 1, servers: { slow: fake({ tools: 'sleep' }) } } });
  t.after(() => pb.close());
  await pb.own('enable', { name: 'slow' });
  const seen = [];
  // The SDK client sets progressToken to its own request id; we check that the notifications we
  // receive are matched back to this request (they would be dropped with an "unknown token"
  // error otherwise) and carry the child's progress values.
  const r = await pb.client.request(
    { method: 'tools/call', params: { name: 'slow__sleep', arguments: { ms: 200 } } },
    CallToolResultSchema,
    { onprogress: (p) => seen.push(p) },
  );
  assert.equal(r.content[0].text, 'slept 200');
  assert.deepEqual(seen.map((p) => [p.progress, p.total, p.message]), [[1, 4, 'step 1'], [2, 4, 'step 2'], [3, 4, 'step 3'], [4, 4, 'step 4']]);
});

test('progress uses a string token unchanged', async (t) => {
  const pb = await startPatchbay({ config: { version: 1, servers: { slow: fake({ tools: 'sleep' }) } } });
  t.after(() => pb.close());
  await pb.own('enable', { name: 'slow' });
  const tokens = [];
  // Low-level: send our own token and capture raw progress notifications.
  const { ProgressNotificationSchema } = await import('@modelcontextprotocol/sdk/types.js');
  pb.client.setNotificationHandler(ProgressNotificationSchema, (n) => { tokens.push(n.params.progressToken); });
  await pb.client.request(
    { method: 'tools/call', params: { name: 'slow__sleep', arguments: { ms: 80 }, _meta: { progressToken: 'my-token-1' } } },
    CallToolResultSchema,
  );
  await waitFor(() => tokens.length === 4);
  assert.deepEqual(tokens, ['my-token-1', 'my-token-1', 'my-token-1', 'my-token-1']);
});

test('roots/list and child elicitation are forwarded to the client; sampling is refused', async (t) => {
  const pb = await startPatchbay({
    config: { version: 1, servers: { kid: fake({ tools: 'roots,ask,sample' }) } },
    roots: [{ uri: 'file:///path/to/project', name: 'proj' }],
    onElicit: (p) => (p.message.includes('What colour') ? { action: 'accept', content: { colour: 'teal' } } : { action: 'decline' }),
  });
  t.after(() => pb.close());
  await pb.own('enable', { name: 'kid' });
  const roots = await pb.call('kid__roots');
  assert.deepEqual(JSON.parse(roots.content[0].text), [{ uri: 'file:///path/to/project', name: 'proj' }]);
  const ask = await pb.call('kid__ask');
  assert.deepEqual(JSON.parse(ask.content[0].text), { action: 'accept', content: { colour: 'teal' } });
  const fwd = pb.elicitations.find((e) => e.message.includes('What colour'));
  assert.equal(fwd.message, '[kid] What colour?', 'attributed to the hosted server');
  assert.deepEqual(fwd.requestedSchema.required, ['colour']);
  const sample = await pb.call('kid__sample');
  assert.match(sample.content[0].text, /sampling refused: -32601 .*does not forward sampling\/createMessage/);
});

test('children only get roots and elicitation if the client declared them', async (t) => {
  const pb = await startPatchbay({ config: { version: 1, servers: { kid: fake({ tools: 'roots,ask' }) } }, capabilities: {} });
  t.after(() => pb.close());
  await pb.own('enable', { name: 'kid' });
  const roots = await pb.call('kid__roots');
  assert.equal(roots.isError, true);
  assert.match(roots.content[0].text, /roots/i);
  const ask = await pb.call('kid__ask');
  assert.equal(ask.isError, true);
  assert.match(ask.content[0].text, /elicitation/i);
});

test("a child's own list_changed is merged and re-announced", async (t) => {
  const pb = await startPatchbay({ config: { version: 1, servers: { kid: fake({ tools: 'grow' }), other: fake({ tools: 'echo' }) } } });
  t.after(() => pb.close());
  await pb.own('enable', { name: 'kid' });
  await pb.own('enable', { name: 'other' });
  const before = pb.listChanged.count;
  await pb.call('kid__grow');
  await waitFor(async () => (await pb.toolNames()).includes('kid__grown'), 5000);
  assert.ok(pb.listChanged.count > before);
  const names = await pb.toolNames();
  assert.ok(names.includes('other__echo'), 'other servers untouched');
  assert.equal((await pb.call('kid__grown')).content[0].text, 'grown');
  assert.equal((await pb.state('kid')).toolCount, 2);
});

test('non-JSON stdout from a child is tolerated', async (t) => {
  const pb = await startPatchbay({ config: { version: 1, servers: { noisy: fake({ tools: 'noise,echo', env: { FAKE_NOISE_AT_START: '1' } }) } } });
  t.after(() => pb.close());
  const r = await pb.own('enable', { name: 'noisy' });
  assert.equal(r.isError, false, r.text);
  assert.equal((await pb.call('noisy__noise')).content[0].text, 'noisy');
  assert.equal((await pb.call('noisy__echo', { value: 'v' })).content[0].text, 'fake:echo:{"value":"v"}');
  assert.equal((await pb.state('noisy')).state, 'on');
  const info = await pb.own('info', { name: 'noisy' });
  assert.ok(info.data.stdoutNoise.some((l) => l.includes('garbage line one')));
});

test('protocol errors from a child keep their code and data, with a redacted message', async (t) => {
  const pb = await startPatchbay({ config: { version: 1, servers: { kid: fake({ tools: 'fail' }) } } });
  t.after(() => pb.close());
  await pb.own('enable', { name: 'kid' });
  await assert.rejects(pb.call('kid__fail'), (e) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, -32050);
    assert.deepEqual(e.data, { hint: 'kept' });
    assert.ok(!e.message.includes('supersecretvalue'));
    assert.ok(!e.message.includes('abcdefghijklmnop'));
    assert.match(e.message, /\[redacted\]/);
    return true;
  });
});

test('per-server timeoutMs caps a call', async (t) => {
  const pb = await startPatchbay({ config: { version: 1, servers: { slow: fake({ tools: 'sleep', timeoutMs: 300 }) } } });
  t.after(() => pb.close());
  await pb.own('enable', { name: 'slow' });
  const started = Date.now();
  await assert.rejects(pb.call('slow__sleep', { ms: 3000 }), /timed out/i);
  assert.ok(Date.now() - started < 2500);
});
