import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ElicitationCompleteNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { FAKE, IS_WINDOWS, POSIX_ONLY, startPatchbay, tmpdir, waitFor } from './helpers.js';
import { isMcpRemote } from '../src/children.js';
import { commandLineOf } from '../src/process.js';

const AUTH_URL = 'https://auth.example.com/authorize?client_id=fake-client&state=abc123state&code_challenge=xyz';

function remoteConfig(markers, oauthDir, extra = {}) {
  return {
    version: 1,
    servers: {
      'example-remote': {
        description: 'Example remote',
        policy: 'allow',
        url: 'https://mcp.example.com/mcp',
        headers: { Authorization: 'Bearer abcdefghijklmnop1234', 'X-Plain': '${EXAMPLE_VAR}' },
        env: { FAKE_AUTH: '1', FAKE_MARKER_DIR: markers, FAKE_DUMP_ARGV: '1', FAKE_TOOLS: 'echo,pid', FAKE_NAME: 'remote', FAKE_AUTH_URL: AUTH_URL },
        ...extra,
      },
    },
    oauth: { configDir: oauthDir, authTimeoutSeconds: 45 },
  };
}

test('sign-in flow: waiting-for-sign-in, URL elicitation, then completion', async (t) => {
  const markers = tmpdir();
  const oauthDir = path.join(tmpdir(), 'oauth', 'nested');
  const pb = await startPatchbay({
    config: remoteConfig(markers, oauthDir),
    env: { MCP_PATCHBAY_MCP_REMOTE_BIN: FAKE },
    onElicit: () => ({ action: 'accept' }),
  });
  t.after(() => pb.close());
  const completes = [];
  pb.client.setNotificationHandler(ElicitationCompleteNotificationSchema, (n) => { completes.push(n.params.elicitationId); });

  const enabling = pb.own('enable', { name: 'example-remote' });
  await waitFor(() => pb.elicitations.length === 1, 10000);
  const e = pb.elicitations[0];
  assert.equal(e.mode, 'url');
  assert.equal(e.url, AUTH_URL, 'the person gets the full, working URL');
  assert.match(e.message, /^\[example-remote\] Sign in to example-remote/, 'labelled with the server name');
  assert.ok(e.elicitationId);

  // enable is still pending, and other calls are served meanwhile
  const s = await pb.own('servers');
  const remote = s.data.servers.find((x) => x.name === 'example-remote');
  assert.equal(remote.state, 'waiting-for-sign-in');
  assert.ok(!s.text.includes('abc123state'), 'URL query never in servers output');

  fs.writeFileSync(path.join(markers, 'signed-in'), 'ok');
  const r = await enabling;
  assert.equal(r.isError, false, r.text);
  assert.equal(r.data.state, 'on');
  assert.equal(r.data.toolCount, 2);
  assert.equal((await pb.call('example-remote__echo', { value: 'hi' })).content[0].text, 'remote:echo:{"value":"hi"}');
  await waitFor(() => completes.length === 1);
  assert.equal(completes[0], e.elicitationId);
  assert.ok(!pb.stderr().includes('abc123state'), 'URL query never in logs');

  // argv and env handed to mcp-remote
  const dump = JSON.parse(fs.readFileSync(path.join(markers, 'argv-remote.json'), 'utf8'));
  assert.deepEqual(dump.argv, [
    'https://mcp.example.com/mcp',
    '--auth-timeout', '45',
    '--header', 'Authorization:${MCP_PATCHBAY_HEADER_0}',
    '--header', 'X-Plain:${EXAMPLE_VAR}',
  ]);
  assert.equal(dump.env.MCP_PATCHBAY_HEADER_0, 'Bearer abcdefghijklmnop1234');
  assert.equal(dump.env.MCP_PATCHBAY_HEADER_1, undefined, 'placeholders are passed literally');
  assert.equal(dump.env.MCP_REMOTE_CONFIG_DIR, oauthDir);
  if (!IS_WINDOWS) {
    assert.equal(fs.statSync(oauthDir).mode & 0o777, 0o700);
    const childPid = JSON.parse((await pb.call('example-remote__pid')).content[0].text).pid;
    const cmdline = commandLineOf(childPid);
    assert.ok(cmdline.includes('--auth-timeout'));
    assert.ok(!cmdline.includes('abcdefghijklmnop1234'), 'header secret is not in the process list');
  }
});

