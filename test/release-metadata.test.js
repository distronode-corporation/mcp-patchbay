// The release metadata agrees with package.json: the MCP Registry's server.json, the Claude
// Desktop bundle's manifest, the CHANGELOG and the README's pinned commands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MCPB_CLI } from '../bundle/build.mjs';
import { ROOT } from './helpers.js';

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const json = (f) => JSON.parse(read(f));
const pkg = json('package.json');
const server = json('server.json');
const manifest = json('bundle/manifest.json');

test('server.json names the same server, version and npm package as package.json', () => {
  assert.equal(pkg.mcpName, server.name, 'package.json mcpName is how the registry verifies the npm package');
  assert.match(server.name, /^io\.github\.distronode-corporation\/[a-zA-Z0-9._-]+$/);
  assert.equal(server.version, pkg.version);
  assert.match(server.$schema, /^https:\/\/static\.modelcontextprotocol\.io\/schemas\/\d{4}-\d{2}-\d{2}\/server\.schema\.json$/);
  assert.ok(server.description.length >= 1 && server.description.length <= 100, 'the registry caps description at 100 characters');
  const npm = server.packages.filter((p) => p.registryType === 'npm');
  assert.equal(npm.length, 1);
  assert.equal(npm[0].identifier, pkg.name);
  assert.equal(npm[0].version, pkg.version);
  assert.equal(npm[0].registryBaseUrl, 'https://registry.npmjs.org');
  assert.deepEqual(npm[0].transport, { type: 'stdio' });
  assert.equal(server.repository.url, 'https://github.com/distronode-corporation/mcp-patchbay');
});

test('the bundle manifest has the package version and the fields the directory checks', () => {
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.name, pkg.name);
  assert.equal(manifest.license, pkg.license);
  assert.equal(manifest.server.type, 'node');
  assert.equal(manifest.server.entry_point, pkg.bin['mcp-patchbay']);
  assert.ok(manifest.server.mcp_config.args.includes(`\${__dirname}/${pkg.bin['mcp-patchbay']}`));
  assert.deepEqual([...manifest.compatibility.platforms].sort(), ['darwin', 'linux', 'win32']);
  assert.equal(manifest.compatibility.runtimes.node, pkg.engines.node.replace(/^>=(\d+)$/, '>=$1.0.0'));
  assert.ok(manifest.privacy_policies.length > 0);
  for (const url of manifest.privacy_policies) assert.match(url, /^https:\/\//);
  assert.ok(fs.existsSync(path.join(ROOT, 'PRIVACY.md')));
  assert.match(read('README.md'), /^## Privacy Policy$/m);
  // The config path default is the patchbay's own default, so the first run can create it.
  assert.equal(manifest.user_config.config_path.default, '${HOME}/.config/mcp-patchbay/servers.json');
});

test('the bundle icon is a 512x512 PNG', () => {
  const b = fs.readFileSync(path.join(ROOT, 'bundle', manifest.icon));
  assert.equal(b.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(b.subarray(12, 16).toString('ascii'), 'IHDR');
  assert.deepEqual([b.readUInt32BE(16), b.readUInt32BE(20)], [512, 512]);
});

test('the MCPB CLI is pinned to an exact version', () => {
  assert.match(MCPB_CLI, /^@anthropic-ai\/mcpb@\d+\.\d+\.\d+$/);
});

test('the CHANGELOG has a section for this version', () => {
  assert.match(read('CHANGELOG.md'), new RegExp(`^## ${pkg.version.replaceAll('.', '\\.')} - \\d{4}-\\d{2}-\\d{2}$`, 'm'));
});

test("the README's pinned commands use this version", () => {
  const pins = [...read('README.md').matchAll(/mcp-patchbay@(\d+\.\d+\.\d+[^\s`]*)/g)].map((m) => m[1]);
  assert.ok(pins.length >= 2);
  for (const v of pins) assert.equal(v, pkg.version);
});
