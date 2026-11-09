// `mcp-patchbay import`: build servers.json from a Claude Code config. See SPEC.md §10.
import fs from 'node:fs';
import path from 'node:path';
import { defaultConfigPath, validateConfig } from './config.js';
import { backup, writeAtomic } from './fsutil.js';
import { isValidSegment } from './naming.js';

/**
 * @typedef {{name: string, reason: string}} Skip
 * @typedef {{name: string, policy: string, kind: string}} Imported
 */

/** @param {string} name */
function unhostable(name) {
  if (name.startsWith('claude.ai ')) return 'a claude.ai connector; Claude Code hosts these itself';
  if (name.startsWith('plugin:')) return 'a plugin server; Claude Code manages these itself';
  if (name.startsWith('claude-in-chrome')) return 'claude-in-chrome is built into Claude Code';
  return null;
}

/** @param {any} def */
function isSelf(def) {
  const parts = [def?.command, ...(Array.isArray(def?.args) ? def.args : [])].filter((x) => typeof x === 'string');
  return parts.some((p) => /mcp-patchbay/.test(p));
}

/**
 * Converts one Claude Code server definition. Returns the entry or a reason to skip.
 * @param {string} name
 * @param {any} def
 * @returns {{entry?: any, kind?: string, reason?: string}}
 */
function convert(name, def) {
  const bad = unhostable(name);
  if (bad) return { reason: bad };
  if (!isValidSegment(name)) return { reason: 'name is not valid here (use [A-Za-z0-9_-], no "__", no trailing "_", at most 64)' };
  if (!def || typeof def !== 'object') return { reason: 'definition is not an object' };
  if (isSelf(def)) return { reason: 'this is mcp-patchbay itself' };
  const type = def.type ?? (def.url ? 'http' : 'stdio');
  if (type === 'http' || type === 'sse') {
    if (typeof def.url !== 'string') return { reason: `type ${type} without a url` };
    const entry = { description: `Imported from Claude Code (${type})`, url: def.url };
    if (def.headers && Object.keys(def.headers).length) entry.headers = { ...def.headers };
    return { entry, kind: type };
  }
  if (type === 'stdio') {
    if (typeof def.command !== 'string' || !def.command) return { reason: 'stdio without a command' };
    /** @type {any} */
    const entry = { description: 'Imported from Claude Code (stdio)', command: def.command };
    if (Array.isArray(def.args) && def.args.length) entry.args = [...def.args];
    if (def.env && Object.keys(def.env).length) entry.env = { ...def.env };
    if (typeof def.cwd === 'string') entry.cwd = def.cwd;
    return { entry, kind: 'stdio' };
  }
  return { reason: `transport type "${type}" is not supported` };
}

/**
 * @param {{from: string, project?: string, out: string}} o
 */
export function importClaudeConfig(o) {
  const raw = JSON.parse(fs.readFileSync(o.from, 'utf8'));
  /** @type {Record<string, any>} */
  const defs = { ...(raw.mcpServers ?? {}) };
  /** @type {string[]} */
  let disabled = [];
  if (o.project) {
    const proj = raw.projects && Object.hasOwn(raw.projects, o.project) ? raw.projects[o.project] : undefined;
    if (!proj) throw new Error(`project "${o.project}" not found in ${o.from}`);
    Object.assign(defs, proj.mcpServers ?? {});
    disabled = Array.isArray(proj.disabledMcpServers) ? proj.disabledMcpServers : [];
  }

  /** @type {Record<string, any>} */
  const servers = {};
  /** @type {Skip[]} */
  const skipped = [];
  /** @type {Imported[]} */
  const imported = [];
  for (const [name, def] of Object.entries(defs)) {
    const { entry, kind, reason } = convert(name, def);
    if (!entry) {
      skipped.push({ name, reason: /** @type {string} */ (reason) });
      continue;
    }
    const policy = disabled.includes(name) ? 'confirm' : 'allow';
    const ordered = { description: entry.description, policy, ...entry };
    // Each entry must validate on its own, so one odd server cannot sink the whole import.
    try {
      validateConfig({ version: 1, servers: { [name]: ordered } });
    } catch (e) {
      skipped.push({ name, reason: `not valid here: ${/** @type {Error} */ (e).message}` });
      continue;
    }
    servers[name] = ordered;
    imported.push({ name, policy, kind: /** @type {string} */ (kind) });
  }
  /** @type {any} */
  const config = { version: 1, servers, autostart: { default: [], projects: {} } };
  if (o.project) {
    config.autostart.projects[o.project] = imported.filter((i) => !disabled.includes(i.name)).map((i) => i.name);
  }
  validateConfig(config);
  return { config, imported, skipped };
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function runImport(argv) {
  /** @type {Record<string, string>} */
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (['--from', '--project', '--out'].includes(a)) {
      if (argv[i + 1] === undefined) {
        process.stderr.write(`import: ${a} needs a value\n`);
        return 64;
      }
      flags[a.slice(2)] = argv[++i];
    } else {
      process.stderr.write(`import: unknown argument ${a}\nUsage: mcp-patchbay import --from <claude.json> [--project <dir>] [--out <servers.json>]\n`);
      return 64;
    }
  }
  if (!flags.from) {
    process.stderr.write('import: --from <claude.json> is required (usually ~/.claude.json)\n');
    return 64;
  }
  const out = path.resolve(flags.out ?? defaultConfigPath());
  let result;
  try {
    result = importClaudeConfig({ from: flags.from, project: flags.project, out });
  } catch (e) {
    process.stderr.write(`import: ${/** @type {Error} */ (e).message}\n`);
    return 1;
  }
  const dir = path.dirname(out);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const bak = backup(out, 0o600);
  writeAtomic(out, JSON.stringify(result.config, null, 2) + '\n', 0o600);

  const lines = [];
  lines.push(`Imported ${result.imported.length} server(s):`);
  for (const i of result.imported) lines.push(`  ${i.name} (${i.kind}, policy ${i.policy})`);
  if (result.skipped.length) {
    lines.push(`Skipped ${result.skipped.length}:`);
    for (const s of result.skipped) lines.push(`  ${s.name}: ${s.reason}`);
  }
  if (flags.project) {
    lines.push(`Autostart for ${flags.project}: ${result.config.autostart.projects[flags.project].join(', ') || '(none)'}`);
  }
  if (bak) lines.push(`Backed up the previous file to ${bak}`);
  lines.push(`Wrote ${out} (mode 0600). Env and header values were copied but are not shown.`);
  process.stdout.write(lines.join('\n') + '\n');
  return 0;
}
