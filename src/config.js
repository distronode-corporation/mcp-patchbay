// Config location, strict validation and the permission check. See SPEC.md §2.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isValidSegment } from './naming.js';

export const EX_CONFIG = 78;
export const MAX_TIMEOUT_MS = 2147483647;

export class ConfigError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
    this.exitCode = EX_CONFIG;
  }
}

/**
 * @typedef {'allow'|'confirm'|'deny'} Policy
 * @typedef {{
 *   name: string, segment: string, kind: 'stdio'|'url', description: string, policy: Policy,
 *   command?: string, args: string[], env: Record<string,string>, cwd?: string,
 *   url?: string, headers: Record<string,string>, prefix?: string, timeoutMs: number
 * }} ServerEntry
 * @typedef {{
 *   version: 1, order: string[], servers: Record<string, ServerEntry>,
 *   autostart: {default: string[], projects: Record<string, string[]>},
 *   oauth: {configDir: string, authTimeoutSeconds: number}
 * }} Config
 */

/** @param {string} [home] */
export function defaultConfigPath(home = os.homedir()) {
  return path.join(home, '.config', 'mcp-patchbay', 'servers.json');
}

/**
 * @param {{flag?: string, env?: NodeJS.ProcessEnv}} o
 */
export function resolveConfigPath({ flag, env = process.env }) {
  if (flag) return flag;
  if (env.MCP_PATCHBAY_CONFIG) return env.MCP_PATCHBAY_CONFIG;
  return defaultConfigPath();
}

/** @param {string} p */
export function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const where = (p) => (p ? p : '(root)');

/**
 * @param {Record<string, unknown>} obj
 * @param {string[]} allowed
 * @param {string} at
 */
function onlyKeys(obj, allowed, at) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) {
      throw new ConfigError(`unknown key "${k}" at ${where(at)} (allowed: ${allowed.join(', ')})`);
    }
  }
}

