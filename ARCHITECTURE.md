# Architecture

How mcp-patchbay is put together: the parts, how a request moves through them, and where state
lives. The exact protocol and lifecycle contract is [SPEC.md](SPEC.md), the reasons for the
choices are in [DECISIONS.md](DECISIONS.md), and what it trusts is in
[SECURITY-MODEL.md](SECURITY-MODEL.md).

## The shape

mcp-patchbay is one Node.js process with two faces. To the MCP client (Claude Code, Claude
Desktop) it is an MCP server over stdio. To each hosted server it is an MCP client, one per child,
over that child's stdio. A remote (`url`) server is a child too: the patchbay runs mcp-remote for
it, and mcp-remote speaks to the remote endpoint.

```
                        trusted                          not trusted
  servers.json --------------+
  (read once at startup)     |
                             v
  MCP client <== stdio ==> mcp-patchbay <== stdio ==> child MCP server (a local command)
  (and the person,           |   server.js           \== stdio ==> mcp-remote ==> remote endpoint
   through elicitation)      |   children.js
                             v
                    stderr (redacted logs), pidfiles, oauth.configDir (mcp-remote's tokens)
```

## Parts

| Module | Role |
|---|---|
| `cli.js` | The command line: with no subcommand it loads the config and serves MCP over stdio; otherwise `doctor`, `import` or `rename-permissions`. |
| `config.js` | Finds the config, checks its file permissions (POSIX), reads it once through one descriptor, and validates it against a strict schema. |
| `server.js` | The patchbay itself: its own tools (`servers`, `enable`, `disable`, `restart`, `info`, and `enable_confirm` with `confirmVia: "host"`), each server's state, the `confirm` check, and the proxying of hosted tools under their exposed names. |
| `children.js` | Spawning a child (stdio, or mcp-remote for a `url` entry), its transport and SDK `Client`, its stderr ring buffer, and the sign-in line detector for mcp-remote. |
| `naming.js` | The public naming contract: how a child's tool name becomes `<server>__<tool>`. |
| `process.js` | Process groups, tree kills, pidfiles, and reaping leftovers of a patchbay that crashed. |
| `redact.js`, `log.js` | Redaction of everything the patchbay itself emits, and stderr-only logging through it. |
| `instructions.js` | The patchbay's own `instructions` in the initialize result. |
| `doctor.js`, `permissions.js` | `doctor`: validates the config, warns about permission rules that would approve `enable_confirm` without a person, and briefly starts servers. |
| `import.js`, `rename-permissions.js`, `fsutil.js` | Moving from Claude Code: writing `servers.json` from its config, and adding `mcp__patchbay__` twins of its permission rules, with backups. |

## A request, start to finish

1. **Startup.** `cli.js` loads and validates the config, reaps leftovers from an earlier run that
   crashed, and serves the patchbay's own tools. When the client sends `initialize`, the
   `autostart` servers are started before the answer.
2. **Enable.** The agent calls `enable` with a configured name. A `deny` server is refused. A
   `confirm` server needs a person: the patchbay sends an elicitation and proceeds only on an
   explicit accept (or, with `confirmVia: "host"`, only `enable_confirm` starts one, after the
   host's permission prompt). `children.js` spawns the child in its own process group, writes its
   pidfile, and runs `initialize` and `tools/list`.
3. **Tools appear.** The child's tools are exposed as `<server>__<tool>`, and the patchbay sends
   `notifications/tools/list_changed`.
4. **Calls.** A `tools/call` for an exposed name is forwarded to that child, with cancellation and
   progress; the result is parsed with the SDK's schema and passed back. Elicitations from a
   child are forwarded to the person, prefixed `[<server>]`; sampling requests are refused.
5. **Disable, crash or exit.** `disable` closes the child and kills its process group; a crash
   marks only that server `failed`. When the patchbay itself exits, every child's group is sent
   SIGTERM at once and SIGKILL shortly after.

## Where state lives

- **In memory**: each server's state (`off`, `starting`, `waiting-for-sign-in`, `on`, `failed`),
  its tool list, its last error and its redacted stderr tail. Nothing of this survives a restart,
  and the config is never written by the server.
- **On disk**: the config file (yours); pidfiles in `${XDG_RUNTIME_DIR or tmp}/mcp-patchbay-<uid>/`
  (a hash of each child's command line, never the line itself); mcp-remote's OAuth tokens under
  `oauth.configDir`; and the backups that `import` and `rename-permissions --write` make.

## Trust boundaries

The config file and the person are trusted; the agent, the children and everything they return
are not. The full table, and what `confirm` does and does not guarantee, is in
[SECURITY-MODEL.md](SECURITY-MODEL.md#trust-boundaries).
