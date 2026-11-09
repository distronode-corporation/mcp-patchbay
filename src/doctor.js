// `mcp-patchbay doctor`: validate the config and briefly start servers. See SPEC.md §10.
import { Child } from './children.js';
import { ConfigError, EX_CONFIG, loadConfig, resolveConfigPath } from './config.js';
import { createLogger } from './log.js';
import { PidFiles, pidDirFor } from './process.js';
import { redact } from './redact.js';

const STDIO_BUDGET_MS = 60000;

/**
 * @param {string[]} argv
 * @param {{out?: (s: string) => void, err?: (s: string) => void}} [io]
 * @returns {Promise<number>} exit code
 */
export async function runDoctor(argv, io = {}) {
  const out = io.out ?? ((s) => process.stdout.write(s));
  const err = io.err ?? ((s) => process.stderr.write(s));
  let configFlag;
  let all = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--all') all = true;
    else if (argv[i] === '--config') configFlag = argv[++i];
    else if (argv[i].startsWith('--config=')) configFlag = argv[i].slice(9);
    else {
      err(`doctor: unknown argument ${argv[i]}\n`);
      return 64;
    }
  }
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
  return failed ? 1 : 0;
}
