// Child MCP servers: a custom stdio transport, spawn specs for stdio and remote (mcp-remote)
// children, and the per-child SDK Client. See SPEC.md §7 and §8.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  CallToolResultSchema,
  ElicitRequestSchema,
  ElicitationCompleteNotificationSchema,
  ErrorCode,
  JSONRPCMessageSchema,
  ListRootsRequestSchema,
  McpError,
  ProgressNotificationSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod';
import { killTree, pidAlive, SHUTDOWN_KILL_DELAY_MS } from './process.js';
import { redact, RingBuffer, secretsFor } from './redact.js';
import { VERSION } from './version.js';

const IS_WINDOWS = process.platform === 'win32';
export const AUTH_MARKER = 'Please authorize this client by visiting:';
const URL_RE = /https?:\/\/[^\s'"<>]+/;
const MAX_LINE = 64 * 1024 * 1024;
const NOISE_LINE_MAX = 500;
const KILL_GRACE_MS = 2000;
/** Largest delay setTimeout accepts; used as "no cap". */
export const NO_CAP_MS = 2147483647;

/**
 * Loose tools/list result: we validate each tool separately (naming.mapTools) and keep the
 * original objects, so unknown keys pass through.
 */
const LooseListToolsResultSchema = z.object({
  tools: z.array(z.looseObject({})),
  nextCursor: z.string().optional(),
}).loose();

const RUNNERS = new Set(['npx', 'pnpx', 'bunx', 'pnpm', 'yarn', 'bun']);
const MCP_REMOTE_ARG = /^mcp-remote(?:@[^\s/]*)?$/;

/**
 * Is this entry mcp-remote? Only then is its stderr watched for the sign-in line. True for `url`
 * entries, for a command whose basename is mcp-remote, and for a package runner (npx, pnpx,
 * bunx, pnpm, yarn, bun) with an `mcp-remote` or `mcp-remote@<version>` argument.
 * @param {{kind: string, command?: string, args?: string[]}} entry
 */
export function isMcpRemote(entry) {
  if (entry.kind === 'url') return true;
  if (typeof entry.command !== 'string') return false;
  const base = path.basename(entry.command.replace(/\\/g, '/')).replace(/\.(?:cmd|exe|bat|ps1|js|mjs|cjs)$/i, '').toLowerCase();
  if (base === 'mcp-remote') return true;
  return RUNNERS.has(base) && (entry.args ?? []).some((a) => MCP_REMOTE_ARG.test(a));
}

/** Resolves mcp-remote's bin without npx. */
export function mcpRemoteBin(env = process.env) {
  if (env.MCP_PATCHBAY_MCP_REMOTE_BIN) return env.MCP_PATCHBAY_MCP_REMOTE_BIN;
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve('mcp-remote/package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin['mcp-remote'];
  return path.join(path.dirname(pkgPath), bin);
}

/**
 * How to spawn a child. stdio: as configured. url: node <mcp-remote> <url> --auth-timeout N
 * --header K:${MCP_PATCHBAY_HEADER_i}, with the header values in the env, not in argv.
 * @param {import('./config.js').ServerEntry} entry
 * @param {{configDir: string, authTimeoutSeconds: number}} oauth
 * @param {NodeJS.ProcessEnv} [baseEnv]
 * @returns {{command: string, args: string[], env: Record<string,string>, cwd?: string}}
 */
export function spawnSpec(entry, oauth, baseEnv = process.env) {
  /** @type {Record<string,string>} */
  const env = { .../** @type {Record<string,string>} */ (baseEnv), ...entry.env };
  if (entry.kind === 'stdio') {
    return { command: /** @type {string} */ (entry.command), args: [...entry.args], env, cwd: entry.cwd };
  }
  const args = [mcpRemoteBin(baseEnv), /** @type {string} */ (entry.url), '--auth-timeout', String(oauth.authTimeoutSeconds)];
  let i = 0;
  for (const [k, v] of Object.entries(entry.headers)) {
    if (v.includes('${')) {
      args.push('--header', `${k}:${v}`);
    } else {
      const ref = `MCP_PATCHBAY_HEADER_${i++}`;
      env[ref] = v;
      args.push('--header', `${k}:\${${ref}}`);
    }
  }
  env.MCP_REMOTE_CONFIG_DIR = oauth.configDir;
  return { command: process.execPath, args, env };
}

/**
 * MCP over a child's stdio. Unlike the SDK's StdioClientTransport it passes the full env,
 * detaches the child into its own process group on POSIX, tolerates non-JSON stdout lines and
 * keeps redacted stderr in a ring buffer.
 */
export class ChildProcessTransport {
  /**
   * @param {object} o
   * @param {string} o.command
   * @param {string[]} o.args
   * @param {Record<string,string>} o.env
   * @param {string} [o.cwd]
   * @param {string[]} o.secrets
   * @param {(raw: string) => void} [o.onStderrLine]
   * @param {(pid: number) => void} [o.onSpawn]
   * @param {(info: {code: number|null, signal: string|null}) => void} [o.onExit]
   */
  constructor(o) {
    this.o = o;
    this.stderr = new RingBuffer(20);
    this.noise = new RingBuffer(20);
    /** @type {import('node:child_process').ChildProcess | null} */
    this.proc = null;
    this.pid = 0;
    this.exited = false;
    this.closing = false;
    /** @type {{code: number|null, signal: string|null} | null} */
    this.exitInfo = null;
    this.outBuf = '';
    this.errBuf = '';
    this.closed = false;
    /** @type {((m: any) => void) | undefined} */ this.onmessage = undefined;
    /** @type {((e: Error) => void) | undefined} */ this.onerror = undefined;
    /** @type {(() => void) | undefined} */ this.onclose = undefined;
    /** @type {Promise<void>} */
    this.exitPromise = new Promise((r) => { this.resolveExit = r; });
  }

  async start() {
    const o = this.o;
    await new Promise((resolve, reject) => {
      let proc;
      try {
        proc = spawn(o.command, o.args, {
          cwd: o.cwd,
          env: o.env,
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false,
          windowsHide: true,
          detached: !IS_WINDOWS,
        });
      } catch (e) {
        reject(e);
        return;
      }
      this.proc = proc;
      let spawned = false;
      proc.once('spawn', () => {
        spawned = true;
        this.pid = /** @type {number} */ (proc.pid);
        o.onSpawn?.(this.pid);
        resolve(undefined);
      });
      proc.on('error', (err) => {
        if (!spawned) {
          this.exited = true;
          this.resolveExit?.();
          reject(err);
          this.#finish();
        } else {
          this.onerror?.(err);
        }
      });
      proc.on('exit', (code, signal) => {
        this.exited = true;
        this.exitInfo = { code, signal };
        // Grandchildren may keep the pipes open; give stdout a moment to drain, then finish.
        const t = setTimeout(() => this.#finish(), 200);
        t.unref?.();
        o.onExit?.(this.exitInfo);
        this.resolveExit?.();
      });
      proc.on('close', () => this.#finish());
      proc.stdout?.setEncoding('utf8');
      proc.stdout?.on('data', (chunk) => this.#onStdout(chunk));
      proc.stdout?.on('error', () => {});
      proc.stderr?.setEncoding('utf8');
      proc.stderr?.on('data', (chunk) => this.#onStderr(chunk));
      proc.stderr?.on('error', () => {});
      proc.stdin?.on('error', (err) => {
        // EPIPE after the child died: report, never throw.
        this.onerror?.(new Error(`stdin: ${/** @type {any} */ (err).code ?? err.message}`));
      });
    });
  }

  #finish() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }

  /** @param {string} chunk */
  #onStdout(chunk) {
    this.outBuf += chunk;
    if (this.outBuf.length > MAX_LINE && !this.outBuf.includes('\n')) {
      this.noise.push(`[discarded ${this.outBuf.length} bytes without a newline]`);
      this.outBuf = '';
      return;
    }
    let i;
    while ((i = this.outBuf.indexOf('\n')) !== -1) {
      const line = this.outBuf.slice(0, i).replace(/\r$/, '');
      this.outBuf = this.outBuf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        msg = undefined;
      }
      if (msg !== undefined && JSONRPCMessageSchema.safeParse(msg).success) {
        try {
          this.onmessage?.(msg);
        } catch (e) {
          this.onerror?.(/** @type {Error} */ (e));
        }
      } else {
        this.noise.push(redact(line, this.o.secrets).slice(0, NOISE_LINE_MAX));
      }
    }
  }

  /** @param {string} chunk */
  #onStderr(chunk) {
    this.errBuf += chunk;
    if (this.errBuf.length > 1024 * 1024 && !this.errBuf.includes('\n')) this.errBuf = this.errBuf.slice(-4096);
    let i;
    while ((i = this.errBuf.indexOf('\n')) !== -1) {
      const raw = this.errBuf.slice(0, i).replace(/\r$/, '');
      this.errBuf = this.errBuf.slice(i + 1);
      this.o.onStderrLine?.(raw);
      if (raw.trim()) this.stderr.push(redact(raw, this.o.secrets).slice(0, NOISE_LINE_MAX));
    }
  }

  /** @param {any} message */
  send(message) {
    return new Promise((resolve, reject) => {
      const stdin = this.proc?.stdin;
      if (!stdin || this.exited || !stdin.writable) {
        reject(new Error('child is not running'));
        return;
      }
      stdin.write(JSON.stringify(message) + '\n', (err) => (err ? reject(err) : resolve(undefined)));
    });
  }

  /** Graceful: close stdin, SIGTERM the group, SIGKILL after a grace period. */
  async close() {
    this.closing = true;
    if (this.proc && !this.exited) {
      try { this.proc.stdin?.end(); } catch { /* ignore */ }
      killTree(this.pid, 'SIGTERM');
      const t = setTimeout(() => { if (!this.exited) killTree(this.pid, 'SIGKILL'); }, KILL_GRACE_MS);
      t.unref?.();
      await Promise.race([this.exitPromise, new Promise((r) => setTimeout(r, KILL_GRACE_MS + 500).unref?.())]);
      clearTimeout(t);
    }
    // If the leader had already exited, onExit already signalled what was left of its group;
    // signalling again could hit an unrelated group once the id is free for reuse.
    this.#finish();
  }

  /**
   * Synchronous SIGTERM for shutdown.
   * @returns {number} the pid that was signalled and has not been seen to exit, or 0
   */
  killNow() {
    this.closing = true;
    if (this.pid && !this.exited && killTree(this.pid, 'SIGTERM')) return this.pid;
    return 0;
  }
}

/**
 * One running child: process, transport and SDK Client.
 * Events: 'auth-url' (url), 'exit' ({code, signal, expected}), 'tools-changed'.
 */
export class Child extends EventEmitter {
  /**
   * @param {object} o
   * @param {import('./config.js').ServerEntry} o.entry
   * @param {{configDir: string, authTimeoutSeconds: number}} o.oauth
   * @param {any} o.clientCapabilities capabilities the patchbay's own client declared
   * @param {import('./log.js').Logger} o.log
   * @param {import('./process.js').PidFiles | null} [o.pidFiles]
   * @param {NodeJS.ProcessEnv} [o.env]
   * @param {{roots?: (params: any, extra: any) => Promise<any>, elicit?: (params: any, extra: any) => Promise<any>, elicitationComplete?: (params: any) => void}} [o.handlers]
   */
  constructor(o) {
    super();
    this.o = o;
    this.entry = o.entry;
    this.secrets = secretsFor(o.entry);
    this.expectedExit = false;
    /** @type {string | undefined} */
    this.instructions = undefined;
    this.pendingUrlLines = 0;
    /** @type {ChildProcessTransport | null} */
    this.transport = null;
    /** @type {Client | null} */
    this.client = null;
    /** Progress callbacks of calls in flight, by the progress token sent to the child. */
    /** @type {Map<string, (p: any) => void>} */
    this.progress = new Map();
    this.progressSeq = 0;
  }

  get pid() {
    return this.transport?.pid ?? 0;
  }

  /** @param {string} raw */
  #watchAuth(raw) {
    if (this.pendingUrlLines > 0) {
      const m = URL_RE.exec(raw);
      if (m) {
        this.pendingUrlLines = 0;
        this.emit('auth-url', m[0]);
        return;
      }
      if (raw.trim()) this.pendingUrlLines--;
    }
    const at = raw.indexOf(AUTH_MARKER);
    if (at !== -1) {
      const m = URL_RE.exec(raw.slice(at + AUTH_MARKER.length));
      if (m) this.emit('auth-url', m[0]);
      else this.pendingUrlLines = 3;
    }
  }

  /** Capabilities we declare to the child: only what the patchbay's client declared. */
  childCapabilities() {
    const c = this.o.clientCapabilities ?? {};
    /** @type {any} */
    const caps = {};
    if (c.roots) caps.roots = { listChanged: true };
    if (c.elicitation) caps.elicitation = JSON.parse(JSON.stringify(c.elicitation));
    return caps;
  }

  /**
   * Spawns and initializes the child.
   * @param {number} timeoutMs initialize timeout
   */
  async start(timeoutMs) {
    const { entry, oauth, log } = this.o;
    if (entry.kind === 'url') {
      fs.mkdirSync(oauth.configDir, { recursive: true, mode: 0o700 });
      if (!IS_WINDOWS) fs.chmodSync(oauth.configDir, 0o700);
    }
    const spec = spawnSpec(entry, oauth, this.o.env ?? process.env);
    if (spec.cwd && !fs.statSync(spec.cwd, { throwIfNoEntry: false })?.isDirectory()) {
      // spawn would report this as ENOENT, which reads like "command not found".
      throw new Error('the configured cwd does not exist or is not a directory');
    }
    // Any other child printing a sign-in line must not get a patchbay sign-in prompt.
    const watchAuth = isMcpRemote(entry);
    const transport = new ChildProcessTransport({
      ...spec,
      secrets: this.secrets,
      onStderrLine: (raw) => {
        if (watchAuth) this.#watchAuth(raw);
        log.debug(`[${entry.name}] ${raw}`, this.secrets);
      },
      onSpawn: (pid) => this.o.pidFiles?.record(pid),
      onExit: (info) => {
        const pid = this.transport?.pid;
        if (pid) {
          // Take down whatever is left of the group (never a bare pid: ours is gone), then
          // SIGKILL what ignored that. The leader has exited, so the group id stays reserved
          // while members remain; if a process with that pid exists by then, it is a new one
          // and its group is left alone.
          if (killTree(pid, 'SIGTERM', { bare: false })) {
            const t = setTimeout(() => { if (!pidAlive(pid)) killTree(pid, 'SIGKILL', { bare: false }); }, SHUTDOWN_KILL_DELAY_MS);
            t.unref?.();
          }
          this.o.pidFiles?.remove(pid);
        }
        this.emit('exit', { ...info, expected: this.expectedExit || transport.closing });
      },
    });
    this.transport = transport;

    const client = new Client({ name: 'mcp-patchbay', version: VERSION }, { capabilities: this.childCapabilities() });
    this.client = client;
    const caps = this.o.clientCapabilities ?? {};
    const h = this.o.handlers ?? {};
    if (caps.roots && h.roots) {
      client.setRequestHandler(ListRootsRequestSchema, (req, extra) => /** @type {any} */ (h.roots)(req.params, extra));
    }
    if (caps.elicitation && h.elicit) {
      client.setRequestHandler(ElicitRequestSchema, (req, extra) => /** @type {any} */ (h.elicit)(req.params, extra));
    }
    client.fallbackRequestHandler = async (request) => {
      switch (request.method) {
        case 'sampling/createMessage':
          throw new McpError(ErrorCode.MethodNotFound, 'mcp-patchbay does not forward sampling/createMessage; sampling is not available to hosted servers');
        case 'roots/list':
          throw new McpError(ErrorCode.MethodNotFound, "roots/list is not available: the patchbay's client did not declare the roots capability");
        case 'elicitation/create':
          throw new McpError(ErrorCode.MethodNotFound, "elicitation/create is not available: the patchbay's client did not declare the elicitation capability");
        default:
          throw new McpError(ErrorCode.MethodNotFound, `Method not found: ${request.method}`);
      }
    };
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => { this.emit('tools-changed'); });
    client.setNotificationHandler(ElicitationCompleteNotificationSchema, (n) => { h.elicitationComplete?.(n.params); });
    // Progress is matched here, not by the SDK's `onprogress`: the SDK runs a notification
    // handler a microtask late but handles a response at once, dropping its progress handler,
    // so a last progress notification read in the same chunk as the response was lost.
    client.setNotificationHandler(ProgressNotificationSchema, (n) => {
      const { progressToken, ...p } = n.params;
      this.progress.get(String(progressToken))?.(p);
    });
    client.onerror = (err) => log.debug(`[${entry.name}] client error: ${err.message}`, this.secrets);

    await client.connect(transport, { timeout: timeoutMs });
    this.instructions = client.getInstructions();
  }

  /**
   * Lists all tools, following nextCursor.
   * @param {number} [timeoutMs]
   * @returns {Promise<Array<Record<string, any>>>}
   */
  async listTools(timeoutMs = 60000) {
    const client = /** @type {Client} */ (this.client);
    const tools = [];
    /** @type {string | undefined} */
    let cursor;
    for (let page = 0; page < 1000; page++) {
      const r = await client.request(
        { method: 'tools/list', params: cursor ? { cursor } : {} },
        LooseListToolsResultSchema,
        { timeout: timeoutMs },
      );
      tools.push(...r.tools);
      if (!r.nextCursor || r.nextCursor === cursor) break;
      cursor = r.nextCursor;
    }
    return tools;
  }

  /**
   * Forwards tools/call. Raw request, so outputSchema is not enforced (unlike callTool).
   * @param {any} params
   * @param {{signal?: AbortSignal, timeout: number, onprogress?: (p: any) => void}} opts
   */
  async call(params, opts) {
    const client = /** @type {Client} */ (this.client);
    const { onprogress, ...rest } = opts;
    if (!onprogress) return client.request({ method: 'tools/call', params }, CallToolResultSchema, rest);
    const token = `patchbay-${++this.progressSeq}`;
    this.progress.set(token, onprogress);
    try {
      const withToken = { ...params, _meta: { ...params._meta, progressToken: token } };
      return await client.request({ method: 'tools/call', params: withToken }, CallToolResultSchema, rest);
    } finally {
      // A progress notification read with the response is dispatched before this runs.
      this.progress.delete(token);
    }
  }

  async rootsListChanged() {
    try {
      await this.client?.sendRootsListChanged();
    } catch (e) {
      this.o.log.debug(`[${this.entry.name}] roots list_changed not sent: ${/** @type {Error} */ (e).message}`);
    }
  }

  stderrTail(n = 5) {
    return this.transport?.stderr.lines(n) ?? [];
  }

  noiseTail(n = 20) {
    return this.transport?.noise.lines(n) ?? [];
  }

  /** Graceful stop. */
  async close() {
    this.expectedExit = true;
    const t = this.transport;
    if (!t) return;
    await t.close();
    // Keep the pidfile of a child that has not been seen to exit, so the reaper can finish it.
    if (t.pid && t.exited) this.o.pidFiles?.remove(t.pid);
    try { await this.client?.close(); } catch { /* already closed */ }
  }

  /**
   * Synchronous stop for shutdown.
   * @returns {number} the pid still to be confirmed gone, or 0
   */
  killNow() {
    this.expectedExit = true;
    return this.transport?.killNow() ?? 0;
  }
}
