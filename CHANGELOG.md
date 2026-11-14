# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## 0.1.0 - 2026-11-14

### Added

- An MCP server over stdio that hosts configured MCP servers as child processes, with the tools
  `servers`, `enable`, `disable`, `restart` and `info`. Each carries
  `_meta: {"anthropic/alwaysLoad": true}`.
- Policies `allow`, `confirm` and `deny`. `confirm` asks a person through a form-mode
  elicitation, and fails closed when the client has no elicitation support.
- Live tool publishing with `notifications/tools/list_changed`. `enable` waits up to 2 s for the
  client's re-list.
- Proxying:
  - pass-through tool definitions and results, with `outputSchema` not enforced;
  - cancellation and progress (original progress tokens);
  - `roots/list` and elicitation forwarding, and roots `list_changed` fan-out;
  - sampling refused;
  - merging of children's own `list_changed`;
  - a per-server `timeoutMs`.
- Children:
  - full env inheritance with per-entry `env`;
  - a process group per child on POSIX;
  - tolerance of non-JSON stdout;
  - redacted stderr ring buffers;
  - crash isolation;
  - pidfiles, and reaping of leftovers after a crash.
- Remote servers through mcp-remote 0.15.2:
  - header values kept out of argv;
  - `MCP_REMOTE_CONFIG_DIR` at 0700;
  - sign-in detection with a URL-mode elicitation (or a form fallback);
  - the state `waiting-for-sign-in`.
- Autostart per project (`CLAUDE_PROJECT_DIR`), and instructions folded into the patchbay's own,
  capped at 4,096 characters.
- Redaction of tokens, URL query strings, and entries' own env, args and headers in everything
  the patchbay emits.
- CLI: `import` (from a Claude Code config), `doctor`, and `rename-permissions`.
- The `examples/write-gate` PreToolUse hook example, with tests.
- `confirmVia`, a top-level config setting: `"elicitation"` (the default, unchanged behaviour) or
  `"host"`. With `"host"`, `enable` and `restart` refuse to start a `confirm` server and point to
  a new tool, `enable_confirm {name}`. The host's own permission prompt for that tool is the
  person's approval. This makes `confirm` servers usable in clients that do not show form
  elicitation to the person, such as the Claude Code VS Code extension, which answers it
  `decline`. `enable_confirm` refuses `allow` and `deny` servers and is listed only in host mode.
- `import` writes `confirmVia: "host"`.
- `doctor` prints `confirmVia` and warns about Claude Code allow rules that would approve
  `enable_confirm` without asking (the exact name, `mcp__patchbay__*`, `mcp__patchbay`, `*` and
  other wildcards) and about `defaultMode: "bypassPermissions"`, in the user's settings and, with
  `--project <dir>`, the project's. In host mode a warning exits 1. `--no-start` skips starting
  servers.
- `rename-permissions` never writes a rule that matches `enable_confirm`.

### Fixed

- Shutdown no longer orphans children that ignore SIGTERM. A detached helper sends SIGKILL to the
  remaining process groups after 500 ms, without delaying the patchbay's exit. Pidfiles are kept
  until a child's exit is observed, and the startup reaper now escalates to SIGKILL. After a
  crash, the leftover group members also get a SIGKILL follow-up.
- A remote server's `url` is now treated as a secret. The whole url, each path segment, each
  query value and any userinfo (6+ characters) are redacted from `info`, `lastError` and logs.
  mcp-remote logs the url to stderr, and many endpoints carry their key in the path. The url
  is still on mcp-remote's argv (mcp-remote has no other way to take it), which is now
  documented.
- Only mcp-remote children (`url` entries, an `mcp-remote` command, or `npx mcp-remote`) can
  trigger the sign-in prompt, and only while they are starting. The prompt is always labelled
  `[<server>] `. A re-auth request while a server is on is logged instead of prompting. The
  sign-in URL is no longer written to the log, not even in redacted form.
- `rename-permissions` without `--config` now loads the default config (`$MCP_PATCHBAY_CONFIG`
  or `~/.config/mcp-patchbay/servers.json`) and applies server prefixes. Before, deny rules for
  prefixed servers silently stopped matching. Without a config file, it warns that names were
  mapped as they are.
- A `restart` racing a `disable` no longer turns a `confirm` server back on: the disable cancels
  the restart. An `enable` in that window joins the restart instead of showing a prompt whose
  answer was ignored. A crash marks the server `failed` at once (it used to wait 20 ms), so a
  restart right after a crash asks a person again.
- Autostart names that are inherited object keys (`constructor`, `toString`, `__proto__`) are
  now rejected as unknown servers at load time (exit 78); before, they crashed `initialize`.
  The same `hasOwn` check now covers `import --project` and `rename-permissions`' prefix lookup.
  An env key named `__proto__` is now kept as a key instead of being dropped.
- A JSON syntax error in the config, in `import --from <claude.json>`, or in the
  `rename-permissions` settings file is reported as the file path plus line and column. Node's
  parser message quoted the surrounding text, which could include a token.
- Kills can no longer hit an unrelated process through a reused pid. Post-exit cleanup and the
  startup reaper never fall back to signalling a bare pid. Pidfiles now record the process start
  time (Linux, `v: 2`), and the reaper requires it to match and requires the pid to still lead
  its own process group. A pidfile without a start time is not trusted on Linux.
- The config permission check is now complete (POSIX). The file is opened once, `fstat`ed and
  read through that descriptor (no check-then-read race). A group- or world-writable (or
  foreign-owned) parent directory is refused. A symlinked config is accepted only if its target
  and the target's directory pass the same checks. A FIFO is refused without blocking.

### Documentation

- SECURITY-MODEL.md, SPEC.md and README now say exactly what happens to tool results: they are
  parsed with `CallToolResultSchema`, which drops unknown keys inside content blocks and
  rejects unknown content types. The docs no longer claim "unchanged".
- The redaction guarantee now states its 6-character minimum and covers the url. The sign-in
  URL text matches the code.
- README: `npm test` takes about 20 s, not 40 s.
