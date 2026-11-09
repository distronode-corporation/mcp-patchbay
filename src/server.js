// The patchbay: an MCP server whose tools are its own five plus those of the children that are
// switched on. See SPEC.md §3-§5 and §8.
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ElicitResultSchema,
  ErrorCode,
  InitializeRequestSchema,
  ListToolsRequestSchema,
  McpError,
  RootsListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Child, NO_CAP_MS } from './children.js';
import { autostartFor } from './config.js';
import { buildInstructions, truncate } from './instructions.js';
import { mapTools, splitExposed } from './naming.js';
import { redact } from './redact.js';
import { VERSION } from './version.js';

export const LIST_WAIT_MS = 2000;
export const AUTOSTART_WAIT_MS = 15000;
const STDIO_START_TIMEOUT_MS = 120000;
const REMOTE_START_GRACE_MS = 60000;
const CLIENT_READY_WAIT_MS = 30000;
const ENABLE_INSTRUCTIONS_MAX = 2000;
const SAMPLE_TOOLS = 10;
const ALWAYS_LOAD = { 'anthropic/alwaysLoad': true };

/**
 * @typedef {'off'|'starting'|'waiting-for-sign-in'|'on'|'failed'} State
 * @typedef {{
 *   name: string, entry: import('./config.js').ServerEntry, state: State,
 *   child: Child | null, lastChild?: Child, published: import('./naming.js').Published[],
 *   skipped: import('./naming.js').Skipped[], lastError?: string, exitError?: string,
 *   inFlight: number, startPromise: Promise<{ok: boolean, error?: string}> | null,
 *   confirmPromise: Promise<{ok: boolean, message?: string}> | null,
 *   authUrls: Set<string>, urlElicitationId?: string, startAbort?: AbortController,
 *   relisting: boolean, relistAgain: boolean, lastNotify?: Promise<boolean>
 * }} Slot
 */

/** @param {unknown} data */
const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
/** @param {string} message @param {Record<string, unknown>} [extra] */
const fail = (message, extra = {}) => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ error: message, ...extra }, null, 2) }] });

export class Patchbay {
  /**
   * @param {import('./config.js').Config} config
   * @param {object} o
   * @param {import('./log.js').Logger} o.log
   * @param {import('./process.js').PidFiles | null} [o.pidFiles]
   * @param {NodeJS.ProcessEnv} [o.env]
   * @param {string} [o.projectDir]
   */
  constructor(config, o) {
    this.config = config;
    this.log = o.log;
    this.pidFiles = o.pidFiles ?? null;
    this.env = o.env ?? process.env;
    this.projectDir = o.projectDir ?? this.env.CLAUDE_PROJECT_DIR ?? process.cwd();
    /** @type {Map<string, Slot>} */
    this.slots = new Map();
    /** @type {Map<string, Slot>} */
    this.bySegment = new Map();
    for (const name of config.order) {
      const entry = config.servers[name];
      /** @type {Slot} */
      const slot = {
        name, entry, state: 'off', child: null, published: [], skipped: [], inFlight: 0,
        startPromise: null, confirmPromise: null, authUrls: new Set(), relisting: false, relistAgain: false,
      };
      this.slots.set(name, slot);
      this.bySegment.set(entry.segment, slot);
    }
    /** @type {Map<string, {slot: Slot, original: string, child: Child}>} */
    this.routes = new Map();
    /** @type {Set<() => void>} */
    this.listWaiters = new Set();
    /** @type {string[]} */
    this.autostarted = [];
    this.initialized = false;
    this.closed = false;
    /** @type {() => void} */
    let markReady = () => {};
    this.clientReady = new Promise((r) => { markReady = r; });
    this.markReady = markReady;

    this.server = new Server({ name: 'mcp-patchbay', version: VERSION }, { capabilities: { tools: { listChanged: true } } });
    this.server.onerror = (e) => this.log.debug(`protocol: ${e.message}`);
    this.server.oninitialized = () => {
      this.initialized = true;
      this.markReady();
    };
    this.#registerHandlers();
  }

  /** The client's capabilities as recorded at initialize. */
  get clientCaps() {
    return this.server.getClientCapabilities() ?? {};
  }

  canElicitForm() {
    return Boolean(this.clientCaps.elicitation?.form);
  }