/** @param {unknown} v @param {string} at */
function stringMap(v, at, keyRe, keyWhat) {
  if (!isObj(v)) throw new ConfigError(`${at} must be an object of strings`);
  /** @type {Record<string,string>} */
  const out = {};
  for (const [k, val] of Object.entries(/** @type {object} */ (v))) {
    if (!keyRe.test(k)) throw new ConfigError(`${keyWhat} "${k}" at ${at} is not valid`);
    if (typeof val !== 'string') throw new ConfigError(`${at}.${k} must be a string`);
    out[k] = val;
  }
  return out;
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_KEY = /^[A-Za-z0-9_-]+$/; // mcp-remote 0.15.2 parseHeaderLine
const SERVER_KEYS = ['description', 'policy', 'command', 'args', 'env', 'cwd', 'url', 'headers', 'prefix', 'timeoutMs'];
const POLICIES = ['allow', 'confirm', 'deny'];

/**
 * @param {string} name
 * @param {any} raw
 * @returns {ServerEntry}
 */
function validateServer(name, raw) {
  const at = `servers.${name}`;
  if (!isValidSegment(name)) {
    throw new ConfigError(`server name "${name}" is not valid: use 1-64 of [A-Za-z0-9_-], no "__", and no trailing "_"`);
  }
  if (!isObj(raw)) throw new ConfigError(`${at} must be an object`);
  onlyKeys(raw, SERVER_KEYS, at);
  const hasCommand = raw.command !== undefined;
  const hasUrl = raw.url !== undefined;
  if (hasCommand === hasUrl) throw new ConfigError(`${at} must have exactly one of command or url`);

  const description = raw.description ?? '';
  if (typeof description !== 'string') throw new ConfigError(`${at}.description must be a string`);
  if (/[\r\n]/.test(description)) throw new ConfigError(`${at}.description must be one line`);
  if (description.length > 300) throw new ConfigError(`${at}.description must be at most 300 characters`);

  const policy = raw.policy ?? 'confirm';
  if (!POLICIES.includes(policy)) throw new ConfigError(`${at}.policy must be one of ${POLICIES.join(', ')}`);

  const timeoutMs = raw.timeoutMs ?? 0;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new ConfigError(`${at}.timeoutMs must be an integer from 0 (no cap) to ${MAX_TIMEOUT_MS}`);
  }

  let prefix;
  if (raw.prefix !== undefined) {
    if (!isValidSegment(raw.prefix)) {
      throw new ConfigError(`${at}.prefix "${raw.prefix}" is not valid: use 1-64 of [A-Za-z0-9_-], no "__", and no trailing "_"`);
    }
    prefix = raw.prefix;
  }

  const env = raw.env === undefined ? {} : stringMap(raw.env, `${at}.env`, ENV_KEY, 'env key');

  /** @type {ServerEntry} */
  const entry = {
    name,
    segment: prefix ?? name,
    kind: hasCommand ? 'stdio' : 'url',
    description,
    policy,
    args: [],
    env,
    headers: {},
    timeoutMs,
  };
  if (prefix) entry.prefix = prefix;

  if (hasCommand) {
    if (typeof raw.command !== 'string' || !raw.command) throw new ConfigError(`${at}.command must be a non-empty string`);
    if (raw.headers !== undefined) throw new ConfigError(`${at}.headers applies only to url servers`);
    entry.command = raw.command;
    if (raw.args !== undefined) {
      if (!Array.isArray(raw.args) || !raw.args.every((a) => typeof a === 'string')) {
        throw new ConfigError(`${at}.args must be an array of strings`);
      }
      entry.args = [...raw.args];
    }
    if (raw.cwd !== undefined) {
      if (typeof raw.cwd !== 'string' || !(path.isAbsolute(raw.cwd) || path.win32.isAbsolute(raw.cwd))) {
        throw new ConfigError(`${at}.cwd must be an absolute path`);
      }
      entry.cwd = raw.cwd;
    }
  } else {
    if (raw.args !== undefined) throw new ConfigError(`${at}.args applies only to command servers`);
    if (raw.cwd !== undefined) throw new ConfigError(`${at}.cwd applies only to command servers`);
    if (typeof raw.url !== 'string') throw new ConfigError(`${at}.url must be a string`);
    let u;
    try {
      u = new URL(raw.url);
    } catch {
      throw new ConfigError(`${at}.url must be an absolute http(s) URL`);
    }
    const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (!(u.protocol === 'https:' || (u.protocol === 'http:' && loopback))) {
      throw new ConfigError(`${at}.url must use https (plain http is only allowed for localhost and 127.0.0.1)`);
    }
    entry.url = raw.url;
    if (raw.headers !== undefined) {
      entry.headers = stringMap(raw.headers, `${at}.headers`, HEADER_KEY, 'header name');
      for (const [k, v] of Object.entries(entry.headers)) {
        if (/[\r\n]/.test(v)) throw new ConfigError(`${at}.headers.${k} must not contain line breaks`);
      }
    }
  }
  return entry;
}

/**
 * Validates a parsed config strictly and returns a normalised copy.
 * @param {any} raw
 * @returns {Config}
 */
