#!/usr/bin/env node
// mcp-patchbay command line. With no subcommand it serves MCP over stdio.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigError, EX_CONFIG, loadConfig, resolveConfigPath } from './config.js';
import { createLogger } from './log.js';
import { PidFiles, pidDirFor } from './process.js';
import { redact } from './redact.js';
import { Patchbay } from './server.js';
import { VERSION } from './version.js';

const USAGE = `mcp-patchbay ${VERSION}: host MCP servers and switch them on and off mid-session

Usage:
  mcp-patchbay [--config <path>]
      Serve MCP over stdio. Config: --config, else $MCP_PATCHBAY_CONFIG,
      else ~/.config/mcp-patchbay/servers.json
  mcp-patchbay import --from <claude.json> [--project <dir>] [--out <servers.json>]
      Write a patchbay config from a Claude Code config.
  mcp-patchbay doctor [--config <path>] [--project <dir>] [--all] [--no-start]
      Validate the config, warn about Claude Code allow rules that would approve
      enable_confirm (user settings, plus <dir>/.claude with --project), and briefly
      start each allow server (--all: confirm ones too; --no-start: none).
  mcp-patchbay rename-permissions <settings.json> [--write] [--config <path>]
      Add mcp__patchbay__... twins of mcp__... permission rules (dry run unless --write).
  mcp-patchbay --help | --version
`;

/**
 * Minimal argv parser: --flag value, --switch, positionals.
 * @param {string[]} argv
 * @param {string[]} switches flags without a value
 */
export function parseArgs(argv, switches = []) {
  /** @type {Record<string, string | boolean>} */
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else if (switches.includes(a.slice(2))) {
        flags[a.slice(2)] = true;
      } else {
        const v = argv[i + 1];
        if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
        flags[a.slice(2)] = v;
        i++;
      }
    } else {
      positionals.push(a);
    }
  }
  return { flags, positionals };
}

/** @param {string[]} argv */
async function serve(argv) {
  const log = createLogger();
  let flags;
  try {
    ({ flags } = parseArgs(argv));
  } catch (e) {
    process.stderr.write(`mcp-patchbay: ${/** @type {Error} */ (e).message}\n\n${USAGE}`);
    process.exit(64);
  }
  const unknown = Object.keys(flags).filter((k) => k !== 'config');
  if (unknown.length) {
    process.stderr.write(`mcp-patchbay: unknown option --${unknown[0]}\n\n${USAGE}`);
    process.exit(64);
  }
  const configPath = resolveConfigPath({ flag: /** @type {string | undefined} */ (flags.config) });
  let config;
  try {
    config = loadConfig(configPath);
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`mcp-patchbay: ${e.message}\n`);
      process.exit(EX_CONFIG);
    }
    throw e;
  }

  // From here on the patchbay must never die from a child's misbehaviour.
  process.on('uncaughtException', (err) => log.error(`uncaught exception: ${err?.stack ?? err}`));
  process.on('unhandledRejection', (reason) => log.error(`unhandled rejection: ${/** @type {any} */ (reason)?.stack ?? reason}`));

  const pidFiles = new PidFiles(pidDirFor(process.env), log);
  try {
    pidFiles.reap();
  } catch (e) {
    log.warn(`reaping leftovers failed: ${/** @type {Error} */ (e).message}`);
  }

  const patchbay = new Patchbay(config, { log, pidFiles });
  let down = false;
  const shutdown = (why) => {
    if (down) return;
    down = true;
    patchbay.shutdownSync();
    log.debug(`shut down (${why})`);
    process.exit(0);
  };
  const signals = process.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGBREAK'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const sig of signals) process.on(sig, () => shutdown(sig));
  process.stdin.on('end', () => shutdown('stdin end'));
  process.stdin.on('close', () => shutdown('stdin closed'));
  process.stdout.on('error', (e) => {
    if (/** @type {any} */ (e).code === 'EPIPE') shutdown('stdout closed');
  });

  const transport = new StdioServerTransport();
  await patchbay.connect(transport);
  log.info(`serving ${config.order.length} server(s) from ${configPath}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    process.stdout.write(USAGE);
    return;
  }
  if (cmd === '--version' || cmd === '-v') {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (cmd === 'import') {
    const { runImport } = await import('./import.js');
    process.exitCode = await runImport(argv.slice(1));
    return;
  }
  if (cmd === 'doctor') {
    const { runDoctor } = await import('./doctor.js');
    process.exitCode = await runDoctor(argv.slice(1));
    return;
  }
  if (cmd === 'rename-permissions') {
    const { runRenamePermissions } = await import('./rename-permissions.js');
    process.exitCode = await runRenamePermissions(argv.slice(1));
    return;
  }
  if (cmd && !cmd.startsWith('--')) {
    process.stderr.write(`mcp-patchbay: unknown command "${cmd}"\n\n${USAGE}`);
    process.exitCode = 64;
    return;
  }
  await serve(argv);
}

main().catch((e) => {
  process.stderr.write(`mcp-patchbay: ${redact(/** @type {Error} */ (e)?.stack ?? e)}\n`);
  process.exit(1);
});
