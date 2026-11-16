#!/usr/bin/env node
// Starts an unpacked bundle the way its manifest says, with a fresh, empty home directory, and
// checks the zero-config first run end to end over stdio: initialize, the tool list, `servers`
// returning no servers, and the starter config written at the default path.
//
// The variables are substituted as the MCPB manifest spec describes: `${HOME}` in a user_config
// default, then `${__dirname}`, `${/}` and `${user_config.KEY}` in mcp_config. It talks raw
// JSON-RPC, so it uses nothing but the bundle's own files and node.
//
// Usage: node bundle/smoke.mjs <unpacked bundle dir>
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = path.resolve(process.argv[2] ?? '');
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'patchbay-smoke-'));
const TIMEOUT_MS = 60_000;

// Declared before anything can call fail(), which reads all three.
let done = false;
let stderr = '';
/** @type {import('node:child_process').ChildProcess | undefined} */
let child;

const sub = (s, vars) => s.replace(/\$\{([^}]+)\}/g, (m, k) => (k in vars ? vars[k] : m));
const vars = { __dirname: dir, HOME: home, '/': path.sep, pathSeparator: path.sep };
for (const [key, opt] of Object.entries(manifest.user_config ?? {})) {
  if (opt.default !== undefined) vars[`user_config.${key}`] = sub(String(opt.default), vars);
}
const cfg = manifest.server.mcp_config;
const command = cfg.command === 'node' ? process.execPath : cfg.command;
const args = cfg.args.map((a) => sub(a, vars));
const leftover = args.find((a) => /\$\{/.test(a));
if (leftover) fail(`an argument was not substituted: ${leftover}`);

const runtime = path.join(home, 'runtime');
fs.mkdirSync(runtime, { mode: 0o700 });
const env = { ...process.env, ...(cfg.env ?? {}), HOME: home, USERPROFILE: home, XDG_RUNTIME_DIR: runtime };
delete env.MCP_PATCHBAY_CONFIG;

process.stdout.write(`starting: ${path.basename(command)} ${args.join(' ')}\n`);
child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.on('data', (d) => { stderr += d; });
child.on('exit', (code, sig) => { if (!done) fail(`the server exited early (${code ?? sig})`); });
const timer = setTimeout(() => fail(`no answer in ${TIMEOUT_MS / 1000} s`), TIMEOUT_MS);

let buf = '';
const waiting = new Map();
child.stdout.on('data', (d) => {
  buf += d;
  for (let nl; (nl = buf.indexOf('\n')) !== -1;) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    // Anything on stdout that is not JSON-RPC would corrupt a real client's stream.
    try { msg = JSON.parse(line); } catch { fail(`non-JSON output on stdout: ${line.slice(0, 200)}`); }
    if (msg.id !== undefined && waiting.has(msg.id)) {
      waiting.get(msg.id)(msg);
      waiting.delete(msg.id);
    }
  }
});
let nextId = 1;
const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
const request = (method, params) => new Promise((resolve) => {
  const id = nextId++;
  waiting.set(id, resolve);
  send({ jsonrpc: '2.0', id, method, params });
});

function fail(why) {
  done = true;
  process.stderr.write(`smoke: FAILED: ${why}\n--- server stderr ---\n${stderr}\n`);
  child?.kill();
  fs.rmSync(home, { recursive: true, force: true });
  process.exit(1);
}

const init = await request('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'mcpb-smoke', version: '1.0.0' },
});
if (init.error) fail(`initialize: ${JSON.stringify(init.error)}`);
if (init.result.serverInfo?.version !== manifest.version) {
  fail(`serverInfo.version is ${init.result.serverInfo?.version}, the manifest says ${manifest.version}`);
}
send({ jsonrpc: '2.0', method: 'notifications/initialized' });

const list = await request('tools/list', {});
const names = (list.result?.tools ?? []).map((t) => t.name);
for (const t of manifest.tools) if (!names.includes(t.name)) fail(`tool ${t.name} is missing from tools/list (${names.join(', ')})`);

const call = await request('tools/call', { name: 'servers', arguments: {} });
const servers = JSON.parse(call.result?.content?.[0]?.text ?? '{}').servers;
if (!Array.isArray(servers) || servers.length !== 0) fail(`servers returned ${call.result?.content?.[0]?.text}`);

const file = path.join(home, '.config', 'mcp-patchbay', 'servers.json');
const written = JSON.parse(fs.readFileSync(file, 'utf8'));
if (JSON.stringify(written) !== JSON.stringify({ version: 1, servers: {} })) fail(`the starter config is ${JSON.stringify(written)}`);
if (process.platform !== 'win32') {
  const mode = fs.statSync(file).mode & 0o777;
  if (mode !== 0o600) fail(`the starter config's mode is ${mode.toString(8)}`);
}
if (!/created a starter config/.test(stderr)) fail('no "created a starter config" line on stderr');

done = true;
clearTimeout(timer);
child.stdin.end();
child.kill();
fs.rmSync(home, { recursive: true, force: true });
process.stdout.write(`smoke: ok on ${process.platform} (node ${process.versions.node}): ${names.join(', ')}; starter config created\n`);
