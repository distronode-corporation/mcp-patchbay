# mcp-patchbay

> **If you allow `mcp__patchbay` as a whole in your client's permissions, you approve every tool of every server it hosts.**
> Allow individual tools (`mcp__patchbay__<server>__<tool>`) instead. See [Policy and safety model](#policy-and-safety-model).

`mcp-patchbay` is an MCP server that hosts other MCP servers as child processes, and lets the AI
agent switch them on and off in the middle of a session.

- The agent sees five small tools: `servers`, `enable`, `disable`, `restart` and `info`.
- When the agent enables a server, the patchbay starts it, and its tools appear straight away as
  `<server>__<tool>`. The patchbay sends `notifications/tools/list_changed`, so the client
  refreshes its tool list.
- When a server is disabled, its tools disappear the same way.
- For servers you mark `confirm`, **a person**, not the agent, approves each enable, through an
  MCP elicitation prompt in the client.

**Why.** Every connected MCP server costs context (its tool definitions) and a running process,
whether or not the session needs it. With the patchbay, you configure all your servers once, and
only the ones a task needs are running and visible.

**Requirements**

- Node.js 22 or later.
- An MCP client that honours `notifications/tools/list_changed` and supports elicitation (form
  mode, and ideally URL mode for sign-ins). For Claude Code, that means **2.1.287 or later**.

Without elicitation support, `confirm` servers cannot be enabled. That is deliberate: the
patchbay fails closed.

Contents: [Quick start](#quick-start) · [Config reference](#config-reference) ·
[Naming contract](#naming-contract) · [Moving from Claude Code: `import` and
`rename-permissions`](#moving-from-claude-code) · [Policy and safety model](#policy-and-safety-model) ·
[Known limits](#known-limits) · [Comparison](#comparison) · [Uninstall and rollback](#uninstall-and-rollback)

## Quick start

This example hosts the public filesystem server
([`@modelcontextprotocol/server-filesystem@2.2.0`](https://www.npmjs.com/package/@modelcontextprotocol/server-filesystem)).

1. Write a config file and make it private. The patchbay refuses to start if the file, or the
   directory it is in, is group- or world-writable.

   ```sh
   mkdir -p -m 700 ~/.config/mcp-patchbay
   cat > ~/.config/mcp-patchbay/servers.json <<'EOF'
   {
     "version": 1,
     "servers": {
       "example-files": {
         "description": "Read and write files in /path/to/project",
         "policy": "confirm",
         "command": "npx",
         "args": ["-y", "@modelcontextprotocol/server-filesystem@2.2.0", "/path/to/project"]
       }
     }
   }
   EOF
   chmod 600 ~/.config/mcp-patchbay/servers.json
   ```

2. Check it. `doctor` validates the file and briefly starts every `allow` server. Add `--all` to
   also start `confirm` servers like this one.

   ```sh
   npx -y mcp-patchbay@0.1.0 doctor --all
   ```

3. Register the patchbay with Claude Code under the name **`patchbay`**. The naming contract and
   the 128-character rule assume that name.

   ```sh
   claude mcp add --scope user patchbay -- npx -y mcp-patchbay@0.1.0
   ```

4. In a session, ask the agent to "enable example-files". Claude Code shows the prompt
   *"Allow the agent to turn on example-files (Read and write files in /path/to/project)?"*.
   Once you approve, tools such as `mcp__patchbay__example-files__read_text_file` are available.

A longer, synthetic example is in [`examples/servers.json`](examples/servers.json).

## Config reference

The config location is `--config <path>`, else `$MCP_PATCHBAY_CONFIG`, else
`~/.config/mcp-patchbay/servers.json`. The file is read **once**, at startup. To apply changes,
restart the patchbay (in Claude Code: `/mcp`, then reconnect `patchbay`).

```json
{
  "version": 1,
  "servers": {
    "example-files": {
      "description": "Files in /path/to/project",
      "policy": "allow",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem@2.2.0", "/path/to/project"],
      "env": { "EXAMPLE_LOG_LEVEL": "info" },
      "cwd": "/path/to",
      "prefix": "files",
      "timeoutMs": 0
    },
    "example-remote": {
      "description": "A remote MCP server",
      "policy": "confirm",
      "url": "https://mcp.example.com/mcp",
      "headers": { "X-Example-Tenant": "example" }
    }
  },
  "autostart": {
    "default": [],
    "projects": { "/path/to/project": ["example-files"] }
  },
  "oauth": { "configDir": "~/.config/mcp-patchbay/oauth", "authTimeoutSeconds": 300 }
}
```

Validation is strict: an unknown key anywhere is an error that names its path. Any config error
exits with code **78** and a message on stderr.

| Key | Meaning |
|---|---|
| `version` | Must be `1`. |
| `servers.<name>` | The name uses 1–64 characters from `[A-Za-z0-9_-]`, with no `__` and no trailing `_`. |
| `description` | One line, at most 300 characters. The agent sees it in `servers` and in the patchbay's instructions. |
| `policy` | `allow` (the agent may enable it), `confirm` (a person must approve each enable; the default), or `deny` (it can never be enabled). |
| `command`, `args`, `env`, `cwd` | A stdio server. `cwd` must be absolute. The child gets `{...the patchbay's env, ...env}`, the same as Claude Code gives its own servers. |
| `url`, `headers` | A remote server, launched through the bundled [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) 0.15.2. The URL must be `https`, except for `localhost` and `127.0.0.1`. Header names use `[A-Za-z0-9_-]`. `env` is also allowed and is passed to mcp-remote. |
| `prefix` | A short alias used instead of the name in tool names. Names and prefixes must be unique, ignoring case. |
| `timeoutMs` | The cap on one tool call, in milliseconds. `0` (the default) means no cap. |
| `autostart.default` | Servers started at launch, with no confirmation. Not allowed for `deny` servers. |
| `autostart.projects` | Per-project lists, keyed by absolute directory. The key is matched against `CLAUDE_PROJECT_DIR`, or else the current directory. A matching list replaces `default`. |
| `oauth.configDir` | Where mcp-remote keeps OAuth state for `url` servers. It is created with mode 0700. |
| `oauth.authTimeoutSeconds` | How long a sign-in may take (1–86400, default 300). |

Each server has exactly one of `command` or `url`.

Autostart is your own config choice, so it counts as consent. The instructions of autostarted
servers are folded into the patchbay's own `instructions`, within 4,096 characters in total and
shared fairly between servers.

**Headers and secrets.** Header values are not put on mcp-remote's command line, where other
local users could read them. Instead the patchbay passes `--header Name:${MCP_PATCHBAY_HEADER_n}`
and puts the value in mcp-remote's environment, which expands it. A value that already contains
a `${VAR}` placeholder is passed as it is, and mcp-remote expands it from its own environment
(that is, the patchbay's env plus the entry's `env`).

**Other environment variables.**

- `MCP_PATCHBAY_DEBUG=1` copies every child's stderr (redacted) into the patchbay's own stderr log.
- `MCP_PATCHBAY_MCP_REMOTE_BIN` replaces the mcp-remote script. This is for tests, and you should
  not normally set it.

## The agent's tools

| Tool | Input | What it does |
|---|---|---|
| `servers` | — | Lists every configured server: name, description, policy, state (`off`, `starting`, `on`, `failed`, `waiting-for-sign-in`), its tool count when on, its redacted last error when failed, skipped tools, and whether it can be enabled (and if not, why). |
| `enable` | `{name}` | Starts the server, after asking a person if the policy is `confirm`. Returns its tool count, up to 10 sample tool names, and its instructions (cut to 2,000 characters). |
| `disable` | `{name}` | Stops the server and removes its tools. Refused while that server has calls in flight; the refusal says how many. |
| `restart` | `{name}` | Stops and starts the server again. There is no new confirmation if it was already on. If it was off, this is the same as `enable`. |
| `info` | `{name}` | Description, policy, state, the last stderr lines (redacted), and its full instructions when on. |

Every one of these tools carries `_meta: {"anthropic/alwaysLoad": true}`. There is no generic
"call any tool" or "exec" tool, and there never will be.

## Naming contract

This mapping is a public contract. Permission rules and hooks can depend on it.

```
exposed name  = <prefix or server name> "__" <tool name with every char outside [A-Za-z0-9_-] replaced by "_">
client name   = "mcp__patchbay__" + exposed name      (when registered as "patchbay")
```

- A server name or prefix never contains `__` and never ends with `_`. So the **first `__`**
  after `mcp__patchbay__` always separates the server from the tool, even when the tool name
  contains `__` or begins with `_`.
  - For example, `mcp__patchbay__files___hidden` is server `files` and tool `_hidden`.
- If the client name would be longer than 128 characters, the tool is **skipped** and reported
  in `servers` and `info`. The server part is never shortened.
- If two tools of one server sanitize to the same name, the first one listed wins and the others
  are skipped and reported.
- These tools are also skipped: tools whose definition is invalid, and tools that require
  task-augmented calls.
- Everything else passes through unchanged: `title`, `description`, `inputSchema`,
  `outputSchema`, `annotations`, `_meta` and any other field.

## Moving from Claude Code

### `import`

```sh
mcp-patchbay import --from ~/.claude.json --project /path/to/project --out ~/.config/mcp-patchbay/servers.json
```

`import` only reads your Claude Code config; it never changes it.

- **Sources.** It reads the top-level `mcpServers`, plus `projects[<dir>].mcpServers` when
  `--project` is given.
- **Mapping.** `http`/`sse` entries become `url` entries, with their headers. stdio entries
  become `command` entries.
- **Policy.** Servers in that project's `disabledMcpServers` become `confirm`; everything else
  becomes `allow`.
- **Autostart.** With `--project`, `autostart.projects[<dir>]` lists the servers *not* disabled
  there. `autostart.default` is left empty.
- **Skips.** It skips, and reports, servers it cannot host: `claude.ai …` connectors,
  `plugin:…` servers, `claude-in-chrome`, `ws` transports, names that are invalid here, and the
  patchbay itself.
- **Output.** It backs up an existing output file to `<out>.bak-<timestamp>` first. It writes the
  file at mode 0600, and never prints env or header values.

Afterwards, remove the imported servers from Claude Code (`claude mcp remove <name>`), or they run
twice: once directly and once through the patchbay.

Claude Code expands `${VAR}` in its own server configs. The patchbay does not do this for
`command`, `args` or `env`; mcp-remote does it for header values. Check imported entries that
relied on expansion.

### `rename-permissions`

```sh
mcp-patchbay rename-permissions ~/.claude/settings.json            # dry run: prints a diff
mcp-patchbay rename-permissions ~/.claude/settings.json --write    # backs up, then writes
```

For each rule in `permissions.allow`, `ask` and `deny`, it **adds** a patchbay twin, and keeps
every existing rule:

- `mcp__X__tool` adds `mcp__patchbay__<seg>__tool`.
- `mcp__X` (a whole server) adds `mcp__patchbay__<seg>__*`.

`<seg>` is server `X`'s `prefix` if it has one, else `X`. The prefixes come from the patchbay
config: `--config <servers.json>`, else the same file the patchbay would load
(`$MCP_PATCHBAY_CONFIG`, else `~/.config/mcp-patchbay/servers.json`). If there is no config
file, it warns that prefixes are unknown and maps names as they are.

It skips rules it cannot proxy: `mcp__claude-in-chrome__*`, `mcp__plugin_*`, `mcp__claude_ai_*`,
rules with parentheses, and existing patchbay rules.

## Policy and safety model

The full threat model is in [SECURITY-MODEL.md](SECURITY-MODEL.md). In short:

- **The config is trusted. The agent is not.** The agent can only pick a configured name. It
  cannot add servers or change commands, and it cannot run anything that is not in the file.
  This is why the patchbay refuses a config that others can write to.
- **`confirm` means a person said yes**, in the client's own elicitation UI, for this session's
  enable. Only an accept with `allow: true` counts. A client without elicitation support cannot
  enable `confirm` servers at all.
- **`confirm` does not vet individual calls.** After a server is on, its tools are governed by
  your client's permission rules, exactly like directly connected servers. **Do not allow
  `mcp__patchbay` as a whole**: that approves every tool of every hosted server, including
  servers you have not yet thought about.
- **Children are isolated from each other.** One server's `env` never reaches another child. A
  crashing child marks only itself `failed`. Children are never restarted automatically.
- **Redaction.** Errors, logs and the `servers`/`info` output are redacted: URL query strings,
  bearer tokens, `sk-…`, `ghp_…`, JWT-shaped strings, long hex and base64 runs, and the entry's own
  env, args and header values all become `[redacted]`. Tool results pass through unchanged.
- **Elicitations from hosted servers** are forwarded to you, prefixed with `[<server>]`.
  Sampling requests from hosted servers are refused.
- **Process hygiene.** On POSIX each child leads its own process group. Every group gets SIGTERM
  when the patchbay gets SIGINT or SIGTERM or its stdin closes, within milliseconds. Pidfiles let
  the next start clean up after a crash.

## Known limits

- **Tools only.** v1 proxies tools. Resources, prompts, completions, logging and tasks of hosted
  servers are not available through the patchbay.
- **The patchbay must be registered as `patchbay`.** The 128-character rule and
  `rename-permissions` assume the client name prefix `mcp__patchbay__`.
- **OAuth goes through mcp-remote.**
  - Remote servers sign in through mcp-remote's flow. The patchbay shows you the sign-in link
    as a URL elicitation, or as a form with the link if the client lacks URL mode. mcp-remote
    also tries to open a browser.
  - Tokens are stored by mcp-remote under `oauth.configDir`. They are **not** the tokens Claude
    Code holds for its own direct connections, so you sign in once more per server.
  - Claude Code's `/mcp` → "Authenticate" / re-auth **does not cover** servers behind the
    patchbay. Claude Code only sees the patchbay, which is a local stdio server. To re-authenticate
    a hosted server, `restart` it. To sign out, `disable` it and remove its files from
    `oauth.configDir/mcp-remote-v1/`.
  - Sign-in detection depends on the exact stderr text of mcp-remote 0.15.2.
- **Windows** is untested by the author. The CI matrix covers it, and these limits are known:
  - Config permission checks are skipped.
  - Children are not detached. Trees are killed with `taskkill /T /F /PID`, which runs as a
    separate process, so a child may outlive the patchbay by a moment.
  - `.cmd` shims such as `npx` cannot be spawned directly. Use
    `"command": "cmd", "args": ["/c", "npx", ...]`.
  - Command-line checks for reaping use PowerShell (`Get-CimInstance`).
  - The signal tests are skipped.
- **Config changes need a restart** of the patchbay.

## Comparison

| | mcp-patchbay | Docker Dynamic MCP | Magg | Claude Code subagent `mcpServers` |
|---|---|---|---|---|
| Runtime | Node.js, child processes | Docker MCP Gateway; needs Docker Desktop | Python | Built into Claude Code |
| License | Apache-2.0 | — | AGPL-3.0 | — |
| Who decides what runs | Your config. The agent enables configured names, and a person confirms `confirm` ones | The agent can find and add catalogue servers at run time | The agent can manage the server list through Magg's tools | Fixed per subagent definition |
| Generic call/exec tool | None, by design | Yes (`mcp-exec`) | — | None |
| Tools appear | In the main session, via `tools/list_changed` | In the session, via the gateway | In the session, via the aggregator | Only inside that subagent |

Docker's approach suits container-isolated catalogue servers. Subagent-scoped `mcpServers` need no
extra process, when a fixed set per subagent is enough.

## Uninstall and rollback

1. `claude mcp remove patchbay` (add `--scope user` if you added it that way).
2. Re-add any servers you had moved, from your backup or with `claude mcp add …`. `import` never
   changed `~/.claude.json`.
3. Restore permission rules from the backup that `rename-permissions --write` made
   (`settings.json.bak-<timestamp>`). Or keep them: the extra `mcp__patchbay__…` rules are
   harmless without the patchbay.
4. Remove the patchbay's files:
   `rm -rf ~/.config/mcp-patchbay` (this includes `oauth/` with mcp-remote tokens) and
   `${XDG_RUNTIME_DIR:-/tmp}/mcp-patchbay-$(id -u)` (pidfiles).
5. If you installed it globally: `npm uninstall -g mcp-patchbay`.

## Development

```sh
npm ci
npm test                                    # node:test, about 40 s
python3 -m unittest discover -s examples/write-gate -v
```

See [CONTRIBUTING.md](CONTRIBUTING.md), [SPEC.md](SPEC.md) (the protocol and lifecycle contract)
and [DECISIONS.md](DECISIONS.md).

Issues and source: <https://github.com/distronode-corporation/mcp-patchbay>.
Security reports: see [SECURITY.md](SECURITY.md).

Licensed under the Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