test('sign-in falls back to a form elicitation carrying the URL', async (t) => {
  const markers = tmpdir();
  const pb = await startPatchbay({
    config: remoteConfig(markers, path.join(tmpdir(), 'oauth')),
    env: { MCP_PATCHBAY_MCP_REMOTE_BIN: FAKE },
    capabilities: { elicitation: {} },
    onElicit: () => {
      fs.writeFileSync(path.join(markers, 'signed-in'), 'ok');
      return { action: 'accept', content: { done: true } };
    },
  });
  t.after(() => pb.close());
  const r = await pb.own('enable', { name: 'example-remote' });
  assert.equal(r.isError, false, r.text);
  assert.equal(pb.elicitations.length, 1);
  assert.equal(pb.elicitations[0].mode, 'form');
  assert.ok(pb.elicitations[0].message.includes(AUTH_URL));
});

test('declining the sign-in aborts the start', async (t) => {
  const markers = tmpdir();
  const pb = await startPatchbay({
    config: remoteConfig(markers, path.join(tmpdir(), 'oauth')),
    env: { MCP_PATCHBAY_MCP_REMOTE_BIN: FAKE },
    onElicit: () => ({ action: 'decline' }),
  });
  t.after(() => pb.close());
  const r = await pb.own('enable', { name: 'example-remote' });
  assert.equal(r.isError, true);
  assert.match(r.text, /sign-in declined/);
  assert.equal((await pb.state('example-remote')).state, 'failed');
});

test('a plain stdio child cannot raise a sign-in prompt, at startup or later', async (t) => {
  const evil = 'https://evil.example/authorize?x=1';
  const pb = await startPatchbay({
    config: {
      version: 1,
      servers: {
        plain: { command: process.execPath, args: [FAKE], policy: 'allow', env: { FAKE_TOOLS: 'authline', FAKE_AUTH_URL: evil, FAKE_STDERR: `Please authorize this client by visiting: ${evil}` } },
      },
    },
    onElicit: () => ({ action: 'accept' }),
  });
  t.after(() => pb.close());
  const r = await pb.own('enable', { name: 'plain' });
  assert.equal(r.isError, false, r.text);
  await pb.call('plain__authline');
  await new Promise((res) => setTimeout(res, 200));
  assert.equal(pb.elicitations.length, 0, 'no elicitation for a child that is not mcp-remote');
});

test('a url server that prints the auth line while on gets no new prompt', async (t) => {
  const pb = await startPatchbay({
    config: {
      version: 1,
      servers: { 'example-remote': { url: 'https://mcp.example.com/mcp', policy: 'allow', env: { FAKE_TOOLS: 'authline' } } },
      oauth: { configDir: path.join(tmpdir(), 'oauth'), authTimeoutSeconds: 30 },
    },
    env: { MCP_PATCHBAY_MCP_REMOTE_BIN: FAKE },
    onElicit: () => ({ action: 'accept' }),
  });
  t.after(() => pb.close());
  assert.equal((await pb.own('enable', { name: 'example-remote' })).isError, false);
  await pb.call('example-remote__authline');
  await new Promise((res) => setTimeout(res, 200));
  assert.equal(pb.elicitations.length, 0);
});

test('a stdio command named mcp-remote (e.g. npx mcp-remote) still gets the sign-in prompt, labelled', { skip: POSIX_ONLY }, async (t) => {
  const markers = tmpdir();
  const bin = path.join(tmpdir(), 'mcp-remote');
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
  const pb = await startPatchbay({
    config: { version: 1, servers: { wrapped: { command: bin, policy: 'allow', env: { FAKE_AUTH: '1', FAKE_MARKER_DIR: markers, FAKE_AUTH_URL: AUTH_URL } } } },
    onElicit: () => {
      fs.writeFileSync(path.join(markers, 'signed-in'), 'ok');
      return { action: 'accept' };
    },
  });
  t.after(() => pb.close());
  const r = await pb.own('enable', { name: 'wrapped' });
  assert.equal(r.isError, false, r.text);
  assert.equal(pb.elicitations[0].url, AUTH_URL);
  assert.match(pb.elicitations[0].message, /^\[wrapped\] /);
});