export function validateConfig(raw) {
  if (!isObj(raw)) throw new ConfigError('the config must be a JSON object');
  onlyKeys(raw, ['version', 'servers', 'autostart', 'oauth'], '');
  if (raw.version !== 1) throw new ConfigError('version must be 1');
  if (raw.servers === undefined) throw new ConfigError('servers is required');
  if (!isObj(raw.servers)) throw new ConfigError('servers must be an object');

  /** @type {Record<string, ServerEntry>} */
  const servers = {};
  const order = [];
  /** @type {Map<string, string>} */
  const segments = new Map();
  for (const [name, entry] of Object.entries(raw.servers)) {
    const s = validateServer(name, entry);
    const key = s.segment.toLowerCase();
    const other = segments.get(key);
    if (other !== undefined) {
      throw new ConfigError(`servers.${name}: tool-name segment "${s.segment}" is already used by server "${other}" (names and prefixes must be unique, ignoring case)`);
    }
    segments.set(key, name);
    servers[name] = s;
    order.push(name);
  }

  const autostart = { default: /** @type {string[]} */ ([]), projects: /** @type {Record<string,string[]>} */ ({}) };
  if (raw.autostart !== undefined) {
    if (!isObj(raw.autostart)) throw new ConfigError('autostart must be an object');
    onlyKeys(raw.autostart, ['default', 'projects'], 'autostart');
    const names = (v, at) => {
      if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new ConfigError(`${at} must be an array of server names`);
      for (const n of v) {
        if (!servers[n]) throw new ConfigError(`${at} names unknown server "${n}"`);
        if (servers[n].policy === 'deny') throw new ConfigError(`${at} names "${n}", whose policy is deny`);
      }
      return [...new Set(v)];
    };
    if (raw.autostart.default !== undefined) autostart.default = names(raw.autostart.default, 'autostart.default');
    if (raw.autostart.projects !== undefined) {
      if (!isObj(raw.autostart.projects)) throw new ConfigError('autostart.projects must be an object');
      for (const [dir, list] of Object.entries(raw.autostart.projects)) {
        if (!(path.isAbsolute(dir) || path.win32.isAbsolute(dir))) {
          throw new ConfigError(`autostart.projects key "${dir}" must be an absolute path`);
        }
        autostart.projects[dir] = names(list, `autostart.projects["${dir}"]`);
      }
    }
  }

  const oauth = { configDir: expandHome('~/.config/mcp-patchbay/oauth'), authTimeoutSeconds: 300 };
  if (raw.oauth !== undefined) {
    if (!isObj(raw.oauth)) throw new ConfigError('oauth must be an object');
    onlyKeys(raw.oauth, ['configDir', 'authTimeoutSeconds'], 'oauth');
    if (raw.oauth.configDir !== undefined) {
      if (typeof raw.oauth.configDir !== 'string' || !raw.oauth.configDir) throw new ConfigError('oauth.configDir must be a path');
      const dir = expandHome(raw.oauth.configDir);
      if (!(path.isAbsolute(dir) || path.win32.isAbsolute(dir))) throw new ConfigError('oauth.configDir must be absolute (or start with ~)');
      oauth.configDir = dir;
    }
    if (raw.oauth.authTimeoutSeconds !== undefined) {
      const t = raw.oauth.authTimeoutSeconds;
      if (!Number.isInteger(t) || t < 1 || t > 86400) throw new ConfigError('oauth.authTimeoutSeconds must be an integer from 1 to 86400');
      oauth.authTimeoutSeconds = t;
    }
  }

  return { version: 1, order, servers, autostart, oauth };
}

/**
 * Refuses a config file that someone else could have rewritten (POSIX only).
 * @param {string} file
 * @param {fs.Stats} st
 */
export function checkFilePermissions(file, st) {
  if (process.platform === 'win32') return;
  if (st.mode & 0o022) {
    throw new ConfigError(
      `refusing to start: ${file} is group- or world-writable (mode ${(st.mode & 0o777).toString(8)}). ` +
      `The config decides which programs run, so only you may be able to change it. Fix it with: chmod 600 ${file}`,
    );
  }
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid && st.uid !== 0) {
    throw new ConfigError(`refusing to start: ${file} is owned by uid ${st.uid}, not by you (uid ${uid}) or root.`);
  }
}

/**
 * Reads, checks and validates the config file once.
 * @param {string} file
 * @returns {Config}
 */
export function loadConfig(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch (e) {
    throw new ConfigError(`cannot read config ${file}: ${/** @type {any} */ (e).code ?? e}. Create it (see examples/servers.json) or pass --config <path>.`);
  }
  if (!st.isFile()) throw new ConfigError(`config ${file} is not a regular file`);
  checkFilePermissions(file, st);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new ConfigError(`cannot read config ${file}: ${/** @type {any} */ (e).code ?? e}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`config ${file} is not valid JSON: ${/** @type {Error} */ (e).message}`);
  }
  try {
    return validateConfig(raw);
  } catch (e) {
    if (e instanceof ConfigError) e.message = `config ${file}: ${e.message}`;
    throw e;
  }
}

/** @param {string} p */
function normDir(p) {
  let r = path.resolve(p);
  if (process.platform === 'win32') r = r.toLowerCase();
  return r;
}

/**
 * The servers to autostart for a project directory.
 * @param {Config} config
 * @param {string} projectDir
 */
export function autostartFor(config, projectDir) {
  const want = normDir(projectDir);
  for (const [dir, list] of Object.entries(config.autostart.projects)) {
    if (normDir(dir) === want) return [...list];
  }
  return [...config.autostart.default];
}
