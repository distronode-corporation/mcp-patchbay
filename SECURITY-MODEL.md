# Security model

`mcp-patchbay` brokers process execution on behalf of an AI agent. This document says what it
protects, what it trusts, and where its guarantees stop. For the protocol details, see
[SPEC.md](SPEC.md).

## Assets

- **Your machine.** Every hosted server runs as you, with your environment.
- **Credentials.** These live in server `env`, in `headers`, in mcp-remote's OAuth tokens under
  `oauth.configDir`, and in whatever the servers themselves can reach.
- **Your consent.** The meaning of "a person approved this".

## Trust boundaries

| Party | Trusted? | Why |
|---|---|---|
| The config file | **Yes** | It is your decision about what may run. Because of that, the patchbay refuses (exit 78) a file that is group- or world-writable, or owned by someone other than you or root (POSIX). |
| The person at the client | Yes | They answer elicitations. |
| The MCP client (for example Claude Code) | Yes, for transport and UI | The patchbay relies on it to show elicitations faithfully and to enforce per-tool permission rules. |
| The agent (the model) | **No** | It may be wrong, or steered by prompt injection from any content it reads. |
| Hosted servers (children) | **No** | They are third-party code. Their output, tool descriptions, instructions and requests may be hostile. |
| Remote MCP endpoints | No | They are reached through mcp-remote. |

## What the agent can and cannot do

The agent can:

- list the configured servers;
- enable an `allow` server;
- *ask* to enable a `confirm` server;
- disable, restart or inspect a configured server;
- call the tools of servers that are on, subject to the client's own permission rules.

The agent cannot:

- add a server, or change a command, its arguments, env, URL or headers. The config is read once
  at startup, and no tool writes it.
- run an arbitrary command. There is no generic `call` or `exec` tool. A hosted server's tools
  are reachable only under their own names.
- enable a `deny` server, through any path (`enable`, `restart` or autostart). `deny` servers in
  `autostart` are rejected at load time.
- enable a `confirm` server without a person.

## What `confirm` guarantees

- **A person answers.** Before spawning a `confirm` server, the patchbay sends an
  `elicitation/create` request in form mode to the client, with the message
  `Allow the agent to turn on <name> (<description>)?` and one boolean field. The text comes from
  your config, never from the agent.
- **It fails closed.** Only `action: "accept"` with `allow: true` proceeds. Decline, cancel, a
  malformed answer, a timeout, a transport error, or a client that did not declare elicitation
  support all mean "no".
- **It covers every path to a spawn.** `restart` of a server that is off goes through the same
  check. Concurrent enables share one pending question rather than racing past it.
- **Autostart is the documented exception.** Listing a server in `autostart` is your own consent,
  given in the trusted config.

## What `confirm` does not guarantee

- **It does not vet calls.** Once a server is on, each of its tools is governed only by the
  client's permission rules. If you allow `mcp__patchbay` as a whole, you approve every tool of
  every server the patchbay hosts, including ones you have not yet looked at. Allow individual
  `mcp__patchbay__<server>__<tool>` rules instead (`rename-permissions` helps).
- **It cannot stop the agent from asking.** A prompt-injected agent may ask you repeatedly to
  enable a server. The prompt always names the real server and your own description.
- **It lasts for the session.** Approval covers that server until it is disabled, crashes, or the
  patchbay exits. A later `restart` of a server that is on does not ask again.
- **It trusts the client's UI.** The guarantee is only as strong as the client's elicitation UI
  and the person's attention.

## Prompt injection

Tool results, tool descriptions and server instructions from children pass through **unchanged**
to the agent. The patchbay does not, and cannot, sanitise them semantically. Treat a hosted server
exactly as you would treat it if it were connected directly.

Two specific mitigations:

- **Elicitations from children are attributed.** They are forwarded to you with the message
  prefixed `[<server>] `, so a child cannot pass its request off as the patchbay's own
  confirmation. The answer goes only to that child.
- **Sampling is refused.** `sampling/createMessage` from children is refused, so a hosted server
  cannot drive your model through the patchbay.

## Child environment

- **What a child gets.** A stdio child runs with `{...the patchbay's env, ...that entry's env}`,
  the same as Claude Code. Variables such as `PATH`, `HOME`, `DISPLAY` and
  `CLAUDE_PROJECT_DIR` therefore reach it. That means **every child sees every secret in the
  patchbay's own environment**. Keep secrets in the specific entry's `env`, not in the
  environment the patchbay is launched with.