test('real mcp-remote 0.15.2 bridges a local HTTP server, with headers expanded from env', { skip: POSIX_ONLY, timeout: 60000 }, async (t) => {
  const seenAuth = [];
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization) seenAuth.push(req.headers.authorization);
    if (!req.url.startsWith('/mcp')) { res.writeHead(404).end(); return; }
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    const mcp = new McpServer({ name: 'http-fake', version: '1.0.0' }, { instructions: 'HTTP fake instructions' });
    mcp.registerTool('hello', { description: 'says hello' }, async () => ({ content: [{ type: 'text', text: 'hello over http' }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); mcp.close(); });
    let body = '';
    for await (const chunk of req) body += chunk;
    await mcp.connect(transport);
    await transport.handleRequest(req, res, JSON.parse(body));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const port = /** @type {any} */ (server.address()).port;
  const oauthDir = path.join(tmpdir(), 'oauth');
  const pb = await startPatchbay({
    config: {
      version: 1,
      servers: { 'example-local': { url: `http://127.0.0.1:${port}/mcp`, policy: 'allow', headers: { Authorization: 'Bearer local-test-token-value' } } },
      oauth: { configDir: oauthDir, authTimeoutSeconds: 30 },
    },
  });
  t.after(() => pb.close());
  const r = await pb.own('enable', { name: 'example-local' });
  assert.equal(r.isError, false, `${r.text}\n${pb.stderr()}`);
  assert.equal(r.data.toolCount, 1);
  assert.equal(r.data.instructions, 'HTTP fake instructions');
  assert.equal((await pb.call('example-local__hello')).content[0].text, 'hello over http');
  assert.ok(seenAuth.includes('Bearer local-test-token-value'), 'mcp-remote expanded ${MCP_PATCHBAY_HEADER_0}');
  assert.ok(fs.existsSync(oauthDir));
  assert.ok(!pb.stderr().includes('local-test-token-value'));
});

test('a token in the remote url path never appears in info, lastError or logs', async (t) => {
  const TOKEN = 'Zk3aQ9xLm2Pq7';
  const pb = await startPatchbay({
    config: {
      version: 1,
      servers: {
        'example-remote': {
          policy: 'allow',
          url: `https://mcp.example.com/s/${TOKEN}/mcp`,
          env: { FAKE_LOG_URL: '1', FAKE_EXIT_ON_START: '3' },
        },
      },
      oauth: { configDir: path.join(tmpdir(), 'oauth'), authTimeoutSeconds: 30 },
    },
    env: { MCP_PATCHBAY_MCP_REMOTE_BIN: FAKE, MCP_PATCHBAY_DEBUG: '1' },
  });
  t.after(() => pb.close());
  const r = await pb.own('enable', { name: 'example-remote' });
  assert.equal(r.isError, true);
  const servers = await pb.own('servers');
  const info = await pb.own('info', { name: 'example-remote' });
  assert.match(info.text, /Connecting to remote server/, 'the line itself is kept');
  for (const [what, text] of [['enable', r.text], ['servers', servers.text], ['info', info.text], ['logs', pb.stderr()]]) {
    assert.ok(!text.includes(TOKEN), `${what} must not contain the url token`);
  }
});

test('isMcpRemote: url entries, an mcp-remote command, and npx mcp-remote; nothing else', () => {
  assert.equal(isMcpRemote({ kind: 'url' }), true);
  assert.equal(isMcpRemote({ kind: 'stdio', command: '/usr/local/bin/mcp-remote', args: [] }), true);
  assert.equal(isMcpRemote({ kind: 'stdio', command: 'C:\\tools\\mcp-remote.cmd', args: [] }), true);
  assert.equal(isMcpRemote({ kind: 'stdio', command: 'npx', args: ['-y', 'mcp-remote@0.15.2', 'https://mcp.example.com/mcp'] }), true);
  assert.equal(isMcpRemote({ kind: 'stdio', command: 'npx', args: ['mcp-remote', 'https://mcp.example.com/mcp'] }), true);
  assert.equal(isMcpRemote({ kind: 'stdio', command: 'node', args: ['server.js'] }), false);
  assert.equal(isMcpRemote({ kind: 'stdio', command: 'npx', args: ['-y', 'some-server', 'mcp-remote-ish'] }), false);
  assert.equal(isMcpRemote({ kind: 'stdio', command: 'not-mcp-remote', args: [] }), false);
});
