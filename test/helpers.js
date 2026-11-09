// Shared helpers for the mcp-patchbay test suite.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  CallToolResultSchema,
  ElicitRequestSchema,
  ListRootsRequestSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');
export const CLI = path.join(ROOT, 'src', 'cli.js');
export const FAKE = path.join(here, 'fixtures', 'fake-server.js');
export const IS_WINDOWS = process.platform === 'win32';
export const POSIX_ONLY = IS_WINDOWS ? 'POSIX-only: relies on process groups and signals' : false;
export const WINDOWS_ONLY = IS_WINDOWS ? false : 'Windows-only behaviour';

const tmpdirs = new Set();
process.on('exit', () => {
  for (const dir of tmpdirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/** Creates a fresh temporary directory that is removed when the process exits. */
export function tmpdir(prefix = 'patchbay-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpdirs.add(dir);
  return dir;
}

/**
 * A config entry that runs the fake server.
 * @param {{tools?: string, policy?: string, env?: Record<string,string>, description?: string, prefix?: string, timeoutMs?: number, name?: string}} [o]
 */
export function fake(o = {}) {
  /** @type {any} */
  const entry = {
    description: o.description ?? `Fake server ${o.name ?? ''}`.trim(),
    policy: o.policy ?? 'allow',
    command: process.execPath,
    args: [FAKE],
    env: { FAKE_TOOLS: o.tools ?? 'echo', ...(o.name ? { FAKE_NAME: o.name } : {}), ...(o.env ?? {}) },
  };
  if (o.prefix) entry.prefix = o.prefix;
  if (o.timeoutMs !== undefined) entry.timeoutMs = o.timeoutMs;
  return entry;
}

/** Writes a config file at mode 0600 and returns its path. */
export function writeConfig(dir, config, file = 'servers.json') {
  const p = path.join(dir, file);
  fs.writeFileSync(p, JSON.stringify(config, null, 2), { mode: 0o600 });
  if (!IS_WINDOWS) fs.chmodSync(p, 0o600);
  return p;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls `fn` until it returns a truthy value, or throws after `timeout` ms. */
export async function waitFor(fn, timeout = 5000, interval = 10) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`waitFor timed out after ${timeout} ms`);
    await sleep(interval);
  }
}

/** Is `pid` a live, non-zombie process? */
export function isAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch (e) {
    return /** @type {any} */ (e).code === 'EPERM';
  }
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
      if (state === 'Z' || state === 'X') return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Starts the patchbay over stdio with a scripted test client.
 * @param {object} o
 * @param {any} o.config
 * @param {Record<string,string>} [o.env]
 * @param {any} [o.capabilities]  client capabilities (default: elicitation form+url, roots)
 * @param {(params: any) => any} [o.onElicit]
 * @param {Array<{uri: string, name?: string}>} [o.roots]
 * @param {boolean} [o.autoRelist]  re-list tools on list_changed (default true)
 * @param {string[]} [o.extraArgs]
 * @param {string} [o.cwd]
 * @param {string} [o.runtime]  XDG_RUNTIME_DIR for pidfiles (default: a fresh temp dir)
 */
export async function startPatchbay(o) {
  const dir = tmpdir();
  const cfg = writeConfig(dir, o.config);
  const runtime = o.runtime ?? path.join(dir, 'runtime');
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const capabilities = o.capabilities ?? { elicitation: { form: {}, url: {} }, roots: { listChanged: true } };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, '--config', cfg, ...(o.extraArgs ?? [])],
    env: { ...process.env, XDG_RUNTIME_DIR: runtime, ...(o.env ?? {}) },
    stderr: 'pipe',
    cwd: o.cwd ?? ROOT,
  });
  let stderr = '';
  transport.stderr?.on('data', (d) => { stderr += d.toString(); });
  const client = new Client({ name: 'patchbay-test-client', version: '1.0.0' }, { capabilities });
  const elicitations = [];
  // count: list_changed notifications seen; requested: re-lists started; lists: re-lists done
  const listChanged = { count: 0, requested: 0, lists: 0 };
  if (capabilities.elicitation) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      elicitations.push(req.params);
      if (o.onElicit) return o.onElicit(req.params);
      return { action: 'decline' };
    });
  }
  if (capabilities.roots) {
    client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: o.roots ?? [{ uri: 'file:///path/to/project', name: 'project' }] }));
  }
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    listChanged.count++;
    if (o.autoRelist !== false) {
      listChanged.requested++;
      await client.listTools();
      listChanged.lists++;
    }
  });
  await client.connect(transport);

  const api = {
    client,
    transport,
    dir,
    runtime,
    configPath: cfg,
    pid: /** @type {number} */ (transport.pid),
    elicitations,
    listChanged,
    stderr: () => stderr,
    /** Raw tools/call; returns the result exactly as the SDK parsed it. */
    async call(name, args = {}, opts = {}) {
      return client.request({ method: 'tools/call', params: { name, arguments: args } }, CallToolResultSchema, opts);
    },
    /** Calls one of the patchbay's own tools and parses its JSON text. */
    async own(name, args = {}, opts = {}) {
      const r = await api.call(name, args, opts);
      const text = r.content?.[0]?.text ?? '';
      let data;
      try { data = JSON.parse(text); } catch { data = text; }
      return { isError: r.isError === true, data, text, raw: r };
    },
    async toolNames() {
      const r = await client.listTools();
      return r.tools.map((t) => t.name);
    },
    async state(name) {
      const r = await api.own('servers');
      return r.data.servers.find((s) => s.name === name);
    },
    async close() {
      try { await client.close(); } catch { /* ignore */ }
    },
  };
  return api;
}
