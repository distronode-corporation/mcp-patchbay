# Privacy policy

This policy covers mcp-patchbay, the npm package `mcp-patchbay` and the Claude Desktop
extension bundle (`.mcpb`) built from this repository, published by Distronode Corporation.

## Data collection

mcp-patchbay collects nothing about you. It has no telemetry, no analytics, no crash reporting
and no update check, and it never contacts Distronode or any service of its own.

## Usage and storage

mcp-patchbay runs on your computer and stores only these files, all under your control:

- your config, `~/.config/mcp-patchbay/servers.json` (or the path you choose), which you write;
- sign-in tokens for remote servers you configure, kept by mcp-remote under
  `~/.config/mcp-patchbay/oauth` (mode 700);
- small pidfiles in your runtime directory, so leftovers can be cleaned up after a crash.

It passes tool calls and results between your MCP client (such as Claude Code or Claude Desktop)
and the servers you configured. It keeps no copy of them. Its own logs go to stderr, where your
client keeps them, and are redacted for tokens, query strings and each server's env, args and
headers.

## Third-party sharing

mcp-patchbay shares nothing with Distronode or anyone else. The servers you add to the config
are separate programs: when you switch one on, it may send data to its own service under that
service's privacy policy. mcp-patchbay does not add any service to your config by itself; the
config it creates on first run has no servers.

## Data retention

Nothing is retained by Distronode, because nothing is sent to it. The files above stay on your
computer until you delete them; [Uninstall and rollback](README.md#uninstall-and-rollback) lists
them.

## Contact

Questions about this policy: open an issue at
<https://github.com/distronode-corporation/mcp-patchbay/issues>, or email
**opensource@distronode.com**. Security reports: see [SECURITY.md](SECURITY.md).
