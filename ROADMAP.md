# Roadmap

The near-term plan for mcp-patchbay, and what it will not do. The repository has no open issues
today, so the plan is taken from what its own documents say is not finished yet: the
[CHANGELOG.md](CHANGELOG.md) "Unreleased" section, the README's "Known limits" and the plugin's
README. It has no dates: an item is done when the change that does it is merged and released,
and it then leaves this list for the CHANGELOG. Anything here can change; open an
[issue](https://github.com/distronode-corporation/mcp-patchbay/issues) to discuss an item or to
propose a new one.

## Near term

- **The next release.** What is merged under "Unreleased" in the CHANGELOG, the Claude Code
  plugin and `glama.json` among it, goes out in the next version. It is also the first release
  whose Claude Desktop bundle (`.mcpb`) carries a build provenance attestation, so the bundle can
  be checked with `gh attestation verify` as the README's "Verify a release" describes; the
  bundle attached to 0.1.1 has none. The plugin's pin then moves to that version.
- **The plugin's tool names.** Installed as the Claude Code plugin, the patchbay's tools are
  named `mcp__plugin_patchbay_patchbay__<tool>`, but `rename-permissions`, `doctor` and the
  128-character check assume the shorter `mcp__patchbay__` prefix of a server added by hand
  (`plugins/claude-code/README.md`, "Tool names and permissions"). Until they handle both, the
  plugin's README says to register the server by hand if you rely on them.
- **Coverage.** CI fails below the coverage floors in `package.json`'s `test:coverage` script
  (lines 94%, branches 82%, functions 86% of `src/`). The aim is 100% on every metric, as mcp-frontdesk already enforces,
  with the floor raised in the same pull request that reaches it.
- **Windows.** CI runs the suite on Windows, but the author has not used the patchbay there,
  and the README's "Known limits" lists what differs (no config permission checks, no process
  groups, `.cmd` shims, the skipped signal tests).

## Not planned

These are decisions, recorded in [DECISIONS.md](DECISIONS.md), "Things deliberately not done":

- No generic call or exec tool. The agent enables configured servers by name and calls their
  own tools.
- No forwarding of resources, prompts, completions or logging. The patchbay proxies tools.
- No automatic restarts of a server that exits, and no hot reload of the config: a config
  change needs a restart of the patchbay.
- No `${VAR}` expansion in `command`, `args` or `env`.

A change to any of these would be proposed as an issue first. The first two would also change
the safety model in [SECURITY-MODEL.md](SECURITY-MODEL.md).