- **Isolation between entries.** One entry's `env` is never given to another child.
- **Remote children.** mcp-remote additionally gets `MCP_REMOTE_CONFIG_DIR`, plus the header
  values as `MCP_PATCHBAY_HEADER_<n>` variables. Header values are kept **out of argv**, because
  argv is readable by other local users through `ps` or `/proc`. The environment of a process is
  readable only by the same user (and root).
- **The url is visible in the process list.** mcp-remote 0.15.2 accepts the server url only as
  a command-line argument, so the `url` of a remote entry *is* on argv. Any local user can read
  it with `ps`. If your endpoint carries its key in the url (`https://host/s/<token>/mcp` or
  `?key=…`), that key is exposed to the other users of the machine. Prefer an endpoint that
  takes the key in a header. The patchbay's own output redacts the url (see Redaction).
- **Process groups.** Children are detached into their own process group on POSIX. When the
  patchbay stops, each group is sent SIGTERM synchronously. A detached helper sends SIGKILL to
  any group still there 500 ms later. The pidfiles stay until the exit is seen, so a child that
  survives both is reaped (SIGTERM, then SIGKILL) at the next start.

## OAuth tokens

- **Where they live.** Remote servers sign in through mcp-remote 0.15.2. Its tokens are stored
  under `oauth.configDir` (default `~/.config/mcp-patchbay/oauth`), which the patchbay creates at
  mode 0700.
- **The sign-in URL.** It is sent **unredacted** to the person, in a URL-mode elicitation, or in a
  form-mode message when URL mode is unavailable, because the sign-in needs it. It never goes to
  logs, errors, or `servers` and `info` output.
- **What mcp-remote does.** mcp-remote itself tries to open a browser. It also listens on a local
  callback port during sign-in.

## Redaction

Everything the patchbay itself produces about a child is redacted before it leaves the process:
stderr ring buffers, logs, `lastError`, `servers` and `info` output, doctor output, and error
messages relayed from children.

- **Patterns.** URL query strings and userinfo, `Bearer`/`Basic` credentials, `key=value` for
  token-like keys, `sk-…`, `ghp_…` and similar prefixes, `github_pat_…`, `xox…-`, AWS key ids,
  JWT-shaped strings, hex runs of 32 or more characters, and mixed-case base64 runs of 40 or more.
- **Exact values.** The entry's own env values, args and header values (6 characters or longer)
  are replaced by `[redacted]`. So child args and env never appear in the patchbay's errors,
  logs or outputs.
- **Not redacted:** tool results, tool lists and child instructions. They are the hosted server's
  own content, and changing them would break servers. A server that prints its own secret in a
  tool result discloses it, exactly as it would when connected directly.

Redaction is pattern-based. It reduces accidental disclosure; it is not a guarantee against a
child deliberately leaking data.

## Process and file hygiene

- Logs go to stderr only. stdout carries only MCP messages.
- Pidfiles live in `${XDG_RUNTIME_DIR or tmp}/mcp-patchbay-<uid>/`, at mode 0700. The patchbay
  refuses a directory it does not own. Pidfiles hold a SHA-256 of the child's command line, not
  the command line itself.
- At startup, leftovers are killed only if their owning patchbay is gone **and** the pid still
  runs the recorded command line. This avoids killing a process that reused the pid.
- `import` writes its output at 0600, and backs up any file it replaces.
- `rename-permissions` keeps the file's mode, and backs it up before writing.
- Neither prints env or header values.

## Known gaps

- On Windows, there are no config-permission checks, children are not process-group leaders,
  and tree kills are asynchronous (`taskkill`).
- A hosted server can still do anything its own code does, with your privileges. The patchbay
  limits *which* servers run, not *what they do*.
- Configuration mistakes are yours. A `policy: allow` server that can write files can be enabled
  by the agent without asking.

## Reporting a vulnerability

Please use **GitHub private vulnerability reporting** on the repository: the **Security** tab,
then **Report a vulnerability**. Do not open a public issue for security problems.

Include the version, your OS, a minimal config (with synthetic names and values), and steps to
reproduce.
