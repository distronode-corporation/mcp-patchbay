#!/usr/bin/env node
// Builds the Claude Desktop extension bundle, dist/mcp-patchbay-<version>.mcpb.
//
// It stages the package as npm would publish it (package.json's `files`), plus the bundle's
// manifest.json and icon.png, installs the runtime dependencies from package-lock.json with no
// lifecycle scripts, and runs the pinned MCPB CLI: `mcpb validate`, then `mcpb pack`.
//
// Usage: node bundle/build.mjs [--out <dir>]   (default: dist/). POSIX only (CI builds on
// Linux); the bundle it makes runs on macOS, Windows and Linux.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The MCPB CLI, pinned. A bump is a reviewed change to this line. */
export const MCPB_CLI = '@anthropic-ai/mcpb@2.1.2';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Runs a command, inheriting stdio, and throws when it fails. */
function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false' },
  });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.error?.message ?? `exit ${r.status}`})`);
}

/** `npx` with the pinned CLI. */
export function mcpb(args, cwd = ROOT) {
  run('npx', ['--yes', `--package=${MCPB_CLI}`, '--', 'mcpb', ...args], cwd);
}

function main() {
  const i = process.argv.indexOf('--out');
  const out = path.resolve(i === -1 ? path.join(ROOT, 'dist') : process.argv[i + 1]);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'bundle', 'manifest.json'), 'utf8'));
  if (manifest.version !== pkg.version) {
    throw new Error(`bundle/manifest.json's version is ${manifest.version}, package.json's is ${pkg.version}`);
  }

  const stage = path.join(out, 'stage');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  for (const entry of [...pkg.files, 'package.json', 'package-lock.json']) {
    fs.cpSync(path.join(ROOT, entry), path.join(stage, entry), { recursive: true });
  }
  fs.copyFileSync(path.join(ROOT, 'bundle', 'manifest.json'), path.join(stage, 'manifest.json'));
  fs.copyFileSync(path.join(ROOT, 'bundle', 'icon.png'), path.join(stage, 'icon.png'));
  run('npm', ['ci', '--omit=dev'], stage);

  mcpb(['validate', path.join(stage, 'manifest.json')]);
  const file = path.join(out, `mcp-patchbay-${pkg.version}.mcpb`);
  fs.rmSync(file, { force: true });
  mcpb(['pack', stage, file]);
  if (!fs.existsSync(file)) throw new Error(`mcpb pack did not write ${file}`);
  process.stdout.write(`built ${path.relative(ROOT, file)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    process.stderr.write(`bundle: ${/** @type {Error} */ (e).message}\n`);
    process.exit(1);
  }
}
