// `mcp-patchbay doctor`: validate the config, check Claude Code's allow rules against
// enable_confirm, and briefly start servers. See SPEC.md §10.
import path from 'node:path';
import { Child } from './children.js';
import { ConfigError, EX_CONFIG, loadConfig, resolveConfigPath } from './config.js';
import { createLogger } from './log.js';
import { ENABLE_CONFIRM_CLIENT_NAME, scanSettings, settingsFiles } from './permissions.js';
import { PidFiles, pidDirFor } from './process.js';
import { redact } from './redact.js';

const STDIO_BUDGET_MS = 60000;

/**
 * Prints what in Claude Code's settings would approve enable_confirm without asking the person.
 * @param {import('./config.js').Config} config
 * @param {string | undefined} project
 * @param {(s: string) => void} out
 * @returns {number} how many findings would weaken a confirm (counted only with confirmVia "host")
 */
function checkPermissions(config, project, out) {
  const host = config.confirmVia === 'host';
  out(`confirmVia: ${config.confirmVia}${host ? ` (confirm servers are turned on with ${ENABLE_CONFIRM_CLIENT_NAME}, approved in the host's permission prompt)` : ''}\n`);
  let findings = 0;
  const label = host ? 'warning' : 'note';
  const why = host
    ? 'the host would run it without asking, so a confirm server would start with no person approving'
    : 'harmless while confirmVia is elicitation, but it would approve enable_confirm without asking if you switch to host';
  for (const r of scanSettings(settingsFiles({ project }))) {
    if (r.status === 'missing') {
      out(`permissions: ${r.file}: not found\n`);
      continue;
    }
    if (r.status === 'unreadable') {
      out(`permissions: ${r.file}: ${r.error}; not checked\n`);
      if (host) findings++;
      continue;
    }
    if (!r.rules.length && !r.bypass) {
      out(`permissions: ${r.file}: ok, no allow rule matches ${ENABLE_CONFIRM_CLIENT_NAME}\n`);
      continue;
    }
    for (const rule of r.rules) {
      out(`permissions: ${label}: ${r.file}: allow rule "${rule}" matches ${ENABLE_CONFIRM_CLIENT_NAME}; ${why}. Remove it, or allow individual tools instead.\n`);
    }
    if (r.bypass) {
      out(`permissions: ${label}: ${r.file}: permissions.defaultMode is bypassPermissions, which approves every tool, ${ENABLE_CONFIRM_CLIENT_NAME} included, without asking.\n`);
    }
    if (host) findings += r.rules.length + (r.bypass ? 1 : 0);
  }
  return findings;
}

/**
 * @param {string[]} argv
 * @param {{out?: (s: string) => void, err?: (s: string) => void}} [io]
 * @returns {Promise<number>} exit code
 */
export async function runDoctor(argv, io = {}) {
  const out = io.out ?? ((s) => process.stdout.write(s));
  const err = io.err ?? ((s) => process.stderr.write(s));
  let configFlag;
  let project;
  let all = false;
  let start = true;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--all') all = true;
    else if (argv[i] === '--no-start') start = false;
    else if (argv[i] === '--config' && argv[i + 1] !== undefined) configFlag = argv[++i];
    else if (argv[i].startsWith('--config=')) configFlag = argv[i].slice(9);
    else if (argv[i] === '--project' && argv[i + 1] !== undefined) project = argv[++i];
    else if (argv[i].startsWith('--project=')) project = argv[i].slice(10);
    else {
      err(`doctor: unknown argument ${argv[i]}\n`);
      return 64;
    }
  }
  if (project !== undefined) project = path.resolve(project);
  const configPath = resolveConfigPath({ flag: configFlag });
  let config;
  try {
    config = loadConfig(configPath);
  } catch (e) {
    if (e instanceof ConfigError) {
      err(`mcp-patchbay doctor: ${e.message}\n`);
      return EX_CONFIG;
    }
    throw e;
  }
  out(`config ok: ${configPath} (${config.order.length} servers)\n`);
  const findings = checkPermissions(config, project, out);
  if (!start) return findings ? 1 : 0;

  // Child chatter goes to stderr only with MCP_PATCHBAY_DEBUG=1.
  const log = createLogger({ write: (s) => err(s) });
  const pidFiles = new PidFiles(pidDirFor(process.env), log);
  let failed = 0;
  for (const name of config.order) {
    const entry = config.servers[name];
    if (entry.policy === 'deny') {
      out(`${name}: skipped (policy deny)\n`);
      continue;
    }
    if (entry.policy === 'confirm' && !all) {
      out(`${name}: skipped (policy confirm; use --all)\n`);
      continue;
    }
    const child = new Child({ entry, oauth: config.oauth, clientCapabilities: {}, log, pidFiles });
    child.on('auth-url', () => err(`${name}: needs a sign-in; mcp-remote should open your browser (waiting up to ${config.oauth.authTimeoutSeconds} s)\n`));
    const budget = entry.kind === 'url' ? config.oauth.authTimeoutSeconds * 1000 + 60000 : STDIO_BUDGET_MS;
    try {
      await child.start(budget);
      const tools = await child.listTools(budget);
      out(`${name}: ok, ${tools.length} tool${tools.length === 1 ? '' : 's'}\n`);
    } catch (e) {
      failed++;
      const last = child.stderrTail(1)[0];
      const why = String(/** @type {any} */ (e)?.code === 'ENOENT' ? 'command not found (ENOENT)' : /** @type {Error} */ (e)?.message ?? e).replace(/^MCP error -?\d+: /, '');
      out(`${name}: failed: ${redact(last ? `${why}; first stderr: ${child.stderrTail(20)[0]}` : why, child.secrets)}\n`);
    } finally {
      await child.close().catch(() => {});
    }
  }
  return failed || findings ? 1 : 0;
}