  async whenClientReady() {
    if (this.initialized) return true;
    let t;
    const r = await Promise.race([
      this.clientReady.then(() => true),
      new Promise((res) => { t = setTimeout(() => res(false), CLIENT_READY_WAIT_MS); }),
    ]);
    clearTimeout(t);
    return r;
  }

  /** @param {import('@modelcontextprotocol/sdk/shared/transport.js').Transport} transport */
  async connect(transport) {
    await this.server.connect(transport);
  }

  #registerHandlers() {
    const s = this.server;
    s.setRequestHandler(InitializeRequestSchema, async (request) => {
      // Let the SDK record the client's capabilities and negotiate the version, then autostart
      // (children's capabilities depend on the client's) and attach our instructions.
      const result = await /** @type {any} */ (s)._oninitialize(request);
      await this.autostart(AUTOSTART_WAIT_MS);
      result.instructions = this.instructionsText();
      return result;
    });
    s.setRequestHandler(ListToolsRequestSchema, async () => {
      const waiters = [...this.listWaiters];
      this.listWaiters.clear();
      // Resolve after this response has been written, so enable's answer follows it.
      if (waiters.length) setImmediate(() => { for (const w of waiters) w(); });
      return { tools: [...this.ownTools(), ...this.publishedTools()] };
    });
    s.setRequestHandler(CallToolRequestSchema, (request, extra) => this.#onCall(request, extra));
    s.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
      for (const slot of this.slots.values()) {
        if (slot.state === 'on' && slot.child) await slot.child.rootsListChanged();
      }
    });
  }

  ownTools() {
    const names = this.config.order;
    /** @param {string} what */
    const nameInput = (what) => ({
      type: 'object',
      properties: { name: { type: 'string', description: what, ...(names.length ? { enum: names } : {}) } },
      required: ['name'],
      additionalProperties: false,
    });
    return [
      {
        name: 'servers',
        title: 'List hosted MCP servers',
        description: 'Lists every MCP server the patchbay can host: name, description, policy (allow, confirm, deny), state (off, starting, on, failed, waiting-for-sign-in), tool count when on, and which ones can be enabled.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, openWorldHint: false },
        _meta: ALWAYS_LOAD,
      },
      {
        name: 'enable',
        title: 'Turn on a hosted MCP server',
        description: 'Starts a hosted MCP server and adds its tools, named <server>__<tool>. Servers with policy confirm ask a person first; deny servers cannot be enabled. Returns the tool count, sample tool names and the server\'s instructions.',
        inputSchema: nameInput('Server name, as listed by servers'),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: ALWAYS_LOAD,
      },
      {
        name: 'disable',
        title: 'Turn off a hosted MCP server',
        description: 'Stops a hosted MCP server and removes its tools. Refused while it still has calls in flight.',
        inputSchema: nameInput('Server name'),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: ALWAYS_LOAD,
      },
      {
        name: 'restart',
        title: 'Restart a hosted MCP server',
        description: 'Stops and starts a hosted MCP server. No new confirmation if it is already on; otherwise behaves like enable.',
        inputSchema: nameInput('Server name'),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        _meta: ALWAYS_LOAD,
      },
      {
        name: 'info',
        title: 'Details of a hosted MCP server',
        description: 'Shows a hosted server\'s description, policy, state, recent (redacted) stderr and, when on, its full instructions.',
        inputSchema: nameInput('Server name'),
        annotations: { readOnlyHint: true, openWorldHint: false },
        _meta: ALWAYS_LOAD,
      },
    ];
  }

  publishedTools() {
    const out = [];
    for (const name of this.config.order) {
      const slot = /** @type {Slot} */ (this.slots.get(name));
      if (slot.state === 'on') for (const p of slot.published) out.push(p.tool);
    }
    return out;
  }

  #rebuildRoutes() {
    this.routes.clear();
    for (const slot of this.slots.values()) {
      if (slot.state !== 'on' || !slot.child) continue;
      for (const p of slot.published) this.routes.set(p.exposed, { slot, original: p.original, child: slot.child });
    }
  }

  /**
   * @param {Slot} slot
   * @param {Array<Record<string, any>>} tools
   */
  #publish(slot, tools) {
    const { published, skipped } = mapTools(slot.entry.segment, tools);
    slot.published = published;
    slot.skipped = skipped;
    this.#rebuildRoutes();
  }

  /** @param {Slot} slot */
  #unpublish(slot) {
    slot.published = [];
    this.#rebuildRoutes();
  }

  /**
   * Sends tools/list_changed (once the client is initialized) and resolves when the client next
   * asks for tools/list, or after LIST_WAIT_MS.
   * @returns {Promise<boolean>}
   */
  notifyToolsChanged() {
    if (!this.initialized || this.closed) return Promise.resolve(false);
    const seen = new Promise((resolve) => {
      const done = () => { clearTimeout(t); resolve(true); };
      const t = setTimeout(() => { this.listWaiters.delete(done); resolve(false); }, LIST_WAIT_MS);
      this.listWaiters.add(done);
    });
    this.server.sendToolListChanged().catch((e) => this.log.debug(`list_changed not sent: ${e.message}`));
    return /** @type {Promise<boolean>} */ (seen);
  }

  // ---- own tools -------------------------------------------------------------------------

  /**
   * @param {any} request
   * @param {any} extra
   */
  async #onCall(request, extra) {
    const name = request.params.name;
    const args = request.params.arguments ?? {};
    switch (name) {
      case 'servers': return this.toolServers();
      case 'enable': return this.toolEnable(args.name, extra);
      case 'disable': return this.toolDisable(args.name);
      case 'restart': return this.toolRestart(args.name, extra);
      case 'info': return this.toolInfo(args.name);
      default: return this.#forward(request, extra);
    }
  }

  /** @param {unknown} name */
  #slotOrError(name) {
    if (typeof name !== 'string' || !name) return { error: fail('name is required; call servers for the list') };
    const slot = this.slots.get(name);
    if (!slot) return { error: fail(`unknown server "${redact(name).slice(0, 80)}"; call servers for the list`) };
    return { slot };
  }

  /** @param {Slot} slot */
  #whyNot(slot) {
    if (slot.entry.policy === 'deny') return 'policy is deny';
    if (slot.state === 'on') return 'already on';
    if (slot.state === 'starting' || slot.state === 'waiting-for-sign-in') return `already ${slot.state}`;
    if (slot.entry.policy === 'confirm' && !this.canElicitForm()) {
      return "needs a person's approval, but this client cannot ask (no elicitation support); a person must add it to autostart or set policy: allow";
    }
    return undefined;
  }

  toolServers() {
    const servers = [];
    const canEnable = [];
    for (const slot of this.slots.values()) {
      const whyNot = this.#whyNot(slot);
      /** @type {Record<string, unknown>} */
      const s = { name: slot.name, description: slot.entry.description, policy: slot.entry.policy, state: slot.state };
      if (slot.state === 'on') {
        s.toolCount = slot.published.length;
        if (slot.skipped.length) s.skippedTools = slot.skipped;
      }
      if (slot.state === 'failed' && slot.lastError) s.lastError = slot.lastError;
      s.canEnable = !whyNot;
      if (whyNot) s.whyNot = whyNot;
      else canEnable.push(slot.name);
      servers.push(s);
    }
    return ok({ servers, canEnable, usage: 'enable {name} turns a server on; disable {name} turns it off. Tools appear as <server>__<tool>.' });
  }

  /** @param {Slot} slot @param {string} [message] */
  #summary(slot, message) {
    /** @type {Record<string, unknown>} */
    const out = { name: slot.name, state: slot.state };
    if (message) out.message = message;
    out.toolCount = slot.published.length;
    out.sampleTools = slot.published.slice(0, SAMPLE_TOOLS).map((p) => p.exposed);
    if (slot.skipped.length) out.skippedTools = slot.skipped;
    const instr = slot.child?.instructions;
    if (instr) out.instructions = truncate(instr, ENABLE_INSTRUCTIONS_MAX);
    return out;
  }

  /**
   * @param {unknown} name
   * @param {any} extra
   * @param {{skipConfirm?: boolean}} [o]
   */
  async toolEnable(name, extra, o = {}) {
    const { slot, error } = this.#slotOrError(name);
    if (!slot) return error;
    if (slot.entry.policy === 'deny') return fail(`${slot.name} is denied by policy`);
    if (slot.state === 'on') return ok(this.#summary(slot, 'already on'));
    if (!slot.startPromise && slot.entry.policy === 'confirm' && !o.skipConfirm) {
      const c = await this.#confirm(slot, extra);
      if (!c.ok) return fail(/** @type {string} */ (c.message));
    }
    if (slot.state === 'on') return ok(this.#summary(slot, 'already on'));
    const r = await (slot.startPromise ?? this.startSlot(slot));
    if (!r.ok) return fail(`${slot.name} failed to start: ${r.error}`, { name: slot.name, state: slot.state });
    if (slot.lastNotify) await slot.lastNotify;
    return ok(this.#summary(slot));
  }

  /**
   * Asks the person, through form elicitation, whether the agent may turn the server on.
   * Fails closed in every case but an explicit accept with allow === true.
   * @param {Slot} slot
   * @param {any} extra
   * @returns {Promise<{ok: boolean, message?: string}>}
   */
  #confirm(slot, extra) {
    if (!this.canElicitForm()) {
      return Promise.resolve({
        ok: false,
        message: `${slot.name} needs a person's approval, but this client cannot ask (no elicitation support). A person must add it to autostart in the patchbay config, or set policy: allow.`,
      });
    }
    if (slot.confirmPromise) return slot.confirmPromise;
    const desc = slot.entry.description ? ` (${slot.entry.description})` : '';
    const p = (async () => {
      try {
        const r = await this.server.elicitInput({
          mode: 'form',
          message: `Allow the agent to turn on ${slot.name}${desc}?`,
          requestedSchema: {
            type: 'object',
            properties: { allow: { type: 'boolean', title: 'Allow', description: `Turn on ${slot.name} for this session` } },
            required: ['allow'],
          },
        }, { signal: extra?.signal, timeout: NO_CAP_MS });
        if (r.action === 'accept' && r.content?.allow === true) return { ok: true };
        this.log.info(`${slot.name}: the person did not approve (${r.action})`);
        return { ok: false, message: `${slot.name} was not approved by the person (${r.action === 'accept' ? 'allow was not ticked' : r.action}).` };
      } catch (e) {
        return { ok: false, message: `${slot.name} was not approved: the confirmation failed (${redact(/** @type {Error} */ (e).message)}).` };
      }
    })();
    slot.confirmPromise = p;
    p.finally(() => { if (slot.confirmPromise === p) slot.confirmPromise = null; });
    return p;
  }

  /** @param {unknown} name */
  async toolDisable(name) {
    const { slot, error } = this.#slotOrError(name);
    if (!slot) return error;
    if (slot.state === 'off') return ok({ name: slot.name, state: 'off', message: 'already off' });
    if (slot.state === 'failed') {
      slot.state = 'off';
      slot.lastError = undefined;
      return ok({ name: slot.name, state: 'off', message: 'was failed; reset to off' });
    }
    if (slot.inFlight > 0) {
      return fail(`${slot.name} has ${slot.inFlight} call(s) in flight; try again when they finish`, { name: slot.name, inFlight: slot.inFlight });
    }
    const wasOn = slot.state === 'on';
    await this.#stop(slot);
    if (wasOn) this.notifyToolsChanged();
    this.log.info(`${slot.name}: disabled`);
    return ok({ name: slot.name, state: 'off' });
  }

  /** @param {unknown} name @param {any} extra */
  async toolRestart(name, extra) {
    const { slot, error } = this.#slotOrError(name);
    if (!slot) return error;
    if (slot.entry.policy === 'deny') return fail(`${slot.name} is denied by policy`);
    if (slot.state === 'starting' || slot.state === 'waiting-for-sign-in') {
      return fail(`${slot.name} is ${slot.state}; wait for it, or disable it first`);
    }
    if (slot.state !== 'on') return this.toolEnable(name, extra);
    if (slot.inFlight > 0) {
      return fail(`${slot.name} has ${slot.inFlight} call(s) in flight; try again when they finish`, { name: slot.name, inFlight: slot.inFlight });
    }
    await this.#stop(slot);
    this.log.info(`${slot.name}: restarting`);
    return this.toolEnable(name, extra, { skipConfirm: true });
  }

  /** @param {unknown} name */
  toolInfo(name) {
    const { slot, error } = this.#slotOrError(name);
    if (!slot) return error;
    /** @type {Record<string, unknown>} */
    const out = {
      name: slot.name,
      description: slot.entry.description,
      policy: slot.entry.policy,
      kind: slot.entry.kind,
      state: slot.state,
      inFlight: slot.inFlight,
    };
    if (slot.state === 'on') {
      out.toolCount = slot.published.length;
      out.tools = slot.published.map((p) => p.exposed);
    }
    if (slot.skipped.length) out.skippedTools = slot.skipped;
    if (slot.lastError) out.lastError = slot.lastError;
    const child = slot.child ?? slot.lastChild;
    if (child) {
      out.stderrTail = child.stderrTail(5);
      const noise = child.noiseTail(20);
      if (noise.length) out.stdoutNoise = noise;
    }
    if (slot.state === 'on' && slot.child?.instructions) out.instructions = slot.child.instructions;
    return ok(out);
  }

  // ---- lifecycle of one child ------------------------------------------------------------

  /**
   * Starts a child (no policy checks here: callers have done them) and publishes its tools.
   * @param {Slot} slot
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  startSlot(slot) {
    if (slot.startPromise) return slot.startPromise;
    const entry = slot.entry;
    slot.state = 'starting';
    slot.lastError = undefined;
    slot.exitError = undefined;
    slot.authUrls = new Set();
    slot.urlElicitationId = undefined;
    slot.startAbort = new AbortController();
    slot.lastNotify = undefined;
    const child = new Child({
      entry,
      oauth: this.config.oauth,
      clientCapabilities: this.clientCaps,
      log: this.log,
      pidFiles: this.pidFiles,
      env: this.env,
      handlers: this.#childHandlers(slot),
    });
    slot.child = child;
    slot.lastChild = child;
    child.on('auth-url', (url) => this.#onAuthUrl(slot, child, url));
    child.on('exit', (info) => this.#onChildExit(slot, child, info));
    child.on('tools-changed', () => { void this.#relist(slot, child); });

    const timeout = entry.kind === 'url'
      ? this.config.oauth.authTimeoutSeconds * 1000 + REMOTE_START_GRACE_MS
      : STDIO_START_TIMEOUT_MS;

    const p = (async () => {
      try {
        await child.start(timeout);
        if (slot.child !== child) throw new Error('stopped');
        const tools = await child.listTools();
        if (slot.child !== child) throw new Error('stopped');
        slot.state = 'on';
        this.#publish(slot, tools);
        this.log.info(`${slot.name}: on, ${slot.published.length} tools${slot.skipped.length ? `, ${slot.skipped.length} skipped` : ''}`);
        if (slot.urlElicitationId && this.clientCaps.elicitation?.url) {
          this.server.notification({ method: 'notifications/elicitation/complete', params: { elicitationId: slot.urlElicitationId } })
            .catch((e) => this.log.debug(`elicitation/complete not sent: ${e.message}`));
        }
        slot.lastNotify = this.notifyToolsChanged();
        return { ok: true };
      } catch (e) {
        if (slot.child === child) {
          const msg = slot.exitError ?? this.#describeStartError(slot, child, e, timeout);
          slot.state = 'failed';
          slot.lastError = msg;
          slot.child = null;
          this.#unpublish(slot);
          this.log.warn(`${slot.name}: failed to start: ${msg}`);
          await child.close().catch(() => {});
          return { ok: false, error: msg };
        }
        return { ok: false, error: slot.lastError ?? 'disabled while starting' };
      } finally {
        slot.startAbort?.abort('start finished');
        slot.startPromise = null;
      }
    })();
    slot.startPromise = p;
    return p;
  }

  /**
   * @param {Slot} slot
   * @param {Child} child
   * @param {unknown} e
   * @param {number} timeout
   */
  #describeStartError(slot, child, e, timeout) {
    const err = /** @type {any} */ (e);
    let msg;
    if (err?.code === 'ENOENT') msg = `could not start ${slot.entry.kind === 'url' ? 'mcp-remote' : 'the command'}: not found (ENOENT)`;
    else if (typeof err?.code === 'string') msg = `could not start: ${err.code}`;
    else if (err instanceof McpError && err.code === ErrorCode.RequestTimeout) msg = `did not finish starting within ${Math.round(timeout / 1000)} s`;
    else if (err instanceof McpError && err.code === ErrorCode.ConnectionClosed) msg = 'exited during startup';
    else msg = String(err?.message ?? err).replace(/^MCP error -?\d+: /, '');
    const last = child.stderrTail(1)[0];
    if (last) msg += `; last stderr: ${last}`;
    return redact(msg, child.secrets);
  }

  /**
   * @param {Slot} slot
   * @param {Child} child
   * @param {{code: number|null, signal: string|null, expected: boolean}} info
   */
  #onChildExit(slot, child, info) {
    if (info.expected || slot.child !== child) return;
    let msg = info.signal ? `exited on signal ${info.signal}` : `exited with code ${info.code}`;
    // Give the last stderr lines a moment to arrive before quoting them.
    const finish = () => {
      const last = child.stderrTail(1)[0];
      const full = redact(last ? `${msg}; last stderr: ${last}` : msg, child.secrets);
      if (slot.state === 'on') {
        slot.state = 'failed';
        slot.lastError = full;
        slot.child = null;
        this.#unpublish(slot);
        this.log.warn(`${slot.name}: ${full}`);
        this.notifyToolsChanged();
      } else {
        slot.exitError = full;
      }
    };
    if (slot.state === 'on') setTimeout(finish, 20);
    else finish();
  }

  /** @param {Slot} slot */
  async #stop(slot) {
    const child = slot.child;
    slot.child = null;
    slot.state = 'off';
    slot.lastError = undefined;
    this.#unpublish(slot);
    if (child) await child.close().catch(() => {});
  }

  /**
   * @param {Slot} slot
   * @param {Child} child
   */
  async #relist(slot, child) {
    if (slot.child !== child || slot.state !== 'on') return;
    if (slot.relisting) {
      slot.relistAgain = true;
      return;
    }
    slot.relisting = true;
    try {
      do {
        slot.relistAgain = false;
        const tools = await child.listTools();
        if (slot.child !== child || slot.state !== 'on') return;
        this.#publish(slot, tools);
        this.notifyToolsChanged();
      } while (slot.relistAgain);
    } catch (e) {
      this.log.warn(`${slot.name}: re-listing tools failed: ${/** @type {Error} */ (e).message}`, child.secrets);
    } finally {
      slot.relisting = false;
    }
  }

  /** Handlers for requests a child sends to us. @param {Slot} slot */
  #childHandlers(slot) {
    return {
      roots: async (params, extra) => {
        await this.whenClientReady();
        return this.server.listRoots(params, { signal: extra.signal });
      },
      elicit: async (params, extra) => {
        await this.whenClientReady();
        const forwarded = { ...params, message: `[${slot.name}] ${params.message}` };
        return this.server.request({ method: 'elicitation/create', params: forwarded }, ElicitResultSchema, { signal: extra.signal, timeout: NO_CAP_MS });
      },
      elicitationComplete: (params) => {
        if (!this.clientCaps.elicitation?.url) return;
        this.server.notification({ method: 'notifications/elicitation/complete', params })
          .catch((e) => this.log.debug(`elicitation/complete not forwarded: ${e.message}`));
      },
    };
  }

  /**
   * mcp-remote printed a sign-in URL. Tell the person, through the client.
   * @param {Slot} slot
   * @param {Child} child
   * @param {string} url
   */
  #onAuthUrl(slot, child, url) {
    if (slot.child !== child || slot.authUrls.has(url)) return;
    slot.authUrls.add(url);
    if (slot.state === 'starting') slot.state = 'waiting-for-sign-in';
    this.log.info(`${slot.name}: waiting for sign-in (${redact(url)})`);
    void this.#askSignIn(slot, child, url);
  }

  /**
   * @param {Slot} slot
   * @param {Child} child
   * @param {string} url  sent unredacted, to the person only
   */
  async #askSignIn(slot, child, url) {
    await this.whenClientReady();
    if (slot.child !== child) return;
    const caps = this.clientCaps.elicitation;
    const message = `Sign in to ${slot.name} to finish turning it on.`;
    const signal = slot.state === 'on' ? undefined : slot.startAbort?.signal;
    try {
      let r;
      if (caps?.url) {
        const elicitationId = randomUUID();
        slot.urlElicitationId = elicitationId;
        r = await this.server.elicitInput({ mode: 'url', message, url, elicitationId }, { signal, timeout: NO_CAP_MS });
      } else if (caps?.form) {
        r = await this.server.elicitInput({
          mode: 'form',
          message: `${message} Open this link in your browser: ${url}`,
          requestedSchema: { type: 'object', properties: { done: { type: 'boolean', title: 'I have signed in' } } },
        }, { signal, timeout: NO_CAP_MS });
      } else {
        this.log.warn(`${slot.name} needs a sign-in, but the client cannot show a link (no elicitation support); mcp-remote tries to open a browser itself`);
        return;
      }
      if (r.action !== 'accept' && slot.child === child && slot.state !== 'on') {
        this.log.info(`${slot.name}: sign-in declined (${r.action})`);
        slot.lastError = 'sign-in declined';
        slot.state = 'failed';
        slot.child = null;
        this.#unpublish(slot);
        await child.close().catch(() => {});
      }
    } catch (e) {
      if (slot.child === child) this.log.debug(`${slot.name}: sign-in elicitation ended: ${/** @type {Error} */ (e).message}`);
    }
  }

  // ---- proxying ---------------------------------------------------------------------------

  /**
   * @param {any} request
   * @param {any} extra
   */
  async #forward(request, extra) {
    const name = request.params.name;
    const route = this.routes.get(name);
    if (!route) {
      const split = splitExposed(name);
      const slot = split ? this.bySegment.get(split.segment) : undefined;
      if (slot) return fail(`${slot.name} is not enabled; call enable with {"name": "${slot.name}"} first`, { state: slot.state });
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${redact(name).slice(0, 200)}`);
    }
    const { slot, original, child } = route;
    const params = { ...request.params, name: original };
    const token = request.params._meta?.progressToken;
    /** @type {{signal?: AbortSignal, timeout: number, onprogress?: (p: any) => void}} */
    const opts = { signal: extra.signal, timeout: slot.entry.timeoutMs || NO_CAP_MS };
    if (token !== undefined) {
      opts.onprogress = (p) => {
        extra.sendNotification({ method: 'notifications/progress', params: { ...p, progressToken: token } })
          .catch((e) => this.log.debug(`progress not forwarded: ${e.message}`));
      };
    }
    slot.inFlight++;
    try {
      return await child.call(params, opts);
    } catch (e) {
      if (e instanceof McpError) {
        if (e.code === ErrorCode.ConnectionClosed || child.transport?.exited) {
          throw new McpError(ErrorCode.ConnectionClosed, `${slot.name} exited during the call`);
        }
        throw new McpError(e.code, redact(e.message.replace(/^MCP error -?\d+: /, ''), child.secrets), e.data);
      }
      if (child.transport?.exited) throw new McpError(ErrorCode.ConnectionClosed, `${slot.name} exited during the call`);
      throw new McpError(ErrorCode.InternalError, redact(/** @type {Error} */ (e)?.message ?? String(e), child.secrets));
    } finally {
      slot.inFlight--;
    }
  }

  // ---- autostart, instructions, shutdown -------------------------------------------------

  /** @param {number} waitMs */
  async autostart(waitMs) {
    const names = autostartFor(this.config, this.projectDir).filter((n) => this.slots.get(n)?.entry.policy !== 'deny');
    this.autostarted = names;
    if (!names.length) return;
    this.log.info(`autostart: ${names.join(', ')}`);
    const all = Promise.allSettled(names.map((n) => this.startSlot(/** @type {Slot} */ (this.slots.get(n)))));
    let t;
    await Promise.race([all, new Promise((r) => { t = setTimeout(r, waitMs); })]);
    clearTimeout(t);
  }

  instructionsText() {
    const servers = [...this.slots.values()].map((s) => ({ name: s.name, description: s.entry.description, policy: s.entry.policy, state: s.state }));
    const autostarted = this.autostarted
      .map((n) => /** @type {Slot} */ (this.slots.get(n)))
      .filter((s) => s.state === 'on' && s.child?.instructions)
      .map((s) => ({ name: s.name, instructions: /** @type {string} */ (s.child?.instructions) }));
    return buildInstructions(servers, autostarted);
  }

  /** Synchronous: signal every child's process group. Used on SIGINT/SIGTERM/stdin end. */
  shutdownSync() {
    this.closed = true;
    for (const slot of this.slots.values()) {
      try { slot.child?.killNow(); } catch { /* keep going */ }
    }
    this.pidFiles?.removeAllSync();
  }
}
