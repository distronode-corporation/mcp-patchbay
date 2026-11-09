// `mcp-patchbay rename-permissions`: add mcp__patchbay__ twins of existing MCP permission rules.
// Never removes or reorders a rule. See SPEC.md §10.
import fs from 'node:fs';
import { ConfigError, EX_CONFIG, jsonSyntaxMessage, loadConfig, resolveConfigPath } from './config.js';
import { backup, writeAtomic } from './fsutil.js';
import { CLIENT_PREFIX, MAX_CLIENT_NAME, isValidSegment } from './naming.js';

const LISTS = ['allow', 'ask', 'deny'];

/** @param {string} rule @returns {string | null} reason to skip, or null */
function unproxyable(rule) {
  if (rule.includes('(')) return 'has a parenthesised specifier';
  if (rule.startsWith('mcp__claude-in-chrome__') || rule === 'mcp__claude-in-chrome') return 'claude-in-chrome is built into Claude Code';
  if (rule.startsWith('mcp__plugin_')) return 'plugin servers are managed by Claude Code';
  if (rule.startsWith('mcp__claude_ai_')) return 'claude.ai connectors are hosted by Claude Code';
  if (rule === 'mcp__patchbay' || rule.startsWith(CLIENT_PREFIX)) return 'already a patchbay rule';
  return null;
}

/**
 * @param {any} settings parsed settings.json
 * @param {{segmentFor?: (server: string) => string}} [o]
 * @returns {{additions: Record<string, string[]>, skipped: Array<{list: string, rule: string, reason: string}>}}
 */
export function computeAdditions(settings, o = {}) {
  const segmentFor = o.segmentFor ?? ((s) => s);
  /** @type {Record<string, string[]>} */
  const additions = { allow: [], ask: [], deny: [] };
  const skipped = [];
  const perms = settings?.permissions ?? {};
  for (const list of LISTS) {
    const rules = Array.isArray(perms[list]) ? perms[list] : [];
    const have = new Set(rules);
    for (const rule of rules) {
      if (typeof rule !== 'string' || !rule.startsWith('mcp__')) continue;
      const why = unproxyable(rule);
      if (why) {
        skipped.push({ list, rule, reason: why });
        continue;
      }
      const rest = rule.slice('mcp__'.length);
      const i = rest.indexOf('__');
      const server = i === -1 ? rest : rest.slice(0, i);
      const tool = i === -1 ? '*' : rest.slice(i + 2);
      if (!isValidSegment(server) || !tool) {
        skipped.push({ list, rule, reason: 'server name cannot be hosted by the patchbay' });
        continue;
      }
      const twin = `${CLIENT_PREFIX}${segmentFor(server)}__${tool}`;
      if (twin.length > MAX_CLIENT_NAME) {
        skipped.push({ list, rule, reason: `the patchbay name would exceed ${MAX_CLIENT_NAME} characters` });
        continue;
      }
      if (have.has(twin)) continue;
      have.add(twin);
      additions[list].push(twin);
    }
  }
  return { additions, skipped };
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function runRenamePermissions(argv) {
  let file;
  let write = false;
  let configPath;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write') write = true;
    else if (a === '--config') configPath = argv[++i];
    else if (!a.startsWith('--') && !file) file = a;
    else {
      process.stderr.write(`rename-permissions: unknown argument ${a}\n`);
      return 64;
    }
  }
  if (!file) {
    process.stderr.write('Usage: mcp-patchbay rename-permissions <settings.json> [--write] [--config <servers.json>]\n');
    return 64;
  }
  /** @type {(s: string) => string} */
  let segmentFor = (s) => s;
  // Without --config, use the config the patchbay itself would load: its prefixes decide the
  // real tool names, and a deny rule with the wrong segment would silently stop matching.
  const explicit = Boolean(configPath);
  const cfgPath = configPath ?? resolveConfigPath({});
  if (!explicit && !fs.existsSync(cfgPath)) {
    process.stderr.write(
      `rename-permissions: warning: no patchbay config at ${cfgPath}, so server prefixes are unknown. ` +
      'Names were mapped as-is (mcp__<server>__… → mcp__patchbay__<server>__…). If any server has a ' +
      '"prefix", these rules will not match its tools; pass --config <servers.json>.\n',
    );
  } else {
    try {
      const cfg = loadConfig(cfgPath);
      segmentFor = (s) => (Object.hasOwn(cfg.servers, s) ? cfg.servers[s].segment : s);
    } catch (e) {
      if (e instanceof ConfigError) {
        process.stderr.write(`rename-permissions: ${e.message}${explicit ? '' : ' (pass --config <servers.json> to use another file)'}\n`);
        return EX_CONFIG;
      }
      throw e;
    }
  }
  let text;
  let settings;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    process.stderr.write(`rename-permissions: cannot read ${file}: ${/** @type {any} */ (e).code ?? /** @type {Error} */ (e).message}\n`);
    return 1;
  }
  try {
    settings = JSON.parse(text);
  } catch {
    // Never the parser's message: it quotes the text around the error (settings can hold env).
    process.stderr.write(`rename-permissions: ${jsonSyntaxMessage(file, text)}\n`);
    return 1;
  }
  const { additions, skipped } = computeAdditions(settings, { segmentFor });
  const total = LISTS.reduce((n, l) => n + additions[l].length, 0);
  const lines = [];
  for (const list of LISTS) for (const r of additions[list]) lines.push(`+ permissions.${list}: ${r}`);
  for (const s of skipped) lines.push(`  skipped permissions.${s.list}: ${s.rule} (${s.reason})`);
  if (!total) {
    lines.push('Nothing to add: every proxyable MCP rule already has its patchbay twin.');
    process.stdout.write(lines.join('\n') + '\n');
    return 0;
  }
  if (!write) {
    lines.push(`Dry run: ${total} rule(s) would be added. Run again with --write to apply (a backup is made first).`);
    process.stdout.write(lines.join('\n') + '\n');
    return 0;
  }
  settings.permissions ??= {};
  for (const list of LISTS) {
    if (!additions[list].length) continue;
    if (!Array.isArray(settings.permissions[list])) settings.permissions[list] = [];
    settings.permissions[list].push(...additions[list]);
  }
  const mode = fs.statSync(file).mode & 0o777;
  const bak = backup(file);
  const indent = /^\{\n(\s+)/.exec(text)?.[1] ?? '  ';
  writeAtomic(file, JSON.stringify(settings, null, indent) + (text.endsWith('\n') ? '\n' : ''), mode);
  lines.push(`Added ${total} rule(s) to ${file}. Backup: ${bak}`);
  process.stdout.write(lines.join('\n') + '\n');
  return 0;
}
