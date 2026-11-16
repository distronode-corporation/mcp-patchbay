# mcp-patchbay for Claude Code

This plugin adds [mcp-patchbay](https://github.com/distronode-corporation/mcp-patchbay) to
Claude Code. mcp-patchbay is an MCP server that hosts your other MCP servers as child processes
and lets Claude switch them on and off in the middle of a session. Only the servers a task needs
are running and visible, so the rest cost no context and no processes. Servers you mark
`confirm` need a person, not the model, to approve each enable.

## What it runs

The plugin has one part: an MCP server named `patchbay`, started as
`npx -y mcp-patchbay@0.1.1`. On first use `npx` downloads that exact version of the
[`mcp-patchbay`](https://www.npmjs.com/package/mcp-patchbay) package and its dependencies from
the public npm registry. Nothing else is downloaded, and the plugin has no hooks, skills or
scripts of its own.

The server gives Claude five tools: `servers`, `enable`, `disable`, `restart` and `info`
(plus `enable_confirm` when the config sets `"confirmVia": "host"`). When Claude enables a
hosted server, the patchbay starts it and its tools appear; when Claude disables it, they go.

Requirements: Node.js 22 or later on the `PATH` (for `npx`), and Claude Code 2.1.287 or later.
The plugin has not been tried on native Windows. If the server does not start there, register
it by hand as the [Quick start](https://github.com/distronode-corporation/mcp-patchbay#quick-start)
shows, with `cmd /c npx -y mcp-patchbay@0.1.1` as the command.

## Install

Once the plugin is listed in Anthropic's plugin directory, install it from there. A marketplace
entry in this repository, pinned to a release tag and its commit, follows the plugin's first
release. Start a new session after installing.

## First run and configuration

On first start, when `~/.config/mcp-patchbay/servers.json` does not exist, the patchbay creates
it with no servers (`{"version": 1, "servers": {}}`) and serves its own tools. On macOS and
Linux the file is mode 600, and the directory, if the patchbay has to create it, mode 700; an
existing directory keeps its mode as long as nobody else can write it. Windows has no such
modes, so there the folder's own permissions apply. Nothing is switched on. Add your connectors to that file as the
[Quick start](https://github.com/distronode-corporation/mcp-patchbay#quick-start) shows, then
reconnect the server with `/mcp`. The patchbay refuses a config file, or a directory holding it,
that someone else can write.

## Tool names and permissions

Claude Code names a plugin's MCP tools `mcp__plugin_<plugin>_<server>__<tool>`, so this plugin's
tools are `mcp__plugin_patchbay_patchbay__<tool>`, and a hosted server's tools are
`mcp__plugin_patchbay_patchbay__<prefix or server name>__<tool>`, with the tool name
sanitized as the
[naming contract](https://github.com/distronode-corporation/mcp-patchbay#naming-contract)
describes. Two parts of mcp-patchbay 0.1.1 assume the
shorter `mcp__patchbay__` prefix of a server registered by hand with
`claude mcp add ... patchbay`:

- **Permission rules.** Write rules with the plugin prefix. Allow individual tools, never
  `mcp__plugin_patchbay_patchbay__*` or the whole server, or you approve every tool of every
  hosted server. Never allow `mcp__plugin_patchbay_patchbay__enable_confirm` (listed with
  `"confirmVia": "host"`): the permission prompt for it is the person's approval of a
  `confirm` server. The `rename-permissions` and `doctor` commands check and write
  `mcp__patchbay__` rules, so they do not cover the plugin's names, and `doctor` does not warn
  about an allow rule for the plugin's `enable_confirm`.
- **The 128-character limit.** The patchbay skips a tool whose `mcp__patchbay__...` name is
  over 128 characters. With the plugin's prefix, 16 characters longer, a tool whose
  `mcp__patchbay__` name is 113 to 128 characters long is still listed, but its full name is
  over 128.

If you rely on either, register the server by hand as the
[Quick start](https://github.com/distronode-corporation/mcp-patchbay#quick-start) shows instead
of installing the plugin.

## Privacy

mcp-patchbay collects no data and sends nothing to Distronode or anyone else: no telemetry, no
analytics, no update check. It stores only your config, sign-in tokens for remote servers you
configure, pidfiles, and the `.bak` copies that `import` and `rename-permissions --write` make,
all on your computer. The servers you configure are separate programs with their own privacy
policies. The full policy is
[PRIVACY.md](https://github.com/distronode-corporation/mcp-patchbay/blob/main/PRIVACY.md).

## Support

Issues: <https://github.com/distronode-corporation/mcp-patchbay/issues>. Security reports:
[SECURITY.md](https://github.com/distronode-corporation/mcp-patchbay/blob/main/SECURITY.md).

## License

Apache-2.0. See `LICENSE`.
